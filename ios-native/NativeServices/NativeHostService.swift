// Extracted from the existing hardened provider engine. No Tauri or reader webview dependency.
import UIKit
import WebKit
import Security

private struct RequestArgs: Decodable {
    let operation: String
    let variables: [String: AnyCodable]
    let authToken: String
    let ct0: String
    let context: RequestContext
}
private struct RequestContext: Decodable { let id: String; let generation: UInt64; let priority: Int; let deadline: UInt64; let authentication: Bool? }
private struct LoginFailureArgs: Decodable { let code: String }
// JSON values decoded without ever evaluating caller-provided JavaScript.
private struct AnyCodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else { value = try c.decode(String.self) }
    }
}
private struct ShareArgs: Decodable { let bundle: String }
private struct ProfileArgs: Decodable { let username: String }
private struct SessionArgs: Decodable { let authToken: String; let ct0: String }
private struct CancelArgs: Decodable { let beforeGeneration: UInt64? }
// WebKit completion, navigation recovery and the deadline race on the main queue.
// Exactly one result reaches Rust even if WebKit completes after the deadline.
private func rejectNative(_ invoke: NativeInvocation, _ message: String) { invoke.resolve(ConnectionFault.fromMessage(message)) }

private final class RequestReply {
    private let invoke: NativeInvocation
    private(set) var pending = true
    var expired: (() -> Void)?
    private let id: String?
    private let createdAt = Date()
    let authentication: Bool
    var elapsedMs: Double { min(75000, max(0, Date().timeIntervalSince(createdAt) * 1000)) }
    init(_ invoke: NativeInvocation, deadline: UInt64, id: String? = nil, authentication: Bool = false) {
        self.invoke = invoke; self.id = id; self.authentication = authentication
        let seconds = min(75, max(0, Double(deadline) / 1000 - Date().timeIntervalSince1970))
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard self?.pending == true else { return }
            self?.expired?()
            self?.reject("Twitter took too long to respond. Please try again.")
        }
    }
    func resolve(_ value: [String: Any]) {
        guard pending else { return }; pending = false; invoke.resolve(value)
    }
    func reject(_ message: String) {
        guard pending else { return }; pending = false; invoke.resolve(ConnectionFault.fromMessage(message, id: id))
    }
    func interruptAuthentication(_ code: String) {
        resolve(ConnectionFault.value(code, "identity", id: id, retryable: code == "background_paused"))
    }
}
private final class LoginController: UIViewController, UIAdaptivePresentationControllerDelegate {
    var cancel: (() -> Void)?
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true { cancel?() }
    }
}

@MainActor final class NativeHostService: NSObject, WKNavigationDelegate, WKUIDelegate, WKHTTPCookieStoreObserver {
    private let presentingController: () -> UIViewController?
    private let transportHost: () -> UIView?
    var runtimeChanged: ((NativeRuntimeSnapshot) -> Void)?
    var connectionStageChanged: ((String) -> Void)?
    var validateBrokerURL: ((URL) async throws -> Void)?
    var mediaService: NativeMediaService? {
        didSet {
            mediaPresenter.service = mediaService
            mediaService?.updateRuntime(currentRuntime)
            mediaService?.diagnosticEvent = { [weak self] event, reason in
                self?.journal.record(event, stage: "media", code: reason == "media" ? nil : reason)
            }
        }
    }
    var currentRuntime: NativeRuntimeSnapshot { NativeRuntimeSnapshot(dictionary: deviceRuntime?.snapshot() ?? [:]) }
    private var browser: WKWebView!
    private var loginBrowser: WKWebView?
    private var loginPopup: WKWebView?
    private var loginWaiting: [NativeInvocation] = []
    private var loginNeedsReload = false
    private var deviceRuntime: DeviceRuntime?
    private var replies: [String: (RequestReply, Bool, UInt64)] = [:]
    private var issuedIds = Set<String>()
    private var transportReady = false
    private var ruleCompiling = false
    private var transportNavigation: WKNavigation?
    private var transportEpoch: UInt64 = 0
    private var needsReload = true
    private let sessionTransaction = SessionTransaction()
    private var loginNativeInvocation: NativeInvocation?
    private var loginCompleting = false
    private var loginCommitted = false
    private var loginResume: (() -> Void)?
    private var loginToken: UUID?
    private var loginHandoff = LoginHandoff()
    private var loginController: UINavigationController?
    private var pendingCookies: [HTTPCookie] = []
    private let mediaPresenter = NativeMediaPresenter()
    private var readyCallbacks: [String: (UInt64, () -> Void)] = [:]
    private var loading = false
    private var activeToken = ""
    private var cookieJobs: [() -> Void] = []
    private var cookieBusy = false
    private var connectionTimings: [[String: Any]] = []
    private let journal = ConnectionJournal()
    private var identityJobs: [String: IdentityTransport] = [:]
    private let httpBridge = ProviderHTTPBridge()
    private var httpParents: [String: RequestArgs] = [:]
    private var httpJobs: [String: (String, ProviderHTTPTransport)] = [:]
    private let world = WKContentWorld.world(name: "FocusFeedPrivateTransport")
    private let keychainAccount = "twitter-browser-cookies-v1"

    init(presentingController: @escaping () -> UIViewController?, transportHost: @escaping () -> UIView?) {
        self.presentingController = presentingController
        self.transportHost = transportHost
        super.init()
        dispatchPrecondition(condition: .onQueue(.main))
        loadTransport()
    }

    private func loadTransport() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        httpBridge.handle = { [weak self] message, done in
            guard let self = self else { done(ConnectionFault.value("cancelled", "bridge", retryable:false)); return }
            self.handleHTTP(message, done:done)
        }
        config.userContentController.addScriptMessageHandler(httpBridge, contentWorld:world, name:"ffnHttp")
        browser = WKWebView(frame: .zero, configuration: config)
        // Keep WebKit attached to the app's active hierarchy without exposing
        // the transport document to touch or accessibility navigation.
        browser.frame = CGRect(x:-2,y:-2,width:1,height:1)
        browser.isUserInteractionEnabled = false
        browser.accessibilityElementsHidden = true
        transportHost()?.addSubview(browser)
        browser.navigationDelegate = self
        compileTransportRules()
        deviceRuntime = DeviceRuntime()
        deviceRuntime?.currentScene = { [weak self] in self?.transportHost()?.window?.windowScene }
        deviceRuntime?.changed = { [weak self] snapshot in
            guard let self = self else { return }
            if snapshot["foreground"] as? Bool == false { self.journal.record("background",stage:"login"); self.cancelTransportReads(all:true);self.mediaPresenter.pause() }
            if snapshot["active"] as? Bool == true {
                self.journal.record("resume",stage:"login")
                if self.loginNeedsReload && !self.loginCompleting { self.loginNeedsReload = false; (self.loginPopup ?? self.loginBrowser)?.reload() }
                if let resume = self.loginResume { self.loginResume = nil; resume() }
                let waiting = self.loginWaiting; self.loginWaiting.removeAll()
                waiting.forEach { $0.resolve() }
                if !self.loginCompleting { self.completeLogin() }
            }
            let typed = NativeRuntimeSnapshot(dictionary: snapshot)
            self.mediaService?.updateRuntime(typed)
            self.runtimeChanged?(typed)
                }
        if #available(iOS 16.4, *) { browser.isInspectable = false }
    }

    private func compileTransportRules(attempt: Int = 0) {
        guard !ruleCompiling, !transportReady else { return }
        ruleCompiling = true
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ffn-transport-v2", encodedContentRuleList: TransportRules.encoded) { [weak self] list, _ in
            guard let self = self else { return }
            self.ruleCompiling = false
            if let list = list {
                self.browser.configuration.userContentController.add(list)
                self.transportReady = true
            } else if attempt == 0 {
                self.compileTransportRules(attempt: 1); return
            }
            // Blocking rules are defense in depth. Our empty, app-owned document
            // and navigation policy do not depend on their compilation to log in.
        }
    }
    private func emitStage(_ stage: String) {
        journal.record("stage",stage:stage)
        connectionStageChanged?(stage)
    }
    @objc func login(_ invoke: NativeInvocation) {
        DispatchQueue.main.async {
            do { try self.ensureTransportAttached() } catch { invoke.fail(error); return }
            guard self.loginToken == nil else { rejectNative(invoke, "Sign-in is already open."); return }
            guard let root = self.presentingController() else { rejectNative(invoke, "The reader is not ready."); return }
            self.journal.begin()
            self.emitStage("login")
            self.loginNativeInvocation = invoke
            self.loginCompleting = false
            self.loginCommitted = false
            self.loginHandoff = LoginHandoff()
            self.loginResume = nil
            let attempt = UUID(); self.loginToken = attempt
            DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in
                guard let self = self, self.loginToken == attempt, !self.loginCommitted else { return }
                self.finishLoginFailure(self.loginNativeInvocation, code: "timeout")
            }
            self.pendingCookies = []
            self.cancelTransportReads()
            self.activeToken = ""
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            let login = WKWebView(frame: .zero, configuration: config)
            login.navigationDelegate = self
            login.uiDelegate = self
            config.websiteDataStore.httpCookieStore.add(self)
            if #available(iOS 16.4, *) { login.isInspectable = false }
            self.loginBrowser = login
            let page = LoginController()
            let arabic = Locale.preferredLanguages.first?.hasPrefix("ar") == true
            page.title = arabic ? "تسجيل الدخول إلى تويتر" : "Sign in to Twitter"
            page.view = login
            page.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(self.cancelLogin))
            let options = UIMenu(children:[
                UIAction(title:arabic ? "إعادة تحميل" : "Reload",image:UIImage(systemName:"arrow.clockwise")) { [weak self] _ in self?.reloadLogin() },
                UIAction(title:arabic ? "مشاركة التشخيص" : "Share report",image:UIImage(systemName:"square.and.arrow.up")) { [weak self] _ in self?.shareLoginReport() }
            ])
            page.navigationItem.rightBarButtonItems = [
                UIBarButtonItem(title: arabic ? "متابعة" : "Continue", style: .done, target: self, action: #selector(self.continueLogin)),
                UIBarButtonItem(image:UIImage(systemName:"ellipsis.circle"),menu:options)
            ]
            page.cancel = { [weak self] in if self?.loginCompleting == false { self?.cancelLogin() } }
            let nav = UINavigationController(rootViewController: page)
            // Full-screen presentation removes the reader from the window, along
            // with its transport WKWebView. Keep that hierarchy alive until the
            // captured account is verified, committed, and the login UI closes.
            nav.modalPresentationStyle = .overFullScreen
            nav.view.accessibilityViewIsModal = true
            self.loginController = nav
            root.present(nav, animated: true)
            login.load(URLRequest(url: URL(string: "https://x.com/i/flow/login")!))
        }
    }
    @objc private func reloadLogin() {
        guard !loginCompleting else { return }
        journal.record("recovery",stage:"login")
        if let view = loginPopup ?? loginBrowser {
            if view.url == nil { view.load(URLRequest(url:URL(string:"https://x.com/i/flow/login")!)) }
            else { view.reload() }
        }
    }
    @objc private func shareLoginReport() {
        guard let controller = loginController, controller.presentedViewController == nil else { return }
        let data = try? JSONSerialization.data(withJSONObject:diagnosticSnapshot(),options:[.prettyPrinted,.sortedKeys])
        guard let data = data else { return }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("FocusFeedNext-login-report.json")
        do { try data.write(to:file,options:.atomic) } catch { return }
        let sheet = UIActivityViewController(activityItems:[file],applicationActivities:nil)
        sheet.popoverPresentationController?.barButtonItem = controller.topViewController?.navigationItem.rightBarButtonItems?.last
        sheet.completionWithItemsHandler = { _,_,_,_ in try? FileManager.default.removeItem(at:file) }
        controller.present(sheet,animated:true)
    }
    private func diagnosticSnapshot() -> [String:Any] {
        ["schema":1,"appVersion":Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
         "build":Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
         "osVersion":UIDevice.current.systemVersion,"active":UIApplication.shared.applicationState == .active,
         "loginOpen":loginToken != nil,"events":journal.snapshot(),"media":mediaService?.diagnosticSnapshot() ?? [:]]
    }
    @objc func connectionDiagnostics(_ invoke: NativeInvocation) { DispatchQueue.main.async { invoke.resolve(self.diagnosticSnapshot()) } }
    @objc func shareConnectionReport(_ invoke: NativeInvocation) { DispatchQueue.main.async {
        guard let root = self.presentingController(),
              let data = try? JSONSerialization.data(withJSONObject:self.diagnosticSnapshot(),options:[.prettyPrinted,.sortedKeys]) else { rejectNative(invoke,"Diagnostic report is unavailable."); return }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("FocusFeedNext-login-report-\(UUID().uuidString).json")
        do { try data.write(to:file,options:.atomic) } catch { rejectNative(invoke,"Diagnostic report is unavailable."); return }
        let sheet = UIActivityViewController(activityItems:[file],applicationActivities:nil)
        sheet.popoverPresentationController?.sourceView = root.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x:root.view.bounds.midX,y:root.view.bounds.midY,width:1,height:1)
        sheet.completionWithItemsHandler = { _,_,_,_ in try? FileManager.default.removeItem(at:file); invoke.resolve() }
        root.present(sheet,animated:true)
    } }
    @objc private func cancelLogin() {
        guard loginToken != nil, !loginCommitted else { return }
        finishLoginFailure(loginNativeInvocation, code: "cancelled")
    }
    private func finishLoginFailure(_ invoke: NativeInvocation?, code: String) {
        journal.record(code == "cancelled" ? "cancelled" : "failure",stage:"login",code:code)
        loginHandoff.cancel()
        loginNativeInvocation = nil; loginToken = nil; loginResume = nil; loginCompleting = false
        loginCommitted = false
        let waiting = loginWaiting; loginWaiting.removeAll()
        waiting.forEach { $0.resolve(ConnectionFault.value(code,"login",retryable:code != "cancelled")) }
        cancelTransportReads(all: true, authenticationFault: code)
        loginBrowser?.configuration.websiteDataStore.httpCookieStore.remove(self)
        loginPopup?.stopLoading(); loginPopup = nil
        loginBrowser?.stopLoading(); loginBrowser = nil
        loginController?.dismiss(animated: true); loginController = nil
        loginNeedsReload = false; pendingCookies = []; activeToken = ""; needsReload = true; loading = false; browser.stopLoading(); updatePresentationState()
        invoke?.resolve(ConnectionFault.value(code, "login", retryable: code != "cancelled"))
    }
    @objc func waitForLoginActive(_ invoke: NativeInvocation) { DispatchQueue.main.async {
        guard self.loginToken != nil, self.loginCompleting else { invoke.resolve(ConnectionFault.value("cancelled","login",retryable:false)); return }
        if UIApplication.shared.applicationState == .active { invoke.resolve() }
        else { self.loginWaiting.append(invoke) }
    } }
    @objc func endLogin(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(LoginFailureArgs.self)
        DispatchQueue.main.async {
            guard let controller = self.loginController, controller.presentedViewController == nil, args.code != "cancelled", UIApplication.shared.applicationState == .active else {
                self.finishLoginFailure(nil,code:args.code); invoke.resolve(); return
            }
            let arabic = Locale.preferredLanguages.first?.hasPrefix("ar") == true
            let alert = UIAlertController(title:arabic ? "تعذر إكمال الاتصال" : "Connection could not complete",message:ConnectionFault.loginMessage(args.code,arabic:arabic),preferredStyle:.alert)
            alert.addAction(UIAlertAction(title:arabic ? "حسنًا" : "OK",style:.default) { _ in
                self.finishLoginFailure(nil,code:args.code)
            })
            controller.present(alert,animated:true); invoke.resolve()
        }
    }
    @objc func recoverLogin(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(LoginFailureArgs.self)
        DispatchQueue.main.async {
            guard let controller = self.loginController, self.loginToken != nil, !self.loginCommitted,
                  controller.presentedViewController == nil else { invoke.resolve(ConnectionFault.value("cancelled","login",retryable:false)); return }
            self.loginNativeInvocation = invoke
            self.journal.record("recovery",stage:"identity",code:args.code)
            let present = { [weak self] in
                guard let self = self, self.loginNativeInvocation != nil else { return }
                let ar = Locale.preferredLanguages.first?.hasPrefix("ar") == true
                let alert = UIAlertController(title:ar ? "تعذر التحقق من الاتصال" : "Connection verification failed",message:ConnectionFault.loginMessage(args.code,arabic:ar),preferredStyle:.alert)
                if args.code != "rate_limited" && args.code != "account_challenge" && args.code != "authentication_expired" {
                    alert.addAction(UIAlertAction(title:ar ? "إعادة التحقق دون تسجيل جديد" : "Check again without signing in",style:.default) { _ in
                        guard let selection = LoginCookies.select(self.pendingCookies) else { self.finishLoginFailure(invoke,code:"missing_cookies"); return }
                        self.loginNativeInvocation = nil; self.activeToken = ""; self.needsReload = true
                        invoke.resolve(["authToken":selection.token,"ct0":selection.csrf])
                    })
                }
                alert.addAction(UIAlertAction(title:ar ? "العودة إلى X وإكمال التحقق" : "Return to X to finish verification",style:.default) { _ in
                    self.loginCompleting = false; self.loginHandoff = LoginHandoff()
                    self.loginBrowser?.isUserInteractionEnabled = true; self.loginPopup?.isUserInteractionEnabled = true
                    self.loginBrowser?.configuration.websiteDataStore.httpCookieStore.add(self)
                    controller.topViewController?.navigationItem.rightBarButtonItems?.forEach { $0.isEnabled = true }
                    controller.topViewController?.title = ar ? "أكمل الدخول واضغط متابعة" : "Finish sign-in, then Continue"
                    if args.code == "account_challenge" { self.loginBrowser?.load(URLRequest(url:URL(string:"https://x.com/account/access")!)) }
                })
                alert.addAction(UIAlertAction(title:ar ? "إغلاق وعرض التشخيص" : "Close and view diagnostics",style:.default) { _ in
                    self.finishLoginFailure(invoke,code:args.code)
                })
                alert.addAction(UIAlertAction(title:ar ? "إلغاء" : "Cancel",style:.cancel) { _ in self.finishLoginFailure(invoke,code:"cancelled") })
                controller.present(alert,animated:true)
            }
            if UIApplication.shared.applicationState == .active { present() }
            else { self.loginResume = present }
        }
    }
    @objc private func continueLogin() { completeLogin(showMissing: true) }
    private func completeLogin(showMissing: Bool = false) {
        guard let invoke = loginNativeInvocation, let login = loginBrowser, let attempt = loginToken, !loginCompleting,
              showMissing || LoginNavigation.isHome(login.url) || LoginNavigation.isHome(loginPopup?.url) else { return }
        loginCompleting = true
        let handoff = loginHandoff
        login.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, self.loginNativeInvocation != nil, self.loginToken == attempt else { return }
            self.journal.record("cookies",stage:"cookies",detail:["hasToken":cookies.contains{$0.name == "auth_token" && !$0.value.isEmpty},"hasCsrf":cookies.contains{$0.name == "ct0" && !$0.value.isEmpty},"hasIdentity":LoginCookies.activeUserId(cookies) != nil])
            guard let selection = LoginCookies.select(cookies) else {
                self.loginCompleting = false
                if showMissing {
                    let arabic = Locale.preferredLanguages.first?.hasPrefix("ar") == true
                    let alert = UIAlertController(title: arabic ? "أكمل تسجيل الدخول" : "Finish signing in", message: arabic ? "أكمل تسجيل الدخول في تويتر ثم اضغط متابعة." : "Complete Twitter sign-in, then tap Continue.", preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: arabic ? "حسنًا" : "OK", style: .default))
                    self.loginController?.present(alert, animated: true)
                }
                return
            }
            self.emitStage("cookies")
            self.pendingCookies = selection.cookies
            login.configuration.websiteDataStore.httpCookieStore.remove(self)
            login.isUserInteractionEnabled = false; self.loginPopup?.isUserInteractionEnabled = false
            handoff.didCapture()
            let arabic = Locale.preferredLanguages.first?.hasPrefix("ar") == true
            self.loginController?.topViewController?.title = arabic ? "جارٍ التحقق من الاتصال…" : "Verifying connection…"
            self.loginController?.topViewController?.navigationItem.rightBarButtonItems?.prefix(2).forEach { $0.isEnabled = false }
            let publish = { [weak self] in
                    guard let self = self else { return }
                    guard self.loginNativeInvocation != nil, self.loginToken == attempt else { return }
                    guard handoff.finish(active: UIApplication.shared.applicationState == .active) else { return }
                    self.loginNativeInvocation = nil
                    invoke.resolve(["authToken": selection.token, "ct0": selection.csrf])
            }
            if UIApplication.shared.applicationState == .active { publish() }
            else { self.loginResume = publish }
        }
    }
    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        guard loginNativeInvocation != nil else { return }
        completeLogin()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === loginBrowser || webView === loginPopup {
            let path = webView.url?.path ?? ""
            journal.record("navigation",stage:"login",detail:["page":LoginNavigation.isHome(webView.url) ? "home" : path.contains("access") ? "challenge" : path.contains("login") ? "login" : "other"])
            if LoginNavigation.isHome(webView.url) { completeLogin() }; return
        }
        guard webView === browser, navigation === transportNavigation else { return }
        let epoch = transportEpoch
        webView.evaluateJavaScript(TransportDocument.originCheck, in: nil, in: world) { [weak self] result in
            guard let self = self, epoch == self.transportEpoch else { return }
            guard case .success(let value) = result, value as? Bool == true else { self.failTransport(stage: "transport_origin"); return }
            self.loading = false; self.needsReload = false
            let callbacks = self.readyCallbacks; self.readyCallbacks.removeAll()
            callbacks.values.forEach { $0.1() }
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === loginBrowser || webView === loginPopup {
            if !loginCompleting {
                loginNeedsReload = true
                if UIApplication.shared.applicationState == .active { loginNeedsReload = false; webView.reload() }
            }
            return
        }
        failTransport(stage: "transport_process")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if LoginNavigation.ignore(error,captured:false) { return }
        if webView === loginBrowser || webView === loginPopup {
            if LoginNavigation.ignore(error,captured:loginCompleting) { return }
            if LoginNavigation.recoverOnReturn(error,captured:loginCompleting,active:UIApplication.shared.applicationState == .active) { loginNeedsReload = true; return }
            showLoginNavigationFailure(error); return
        }
        if navigation === transportNavigation { failTransport(stage: "transport_navigation", error: error) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if LoginNavigation.ignore(error,captured:false) { return }
        if webView === loginBrowser || webView === loginPopup {
            if LoginNavigation.ignore(error,captured:loginCompleting) { return }
            if LoginNavigation.recoverOnReturn(error,captured:loginCompleting,active:UIApplication.shared.applicationState == .active) { loginNeedsReload = true; return }
            showLoginNavigationFailure(error)
        }
        else if navigation === transportNavigation { failTransport(stage: "transport_navigation", error: error) }
    }
    private func showLoginNavigationFailure(_ error: Error) {
        let fault = ConnectionFault.transport(stage:"login",error:error)["fault"] as? [String:Any] ?? [:]
        journal.record("failure",stage:"login",code:"network_failure",detail:fault)
        guard loginController?.presentedViewController == nil else { return }
        let ar = Locale.preferredLanguages.first?.hasPrefix("ar") == true
        let alert = UIAlertController(title:ar ? "تعذر تحميل صفحة X" : "X page could not load",message:ar ? "تحقق من اتصالك ثم أعد تحميل الصفحة. ستبقى محاولة الدخول مفتوحة." : "Check your connection and reload the page. Your sign-in attempt will stay open.",preferredStyle:.alert)
        alert.addAction(UIAlertAction(title:ar ? "إعادة تحميل" : "Reload",style:.default) { _ in self.reloadLogin() })
        alert.addAction(UIAlertAction(title:ar ? "التشخيص" : "Report",style:.default) { _ in self.shareLoginReport() })
        alert.addAction(UIAlertAction(title:ar ? "إلغاء" : "Cancel",style:.cancel) { _ in self.cancelLogin() })
        loginController?.present(alert,animated:true)
    }
    private func failTransport(stage: String, error: Error? = nil) {
        journal.record("failure",stage:stage,code:"transport_initialization",detail:ConnectionFault.transport(stage:stage,error:error)["fault"] as? [String:Any] ?? [:])
        loading = false
        needsReload = true
        transportEpoch &+= 1; transportNavigation = nil
        readyCallbacks.removeAll()
        for (id, (reply, _, _)) in replies { reply.resolve(ConnectionFault.transport(stage: stage, id: id, error: error)) }
        httpParents.removeAll()
        let jobs = httpJobs.values.map { $0.1 }; httpJobs.removeAll(); jobs.forEach { $0.cancel() }
        replies.removeAll()
        issuedIds.removeAll()
        browser.stopLoading()
    }
    @objc func runtime(_ invoke: NativeInvocation) {
        DispatchQueue.main.async {
            let snapshot: [String: Any] = self.deviceRuntime?.snapshot() ?? [:]
            invoke.resolve(snapshot)
        }
    }
    @objc func connectionMetrics(_ invoke: NativeInvocation) {
        DispatchQueue.main.async { invoke.resolve(["samples": self.connectionTimings]) }
    }
    @objc func openExternal(_ invoke: NativeInvocation) throws {
        struct Args:Decodable {let url:String}
        let args=try invoke.parseArgs(Args.self)
        guard args.url.utf8.count<=8192,let url=URL(string:args.url),["https","http"].contains(url.scheme?.lowercased() ?? ""),url.host != nil,url.user == nil,url.password == nil else {rejectNative(invoke,"Unsupported link.");return}
        DispatchQueue.main.async {
            UIApplication.shared.open(url,options:[:]) {opened in
                if opened {invoke.resolve()} else {rejectNative(invoke,"The link could not open.")}
            }
        }
    }
    @objc func openProfile(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(ProfileArgs.self)
        guard !args.username.isEmpty, args.username.count <= 15, args.username.utf8.allSatisfy({ ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 }), let url = URL(string: "https://x.com/\(args.username)") else { rejectNative(invoke,"Unsupported request."); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { invoke.resolve() } else { rejectNative(invoke,"The creator profile could not open.") }
            }
        }
    }
    @objc func sharePreferences(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(ShareArgs.self)
        DispatchQueue.main.async {
            guard let root = self.presentingController(),
                  let data = args.bundle.data(using:.utf8),data.count <= 32768 else { rejectNative(invoke, "Preferences could not be exported."); return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("FocusFeedNext-preferences-\(UUID().uuidString).json")
            do { try data.write(to:file,options:.atomic) } catch { rejectNative(invoke, "Preferences could not be exported."); return }
            let sheet = UIActivityViewController(activityItems:[file],applicationActivities:nil)
            sheet.popoverPresentationController?.sourceView = root.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x:root.view.bounds.midX,y:root.view.bounds.midY,width:1,height:1)
            sheet.completionWithItemsHandler = { _,_,_,_ in try? FileManager.default.removeItem(at:file); invoke.resolve() }
            root.present(sheet,animated:true)
        }
    }
    @objc func cancelReads(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(CancelArgs.self)
        DispatchQueue.main.async { self.cancelTransportReads(beforeGeneration:args.beforeGeneration); invoke.resolve() }
    }
    private func cancelTransportReads(beforeGeneration: UInt64? = nil, all: Bool = false, authenticationFault: String = "background_paused") {
        var obsoleteIds: [String] = []
        for (id, (reply, write, generation)) in replies where (!write || (all && !issuedIds.contains(id))) && (all || !reply.authentication) && (beforeGeneration == nil || generation < beforeGeneration!) {
            obsoleteIds.append(id)
            if reply.authentication { reply.interruptAuthentication(authenticationFault) }
            else { reply.reject("Request no longer needed.") }
            identityJobs.removeValue(forKey:id)?.cancel()
            cancelHTTP(id)
            replies.removeValue(forKey:id); issuedIds.remove(id); readyCallbacks.removeValue(forKey:id)
        }
        // WebKit can defer this script until activation. Scope cancellation to
        // the captured IDs so it cannot abort a newly resumed identity check.
        if !obsoleteIds.isEmpty {
            browser.callAsyncJavaScript("for (const id of ids) globalThis.__ffnReader?.cancel(id);",arguments:["ids":obsoleteIds],in:nil,in:world) { _ in }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if webView === browser {
            decisionHandler(TransportDocument.permitsNavigation(navigationAction.request.url, bootstrapping: loading) ? .allow : .cancel)
            return
        }
        if (webView === loginBrowser || webView === loginPopup), navigationAction.request.url?.host == "accounts.google.com" {
            decisionHandler(.cancel); return
        }
        guard let url = navigationAction.request.url, url.scheme == "https", let host = url.host,
              host == "x.com" || host.hasSuffix(".x.com") || host == "twitter.com" || host.hasSuffix(".twitter.com") || host == "appleid.apple.com" || host == "idmsa.apple.com" || host == "account.apple.com" else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard webView === loginBrowser, loginPopup == nil, navigationAction.targetFrame == nil,
              let url = navigationAction.request.url, url.scheme == "https", url.host != "accounts.google.com" else { return nil }
        let popup = WKWebView(frame:.zero,configuration:configuration)
        popup.navigationDelegate = self; popup.uiDelegate = self
        let page = UIViewController(); page.view = popup
        page.navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem:.cancel,target:self,action:#selector(cancelLogin))
        loginPopup = popup; loginController?.pushViewController(page,animated:true)
        return popup
    }
    func webViewDidClose(_ webView: WKWebView) {
        guard webView === loginPopup else { return }
        loginPopup = nil; loginController?.popToRootViewController(animated:true); completeLogin()
    }
    @objc func commit(_ invoke: NativeInvocation) {
        DispatchQueue.main.async {
            guard let attempt = self.loginToken, self.loginCompleting else { invoke.resolve(ConnectionFault.value("cancelled","login",retryable:false)); return }
            self.browser.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            guard self.loginToken == attempt else { invoke.resolve(ConnectionFault.value("cancelled","login",retryable:false)); return }
            guard UIApplication.shared.applicationState == .active else { invoke.resolve(ConnectionFault.value("background_paused","identity")); return }
            guard let selection = LoginCookies.select(cookies), selection.token == self.activeToken else { invoke.resolve(ConnectionFault.value("authentication_expired","cookies",retryable:false)); return }
            self.emitStage("storage")
            let rows = selection.cookies.map { cookie -> [String: Any] in
                ["name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path,
                 "secure": cookie.isSecure, "expires": cookie.expiresDate?.timeIntervalSince1970 ?? 0]
            }
            guard let data = try? SessionRecord.encode(token: selection.token, csrf: selection.csrf, cookies: rows) else { rejectNative(invoke, "Session storage failed."); return }
            do { try self.sessionTransaction.commit(data, read: self.readSession, write: self.writeSession, remove: self.removeSession) }
            catch { rejectNative(invoke, "Keychain could not commit and verify the session."); return }
            self.journal.record("committed",stage:"storage")
            self.pendingCookies = []
            self.loginCommitted = true
            self.loginController?.topViewController?.navigationItem.leftBarButtonItem?.isEnabled = false
            invoke.resolve(["authToken":selection.token,"ct0":selection.csrf])
            }
        }
    }
    private func readKeychain(_ service: String, _ account: String) -> Data? {
        let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,
            kSecAttrAccount as String:account,kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary,&result) == errSecSuccess else { return nil }
        return result as? Data
    }
    private var sessionQuery: [String: Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.focusfeed.next",kSecAttrAccount as String:"x-session"] }
    private func readSession() throws -> Data? {
        var query = sessionQuery; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw SessionWriteError.save }
        return data
    }
    private func writeSession(_ data: Data) throws {
        let status = SecItemUpdate(sessionQuery as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            var entry = sessionQuery; entry[kSecValueData as String] = data; entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(entry as CFDictionary,nil) == errSecSuccess else { throw SessionWriteError.save }
        } else if status != errSecSuccess { throw SessionWriteError.save }
    }
    private func removeSession() throws {
        let status = SecItemDelete(sessionQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionWriteError.save }
    }
    @objc func rollback(_ invoke: NativeInvocation) { DispatchQueue.main.async {
        do {
            try self.sessionTransaction.rollback(write:self.writeSession,remove:self.removeSession)
            self.finishLoginFailure(nil, code: "cancelled")
            invoke.resolve()
        }
        catch { rejectNative(invoke, "Keychain could not restore the previous session.") }
    } }
    @objc func finalize(_ invoke: NativeInvocation) { DispatchQueue.main.async {
        guard UIApplication.shared.applicationState == .active else { invoke.resolve(ConnectionFault.value("background_paused","storage")); return }
        self.journal.record("connected",stage:"connected")
        self.sessionTransaction.finalize(); self.emitStage("connected")
        self.loginToken = nil; self.loginResume = nil; self.loginCompleting = false
        self.loginBrowser?.configuration.websiteDataStore.httpCookieStore.remove(self)
        self.loginBrowser?.stopLoading(); self.loginPopup?.stopLoading()
        self.loginBrowser = nil; self.loginPopup = nil; self.pendingCookies = []
        let controller = self.loginController; self.loginController = nil; self.updatePresentationState()
        if let controller = controller { controller.dismiss(animated:true) { invoke.resolve() } }
        else { invoke.resolve() }
    } }
    @objc func migrateSession(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(SessionArgs.self)
        DispatchQueue.main.async {
            do {
                if let existing = try self.readSession(), let record = try? JSONSerialization.jsonObject(with:existing) as? [String:Any],
                   record["version"] as? Int == 1, record["authToken"] as? String == args.authToken, record["ct0"] as? String == args.ct0 { invoke.resolve(); return }
                let rows = self.savedCookies().filter { $0.name != "auth_token" && $0.name != "ct0" }.map { cookie -> [String:Any] in
                    ["name":cookie.name,"value":cookie.value,"domain":cookie.domain,"path":cookie.path,"secure":cookie.isSecure,"expires":cookie.expiresDate?.timeIntervalSince1970 ?? 0]
                }
                let data = try SessionRecord.encode(token:args.authToken,csrf:args.ct0,cookies:rows)
                try self.sessionTransaction.commit(data,read:self.readSession,write:self.writeSession,remove:self.removeSession)
                self.sessionTransaction.finalize(); invoke.resolve()
            } catch { rejectNative(invoke, "The previous session could not be migrated safely.") }
        }
    }
    private func savedCookies() -> [HTTPCookie] {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.focusfeed.next.ios", kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let legacyStatus = SecItemCopyMatching(query as CFDictionary, &result)
        let envelope = self.readKeychain("com.focusfeed.next", "x-session").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String:Any] }
        let rows = envelope?["cookies"] as? [[String:Any]] ?? (legacyStatus == errSecSuccess ? (result as? Data).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String:Any]] } : nil) ?? []
        return rows.compactMap { row in
            var p: [HTTPCookiePropertyKey: Any] = [.name: row["name"] ?? "", .value: row["value"] ?? "",
                .domain: row["domain"] ?? "x.com", .path: row["path"] ?? "/", .secure: "TRUE"]
            if let expiry = row["expires"] as? Double, expiry > 0 { p[.expires] = Date(timeIntervalSince1970: expiry) }
            return HTTPCookie(properties: p)
        }
    }
    @objc func logout(_ invoke: NativeInvocation) {
        DispatchQueue.main.async {
            // Explicit sign-out removes compatibility entries first; otherwise
            // a later launch could restore an obsolete legacy pair.
            for (service, account) in [("com.focusfeed.next.ios", self.keychainAccount), ("com.focusfeed.next", "x-auth-token"), ("com.focusfeed.next", "x-ct0")] {
                let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service, kSecAttrAccount as String: account]
                let status = SecItemDelete(query as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { rejectNative(invoke, "Keychain could not remove the session."); return }
            }
            do { try self.removeSession() }
            catch { rejectNative(invoke, "Keychain could not remove the session."); return }
            self.activeToken = ""
            self.needsReload = true
            self.sessionTransaction.finalize()
            self.cancelTransportReads(all: true)
            self.mediaPresenter.dismiss(revision: nil)
            self.browser.evaluateJavaScript("globalThis.__ffnReader?.cancel(undefined,true);", in: nil, in: self.world, completionHandler: nil)
            self.pendingCookies = []
            self.browser.stopLoading()
            self.browser.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { invoke.resolve() }
        }
    }
    @objc func request(_ invoke: NativeInvocation) throws {
        try ensureTransportAttached()
        let args = try invoke.parseArgs(RequestArgs.self)
        let allowed = ["Me", "TweetDetail", "TweetResultByRestId", "HomeTimeline", "HomeLatestTimeline", "Bookmarks", "UserByScreenName", "UserTweets", "Following", "ListLatestTweetsTimeline", "DeleteBookmark", "Follow", "Unfollow"]
        guard allowed.contains(args.operation), args.authToken.count <= 512, args.ct0.count <= 512 else { rejectNative(invoke, "Unsupported request."); return }
        DispatchQueue.main.async {
            // A health/feed request from the previous session must not replace
            // cookies beneath the candidate account's identity check.
            guard LoginHandoff.permitsProviderRequest(loginOpen:self.loginToken != nil,authentication:args.context.authentication == true) else {
                rejectNative(invoke,"Request no longer needed."); return
            }
            if args.context.authentication == true {
                guard self.loginToken != nil, self.loginCompleting else { invoke.resolve(ConnectionFault.value("cancelled","login",retryable:false)); return }
                guard UIApplication.shared.applicationState == .active else { invoke.resolve(ConnectionFault.value("background_paused","identity")); return }
            }
            guard UIApplication.shared.applicationState != .background else { rejectNative(invoke, "The app is in the background."); return }
            let reply = RequestReply(invoke, deadline: args.context.deadline, id: args.context.id, authentication: args.context.authentication == true)
            let write = ["Follow", "Unfollow", "DeleteBookmark"].contains(args.operation)
            self.replies[args.context.id] = (reply,write,args.context.generation)
            reply.expired = { [weak self] in
                self?.browser.callAsyncJavaScript("globalThis.__ffnReader?.cancel(id);", arguments: ["id": args.context.id], in: nil, in: self?.world ?? WKContentWorld.page) { _ in }
                self?.replies.removeValue(forKey: args.context.id)
                self?.issuedIds.remove(args.context.id)
                self?.readyCallbacks.removeValue(forKey:args.context.id)
                self?.identityJobs.removeValue(forKey:args.context.id)?.cancel()
                self?.cancelHTTP(args.context.id)
                self?.journal.record("failure",stage:args.operation == "Me" ? "identity" : "provider",code:"timeout",detail:["operation":args.operation])
            }
            self.prepareCookies(args, reply) {
                guard reply.pending else { return }
                if args.operation == "Me" { self.performRequest(args,reply); return }
                let perform = { if reply.pending { self.performRequest(args, reply) } }
                if !self.loading, !self.needsReload { perform() }
                else {
                    self.readyCallbacks[args.context.id] = (args.context.generation,perform)
                    if !self.loading {
                        self.loading = true
                        self.emitStage("transport")
                        self.transportEpoch &+= 1
                        self.transportNavigation = TransportDocument.load(in: self.browser)
                        if self.transportNavigation == nil { self.failTransport(stage: "transport_navigation") }
                    }
                }
            }
        }
    }
    // Cookie installation is serialized before any engine work. An identity
    // change clears the entire transient store, including supporting cookies.
    private func prepareCookies(_ args: RequestArgs, _ reply: RequestReply, _ ready: @escaping () -> Void) {
        cookieJobs.append {
            let finish = { self.cookieBusy = false; self.drainCookies() }
            guard reply.pending else { finish(); return }
            // The server can rotate ct0 during navigation. Reinstalling the
            // captured value on every request would replace the current cookie.
            if self.activeToken == args.authToken { ready(); finish(); return }
            let install = {
                guard reply.pending else { finish(); return }
                let cookies = self.pendingCookies.first(where: { $0.name == "auth_token" })?.value == args.authToken ? self.pendingCookies : self.savedCookies()
                let matching = cookies.filter { $0.name != "auth_token" && $0.name != "ct0" }
                let base = ["auth_token": args.authToken, "ct0": args.ct0].compactMap { name, value in
                    HTTPCookie(properties: [.name: name, .value: value, .domain: ".x.com", .path: "/", .secure: "TRUE"])
                }
                let group = DispatchGroup()
                for cookie in matching + base {
                    group.enter(); self.browser.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { group.leave() }
                }
                group.notify(queue: .main) {
                    if reply.pending { self.activeToken = args.authToken; ready() }
                    else { self.activeToken = ""; self.needsReload = true }
                    finish()
                }
            }
            if self.activeToken != args.authToken {
                self.connectionTimings.removeAll()
                self.transportEpoch &+= 1; self.transportNavigation = nil
                self.browser.stopLoading(); self.loading = false; self.needsReload = true
                self.browser.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: install)
            } else { install() }
        }
        drainCookies()
    }
    private func drainCookies() {
        guard !cookieBusy, !cookieJobs.isEmpty else { return }
        cookieBusy = true; cookieJobs.removeFirst()()
    }
    private func performRequest(_ args: RequestArgs, _ reply: RequestReply) {
        browser.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, reply.pending else { return }
            guard let selection = LoginCookies.select(cookies), selection.token == args.authToken else {
                self.replies.removeValue(forKey:args.context.id)
                reply.resolve(ConnectionFault.value("authentication_expired","cookies",id:args.context.id,retryable:false)); return
            }
            if reply.authentication { self.pendingCookies = selection.cookies }
            let identity = LoginCookies.activeUserId(selection.cookies)
            if args.operation == "Me" {
                self.emitStage("identity")
                self.journal.record("request",stage:"identity",detail:["engine":"native"])
                let job = IdentityTransport(cookies:selection.cookies,csrf:selection.csrf,expectedUserId:identity)
                self.identityJobs[args.context.id] = job
                job.observed = { endpoint,status in self.journal.record("response",stage:"identity",status:status,detail:["engine":"native","endpoint":endpoint]) }
                job.start { response,cookies in
                    self.identityJobs.removeValue(forKey:args.context.id)
                    guard reply.pending else { return }
                    let status = response["status"] as? Int ?? 0
                    let body = response["body"] ?? [:]
                    let accepted = (200..<300).contains(status) && IdentityTransport.hasIdentity(body,expectedUserId:identity)
                    if accepted || IdentityTransport.definitive(status:status,body:body) {
                        self.installIdentityCookies(cookies,args:args,reply:reply) {
                            self.replies.removeValue(forKey:args.context.id)
                            var result = response
                            var data = body as? [String:Any] ?? ["users":body]
                            if let identity = identity { data["activeUserId"] = identity }
                            result["body"] = data
                            self.journal.record("response",stage:"identity",status:status,detail:["engine":"native","hasIdentity":accepted,"elapsedMs":reply.elapsedMs])
                            reply.resolve(result)
                        }
                    } else {
                        self.journal.record("fallback",stage:"identity",status:status == 0 ? nil : status,detail:response["fault"] as? [String:Any] ?? ["engine":"webkit"])
                        self.prepareWebkitIdentity(args,reply,csrf:selection.csrf,identity:identity)
                    }
                }
            } else { self.executeRequest(args,reply,csrf:selection.csrf,identity:identity) }
        }
    }
    private func installIdentityCookies(_ cookies: [HTTPCookie], args: RequestArgs, reply: RequestReply, done: @escaping () -> Void) {
        guard reply.pending else { return }
        guard let selection = LoginCookies.select(cookies), selection.token == args.authToken else {
            replies.removeValue(forKey:args.context.id)
            journal.record("failure",stage:"cookies",code:"authentication_expired")
            reply.resolve(ConnectionFault.value("authentication_expired","cookies",id:args.context.id,retryable:false)); return
        }
        let store = browser.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { existing in
            guard reply.pending else { return }
            let removed = DispatchGroup()
            for cookie in existing where cookie.name == "ct0" {
                removed.enter(); store.delete(cookie) { removed.leave() }
            }
            removed.notify(queue:.main) {
                guard reply.pending else { return }
                let installed = DispatchGroup()
                for cookie in selection.cookies { installed.enter(); store.setCookie(cookie) { installed.leave() } }
                installed.notify(queue:.main) {
                    guard reply.pending else { return }
                    if reply.authentication { self.pendingCookies = selection.cookies }
                    done()
                }
            }
        }
    }
    private func prepareWebkitIdentity(_ args: RequestArgs, _ reply: RequestReply, csrf: String, identity: String?) {
        let perform = { if reply.pending { self.executeRequest(args,reply,csrf:csrf,identity:identity) } }
        if !loading, !needsReload { perform() }
        else {
            readyCallbacks[args.context.id] = (args.context.generation,perform)
            if !loading {
                loading = true; emitStage("transport"); transportEpoch &+= 1
                transportNavigation = TransportDocument.load(in:browser)
                if transportNavigation == nil { failTransport(stage:"transport_navigation") }
            }
        }
    }
    private func executeRequest(_ args: RequestArgs, _ reply: RequestReply, csrf: String, identity: String?) {
        if args.operation == "Me" { emitStage("identity") }
        let script = NativeReaderScript.source
        issuedIds.insert(args.context.id)
        httpParents[args.context.id] = args
        let source = "if (!globalThis.__ffnReader) {" + script + ";globalThis.__ffnReader = FfnReader;}\nreturn await globalThis.__ffnReader.requestSafe(operation, variables, csrf, context);"
        browser.callAsyncJavaScript(source, arguments: ["operation": args.operation,
            "variables": args.variables.mapValues { $0.value }, "csrf": csrf,
            "context": ["id": args.context.id, "generation": args.context.generation, "priority": args.context.priority, "deadline": args.context.deadline,"authentication":args.context.authentication == true]], in: nil, in: world) { result in
            self.replies.removeValue(forKey: args.context.id)
            self.issuedIds.remove(args.context.id)
            self.cancelHTTP(args.context.id)
            switch result {
            case .success(let value):
                guard var response = value as? [String: Any] else { reply.reject("Twitter returned an unreadable response."); return }
                if !reply.pending { return }
                if var timing = response["timing"] as? [String: Any] {
                    timing["nativeMs"] = reply.elapsedMs
                    self.connectionTimings.append(timing)
                    if self.connectionTimings.count > 32 { self.connectionTimings.removeFirst() }
                }
                if args.operation == "Me", let identity = identity {
                    var body = response["body"] as? [String: Any] ?? ["users": response["body"] ?? []]
                    body["activeUserId"] = identity; response["body"] = body
                }
                var detail = response["fault"] as? [String:Any] ?? [:]
                detail["engine"] = "native"; detail["operation"] = args.operation; detail["elapsedMs"] = reply.elapsedMs
                self.journal.record(response["fault"] == nil ? "response" : "failure",stage:detail["stage"] as? String ?? "provider",status:response["status"] as? Int,detail:detail)
                reply.resolve(response)
            case .failure(let error):
                reply.resolve(ConnectionFault.transport(stage: "transport_script", id: args.context.id, error: error))
            }
        }
    }
    private func cancelHTTP(_ parent: String) {
        httpParents.removeValue(forKey:parent)
        let ids = httpJobs.filter { $0.value.0 == parent }.map { $0.key }
        for id in ids { httpJobs.removeValue(forKey:id)?.1.cancel() }
    }
    private func handleHTTP(_ message: [String:Any], done: @escaping ([String:Any]) -> Void) {
        guard let parent = message["requestId"] as? String, let id = message["jobId"] as? String,
              id.count <= 32, !id.isEmpty, id.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
            done(ConnectionFault.value("bridge_failure","bridge",retryable:false)); return
        }
        let key = parent + ":" + id
        if message["action"] as? String == "cancel" {
            if let job = httpJobs[key], job.0 == parent { httpJobs.removeValue(forKey:key); job.1.cancel() }
            done(["status":204,"text":"","headers":[:]]); return
        }
        guard message["action"] as? String == "fetch", let args = httpParents[parent],
              let (reply,_,_) = replies[parent], reply.pending, issuedIds.contains(parent), activeToken == args.authToken,
              httpJobs[key] == nil, httpJobs.count < 16,
              let text = message["url"] as? String, let url = URL(string:text), let method = message["method"] as? String,
              ProviderHTTPTransport.permits(url,method:method,operation:args.operation),
              let headers = message["headers"] as? [String:String] else {
            done(ConnectionFault.value("bridge_failure","bridge",id:parent,retryable:false)); return
        }
        let body = message["body"] as? String
        guard (body?.utf8.count ?? 0) <= 65536,
              headers["x-client-transaction-id"].map({ $0.count <= 512 && $0.range(of:"^[A-Za-z0-9+/=_-]+$",options:.regularExpression) != nil }) ?? true,
              headers["content-type"].map({ ["application/json","application/x-www-form-urlencoded"].contains($0) }) ?? true else {
            done(ConnectionFault.value("unsupported_response","bridge",id:parent,retryable:false)); return
        }
        let stage = ProviderHTTPTransport.stage(url)
        browser.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self, reply.pending, self.httpParents[parent] != nil, self.activeToken == args.authToken else { done(ConnectionFault.value("cancelled",stage,id:parent,retryable:false)); return }
            guard let selection = LoginCookies.select(cookies), selection.token == args.authToken else { done(ConnectionFault.value("authentication_expired","cookies",id:parent,retryable:false)); return }
            let timeout = Double(args.context.deadline) / 1000 - Date().timeIntervalSince1970
            guard timeout > 0 else { done(ConnectionFault.value("timeout",stage,id:parent)); return }
            let job = ProviderHTTPTransport(url:url,method:method,headers:headers,body:body,cookies:selection.cookies,csrf:selection.csrf,timeout:timeout)
            self.httpJobs[key] = (parent,job)
            self.journal.record("request",stage:stage,detail:["engine":"native","operation":args.operation,"resource":url.host == "abs.twimg.com" ? "metadata" : url.path == "/home" ? "home" : "api"])
            job.start { result, changed in
                self.httpJobs.removeValue(forKey:key)
                guard reply.pending, self.httpParents[parent] != nil, self.activeToken == args.authToken else { done(ConnectionFault.value("cancelled",stage,id:parent,retryable:false)); return }
                var detail = result["fault"] as? [String:Any] ?? [:]
                detail["engine"] = "native"; detail["operation"] = args.operation; detail["elapsedMs"] = result["httpMs"]
                self.journal.record(result["fault"] == nil ? "response" : "failure",stage:stage,status:result["status"] as? Int,detail:detail)
                self.installHTTPCookies(changed, token:args.authToken, pending:{ reply.pending && self.httpParents[parent] != nil }) { valid in
                    done(valid ? result : ConnectionFault.value("authentication_expired","cookies",id:parent,retryable:false))
                }
            }
        }
    }
    private func installHTTPCookies(_ changed: [HTTPCookie], token: String, pending: @escaping () -> Bool, done: @escaping (Bool) -> Void) {
        guard !changed.isEmpty else { done(true); return }
        cookieJobs.append {
            let finish = { (valid: Bool) in self.cookieBusy = false; done(valid); self.drainCookies() }
            guard pending(), self.activeToken == token else { finish(false); return }
            let store = self.browser.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { existing in
                guard pending(), self.activeToken == token else { finish(false); return }
                let removed = DispatchGroup()
                for old in existing where changed.contains(where: { $0.name == old.name && $0.path == old.path && $0.domain.trimmingCharacters(in:CharacterSet(charactersIn:".")) == old.domain.trimmingCharacters(in:CharacterSet(charactersIn:".")) }) {
                    removed.enter(); store.delete(old) { removed.leave() }
                }
                removed.notify(queue:.main) {
                    guard pending(), self.activeToken == token else { finish(false); return }
                    let installed = DispatchGroup()
                    for cookie in changed where cookie.expiresDate == nil || cookie.expiresDate! > Date() {
                        installed.enter(); store.setCookie(cookie) { installed.leave() }
                    }
                    installed.notify(queue:.main) { store.getAllCookies { current in
                        finish(pending() && self.activeToken == token && LoginCookies.select(current)?.token == token)
                    } }
                }
            }
        }
        drainCookies()
    }
    @objc func presentMedia(_ invoke: NativeInvocation) throws {
        let args = try invoke.parseArgs(NativeMediaArgs.self)
        Task { @MainActor in
            guard !args.items.isEmpty, args.items.count <= 16, args.items.indices.contains(args.index),
                  let validate = self.validateBrokerURL, self.mediaService != nil,
                  let root = self.presentingController(), root.presentedViewController == nil else {
                rejectNative(invoke, "The media viewer is not ready."); return
            }
            do {
                for item in args.items {
                    let url = try NativeMediaService.brokerURL(item.url)
                    try await validate(url)
                    for variant in item.variants ?? [] {
                        let url = try NativeMediaService.brokerURL(variant.url)
                        try await validate(url)
                    }
                }
                guard root.presentedViewController == nil else { throw NativeServiceError.unavailable }
                if !self.mediaPresenter.present(args, from: root, done: { invoke.resolve($0) }) {
                    rejectNative(invoke, "Another media viewer is already open.")
                }
            } catch { rejectNative(invoke, "This media is no longer available.") }
        }
    }
    @objc func dismissMedia(_ invoke: NativeInvocation) {
        struct Args:Decodable {let revision:UInt64?}
        let args=try? invoke.parseArgs(Args.self)
        DispatchQueue.main.async {self.mediaPresenter.dismiss(revision:args?.revision);invoke.resolve()}
    }
    @MainActor func loadSavedCandidate() async throws -> NativeSessionCandidate? {
        do {
            if let data = try readSession() {
                let record = try SessionRecord.decode(data)
                return NativeSessionCandidate(authToken: record.token, ct0: record.csrf)
            }
            // Legacy entries are read without mutation. The repository first
            // verifies Me, then explicitly calls migrateSavedCandidate.
            func legacy(_ account: String) throws -> String? {
                var query = sessionQuery
                query[kSecAttrAccount as String] = account
                query[kSecReturnData as String] = true
                query[kSecMatchLimit as String] = kSecMatchLimitOne
                var result: CFTypeRef?
                let status = SecItemCopyMatching(query as CFDictionary, &result)
                if status == errSecItemNotFound { return nil }
                guard status == errSecSuccess, let data = result as? Data,
                      let text = String(data: data, encoding: .utf8) else { throw SessionWriteError.save }
                return text
            }
            let token = try legacy("x-auth-token"); let csrf = try legacy("x-ct0")
            guard token != nil || csrf != nil else { return nil }
            let record = try SessionRecord.candidate(token: token ?? "", csrf: csrf ?? "")
            return NativeSessionCandidate(authToken: record.token, ct0: record.csrf)
        } catch {
            throw NativeServiceError(code: "session_storage", stage: "storage", retryable: false)
        }
    }
    @MainActor func ensureTransportAttached() throws {
        guard let host = transportHost() else { throw NativeServiceError.unavailable }
        if browser.superview !== host { browser.removeFromSuperview(); host.addSubview(browser) }
    }
    @MainActor func cancelSignIn() { cancelLogin() }
    @MainActor func cancelRequest(id: String) {
        guard let (reply, write, _) = replies[id] else { return }
        // A possibly-sent mutation is not aborted or replayed by read cancellation.
        guard !write || !issuedIds.contains(id) else { return }
        reply.reject("Request no longer needed.")
        identityJobs.removeValue(forKey: id)?.cancel(); cancelHTTP(id)
        replies.removeValue(forKey: id); issuedIds.remove(id); readyCallbacks.removeValue(forKey: id)
        browser.callAsyncJavaScript("globalThis.__ffnReader?.cancel(id);", arguments: ["id": id], in: nil, in: world) { _ in }
    }
    @MainActor func shutdown() {
        cancelTransportReads(all: true)
        failTransport(stage: "transport_process")
        identityJobs.values.forEach { $0.cancel() }; identityJobs.removeAll()
        let waiting = loginWaiting; loginWaiting.removeAll(); waiting.forEach { $0.resolve(ConnectionFault.value("cancelled", "login", retryable: false)) }
        finishLoginFailure(loginNativeInvocation, code: "cancelled")
        try? sessionTransaction.rollback(write: writeSession, remove: removeSession)
        mediaPresenter.dismiss(revision: nil)
        browser.configuration.userContentController.removeScriptMessageHandler(forName: "ffnHttp", contentWorld: world)
        browser.removeFromSuperview(); deviceRuntime = nil
    }
    private func updatePresentationState() {}
}
