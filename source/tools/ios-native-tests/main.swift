import Foundation
import AppKit
import WebKit

func require(_ value: Bool, _ message: String) { if !value { fputs("FAIL: \(message)\n",stderr); exit(1) } }
var assertions = 0
func check(_ value: Bool, _ message: String) { require(value,message); assertions += 1 }

let handoffGate = LoginHandoff()
check(!handoffGate.finish(active:true),"login cannot validate before cookie capture")
handoffGate.didCapture()
check(!handoffGate.finish(active:false),"backgrounding waits without discarding captured cookies")
check(handoffGate.finish(active:true) && !handoffGate.finish(active:true),"activation commits the handoff exactly once")
let cancelledGate=LoginHandoff();cancelledGate.cancel();cancelledGate.didCapture()
check(!cancelledGate.finish(active:true),"interrupted sign-in rejects late dismissal callbacks")
check(!LoginHandoff.permitsProviderRequest(loginOpen:true,authentication:false),"old account traffic cannot replace candidate login cookies")
check(LoginHandoff.permitsProviderRequest(loginOpen:true,authentication:true),"only candidate validation runs during sign-in")
check(LoginHandoff.permitsProviderRequest(loginOpen:false,authentication:false),"ordinary provider traffic resumes after login settles")
check(LoginNavigation.ignore(NSError(domain:NSURLErrorDomain,code:NSURLErrorCancelled),captured:false),"redirect cancellation never becomes login failure")
check(LoginNavigation.ignore(NSError(domain:NSURLErrorDomain,code:NSURLErrorNotConnectedToInternet),captured:true),"captured credentials survive login document teardown")
check(!LoginNavigation.ignore(NSError(domain:NSURLErrorDomain,code:NSURLErrorNotConnectedToInternet),captured:false),"real uncaptured network failure remains visible")
check(LoginNavigation.recoverOnReturn(NSError(domain:NSURLErrorDomain,code:NSURLErrorNetworkConnectionLost),captured:false,active:false),"background navigation interruption preserves login for recovery")
check(!LoginNavigation.recoverOnReturn(NSError(domain:NSURLErrorDomain,code:NSURLErrorNetworkConnectionLost),captured:false,active:true),"foreground network errors are not silently deferred")
check(LoginNavigation.isHome(URL(string:"https://x.com/home/")) && !LoginNavigation.isHome(URL(string:"https://example.com/home")),"only a Twitter home navigation auto-captures credentials")

let old = Data("legacy-token\nlegacy-csrf".utf8)
let candidate = try SessionRecord.encode(token:"fixture-token",csrf:"fixture-csrf",cookies:[["name":"support","value":"fixture","domain":".x.com","path":"/"]])
let record = try JSONSerialization.jsonObject(with:candidate) as! [String:Any]
check(record["version"] as? Int == 1 && (record["cookies"] as? [[String:Any]])?.count == 1,"one versioned record contains credentials and support cookies")
var stored: Data? = old
let transaction = SessionTransaction()
try transaction.commit(candidate,read:{stored},write:{stored=$0},remove:{stored=nil})
check(stored==candidate,"candidate is committed only after verification")
try transaction.rollback(write:{stored=$0},remove:{stored=nil})
check(stored==old,"interrupted sign-in restores exact legacy record")
do { try transaction.commit(candidate,read:{stored},write:{_ in throw SessionWriteError.save},remove:{stored=nil}); require(false,"failed write accepted") } catch {}
check(stored==old,"failed write retains previous record")
var reads=0
do { try transaction.commit(candidate,read:{reads+=1;return reads==2 ? nil : stored},write:{stored=$0},remove:{stored=nil}); require(false,"failed verification accepted") } catch {}
check(stored==old,"failed verification restores old session")
stored=nil;reads=0
do { try transaction.commit(candidate,read:{reads+=1;return reads==2 ? nil : stored},write:{stored=$0},remove:{stored=nil}); require(false,"failed new verification accepted") } catch {}
check(stored==nil,"failed new sign-in removes unverified record")
try transaction.commit(candidate,read:{stored},write:{stored=$0},remove:{stored=nil});transaction.finalize()
try transaction.rollback(write:{stored=$0},remove:{stored=nil})
check(stored==candidate,"finalized session cannot be rolled back by a late cancellation")

// Native identity transport: actual URLSession HTTP and sanitized persistent journal.
func nativeIdentity(_ token: String) -> ([String:Any], [HTTPCookie], Int) {
    let tokenCookie = HTTPCookie(properties:[.name:"auth_token",.value:token,.domain:"127.0.0.1",.path:"/"])!
    let csrfCookie = HTTPCookie(properties:[.name:"ct0",.value:"fixture-csrf",.domain:"127.0.0.1",.path:"/"])!
    let engine = IdentityTransport(cookies:[tokenCookie,csrfCookie],csrf:"fixture-csrf",baseURL:URL(string:"http://127.0.0.1:8769")!)
    var done = false; var output:[String:Any] = [:]; var cookies:[HTTPCookie] = []; var requests = 0
    engine.observed = { _,_ in requests += 1 }
    engine.start { result,updated in output = result; cookies = updated; done = true }
    let deadline = Date().addingTimeInterval(15)
    while !done && Date() < deadline { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
    require(done,"native identity deadline")
    return (output,cookies,requests)
}
let nativeOK = nativeIdentity("fixture-only")
check(nativeOK.0["status"] as? Int == 200 && nativeOK.2 == 1,"native identity verifies without a WebKit document")
check(nativeOK.1.contains{$0.name == "ct0" && $0.value == "fixture-rotated"},"native identity preserves server CSRF rotation")
let nativeAlternative = nativeIdentity("fixture-fallback")
check(nativeAlternative.0["status"] as? Int == 200 && nativeAlternative.2 == 2 && IdentityTransport.hasIdentity(nativeAlternative.0["body"]!),"obsolete identity endpoint falls back to authenticated verify_credentials")
let denied = nativeIdentity("fixture-denied")
check(denied.0["status"] as? Int == 401 && denied.2 == 1,"authentication refusals are not retried or hidden")
let limited = nativeIdentity("fixture-limited")
check(limited.0["status"] as? Int == 429 && limited.2 == 1,"rate limit never triggers another endpoint")
let challenge = nativeIdentity("fixture-challenge")
check(challenge.0["status"] as? Int == 403 && challenge.2 == 1,"account challenge returns for user verification")
let transient = nativeIdentity("fixture-transient")
check(transient.0["status"] as? Int == 200 && transient.2 == 2,"transient identity read has exactly one retry")
let redirect = nativeIdentity("fixture-redirect")
check(redirect.0["status"] as? Int == 302 && redirect.2 == 2,"redirects never forward captured session headers")
let large = nativeIdentity("fixture-large")
check((large.0["fault"] as? [String:Any])?["code"] as? String == "unsupported_response","oversized identity response is stopped")
let invalid = nativeIdentity("fixture-invalid")
check(!IdentityTransport.hasIdentity(invalid.0["body"]!) && !String(describing:invalid.0).contains("never-include-me"),"HTML is neither executed nor echoed by native identity")
let isolatedDefaults = UserDefaults(suiteName:"ffn-tests-connection-journal")!
isolatedDefaults.removePersistentDomain(forName:"ffn-tests-connection-journal")
let journal = ConnectionJournal(defaults:isolatedDefaults); journal.begin()
for _ in 0..<100 { journal.record("response",stage:"identity",status:403,detail:["authToken":"secret-token","url":"https://x.com/secret","nativeErrorDomain":"url","nativeErrorCode":-1009,"hasToken":true]) }
let reopened = ConnectionJournal(defaults:isolatedDefaults)
let journalText = String(data:try JSONSerialization.data(withJSONObject:reopened.snapshot()),encoding:.utf8)!
check(reopened.snapshot().count == 80 && reopened.attempt == 1,"journal is bounded and survives relaunch")
check(!journalText.contains("secret") && !journalText.contains("https") && journalText.contains("-1009"),"journal keeps safe numeric failure detail and strips all arbitrary text")
check(ConnectionJournal.safe(["event":"auth_token=secret","stage":"secret","code":"secret","time":Double.infinity]).isEmpty,"journal rejects unrecognized metadata and invalid numbers")
isolatedDefaults.removePersistentDomain(forName:"ffn-tests-connection-journal")

// Real WebKit on the macOS runner; only loopback fixture traffic.
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
NSApp.finishLaunching()
func waitUntil(_ done: @escaping ()->Bool, _ label: String) {
    let end=Date().addingTimeInterval(20)
    while !done() && Date()<end { RunLoop.main.run(until:Date().addingTimeInterval(0.01)) }
    require(done(),"timeout: \(label)")
}
final class Delegate: NSObject, WKNavigationDelegate {
    var finished=false
    var ownedDocument=false
    func webView(_ view:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        decisionHandler(!ownedDocument || TransportDocument.permitsNavigation(action.request.url,bootstrapping:!finished) ? .allow : .cancel)
    }
    func webView(_ view:WKWebView,didFinish navigation:WKNavigation!) { finished=true }
    func webView(_ view:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error) { require(false,"fixture navigation failed") }
}
let loginConfig=WKWebViewConfiguration();loginConfig.websiteDataStore = .nonPersistent()
let transportConfig=WKWebViewConfiguration();transportConfig.websiteDataStore = .nonPersistent()
var compiled: WKContentRuleList?
var compilationDone=false
WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"ffn-fixture-transport",encodedContentRuleList:TransportRules.encoded) { list,error in
    require(error==nil,"content rules compile");compiled=list;compilationDone=true
}
waitUntil({compilationDone},"content rules");require(compiled != nil,"compiled rule list missing")
transportConfig.userContentController.add(compiled!)
let login=WKWebView(frame:CGRect(x:0,y:0,width:390,height:844),configuration:loginConfig)
let transport=WKWebView(frame:login.frame,configuration:transportConfig)
let fixtureWindow=NSWindow(contentRect:CGRect(x:0,y:0,width:780,height:844),styleMask:[.titled],backing:.buffered,defer:false)
fixtureWindow.contentView?.addSubview(login)
transport.frame.origin.x=390
fixtureWindow.contentView?.addSubview(transport)
fixtureWindow.makeKeyAndOrderFront(nil)
let loginDelegate=Delegate();let transportDelegate=Delegate();login.navigationDelegate=loginDelegate;transport.navigationDelegate=transportDelegate
let fixture=URL(string:"http://127.0.0.1:8769/")!
login.load(URLRequest(url:fixture));transport.load(URLRequest(url:fixture))
waitUntil({loginDelegate.finished && transportDelegate.finished},"two isolated web views")
func evaluate(_ view:WKWebView,_ script:String)->Any? {
    var done=false;var output:Any?
    view.evaluateJavaScript(script) { value,error in require(error==nil,"fixture evaluation failed");output=value;done=true }
    waitUntil({done},"script");return output
}
check(evaluate(login,"globalThis.pageScriptRan === true") as? Bool == true,"login page scripts run")
check(evaluate(transport,"globalThis.pageScriptRan !== true && document.getElementById('image').naturalWidth === 0") as? Bool == true,"transport blocks page script and image")
check(evaluate(login,"getComputedStyle(document.body).color") as? String == "rgb(1, 2, 3)","login page styles apply")
check(evaluate(transport,"getComputedStyle(document.body).color") as? String != "rgb(1, 2, 3)","transport stylesheet blocked")
check(login.configuration.userContentController.userScripts.isEmpty && login.configuration.userContentController !== transport.configuration.userContentController,"login has no private engine or shared script controller")
let cookie=HTTPCookie(properties:[.name:"auth_token",.value:"fixture-only",.domain:"127.0.0.1",.path:"/"])!
var cookieSet=false;login.configuration.websiteDataStore.httpCookieStore.setCookie(cookie){cookieSet=true};waitUntil({cookieSet},"login cookie")
var isolated=false;var cookiesRead=false
transport.configuration.websiteDataStore.httpCookieStore.getAllCookies { rows in isolated = !rows.contains{$0.name=="auth_token"};cookiesRead=true }
waitUntil({cookiesRead},"transport cookies");check(isolated,"login cookies require explicit handoff")
var fetched=false
let world=WKContentWorld.world(name:"FocusFeedPrivateTransport")
transport.callAsyncJavaScript("const r=await fetch('/explicit-fetch');return await r.text();",arguments:[:],in:nil,in:world) { result in
    switch result { case .success(let value):check(value as? String=="explicit-fetch-ok","isolated explicit fetch retained");case .failure:require(false,"explicit fetch blocked") };fetched=true
}
waitUntil({fetched},"explicit fetch")
// Exercise the actual production bootstrap, including the one-pixel attached
// web view. The HTTPS document is app-owned: no external navigation occurs.
transport.frame = CGRect(x:-2,y:-2,width:1,height:1)
transportDelegate.finished = false
transportDelegate.ownedDocument = true
TransportDocument.load(in:transport)
waitUntil({transportDelegate.finished},"app-owned HTTPS transport")
check(evaluate(transport,TransportDocument.originCheck) as? Bool == true,"production transport establishes exact HTTPS origin without loading X")
var privateOrigin=false
transport.evaluateJavaScript(TransportDocument.originCheck,in:nil,in:world) { result in
    if case .success(let value) = result { check(value as? Bool == true,"production private content world verifies the same HTTPS origin") }
    else { require(false,"private origin check failed") }
    privateOrigin=true
}
waitUntil({privateOrigin},"private HTTPS origin")
check(evaluate(transport,"document.scripts.length === 0 && document.images.length === 0 && document.querySelectorAll('iframe,link').length === 0") as? Bool == true,"bootstrap has no provider page scripts or network resources")
check(!TransportDocument.permitsNavigation(URL(string:"https://x.com/home"),bootstrapping:true),"provider homepage navigation is prohibited")
check(!TransportDocument.permitsNavigation(TransportDocument.baseURL,bootstrapping:false),"ready transport rejects unsolicited navigation")
check(TransportDocument.permitsNavigation(TransportDocument.baseURL,bootstrapping:true),"only app-owned bootstrap navigation is permitted")
transportDelegate.finished = false
transportDelegate.ownedDocument = false
TransportDocument.load(in:transport,baseURL:fixture)
waitUntil({transportDelegate.finished},"app-owned fixture transport")
check(evaluate(transport,"globalThis.origin === 'http://127.0.0.1:8769'") as? Bool == true,"same production bootstrap establishes fixture origin")
// Hand off fixture cookies explicitly, then run the exact compiled production
// engine. Only fetch routing changes; no Twitter requests or account writes occur.
let csrfCookie=HTTPCookie(properties:[.name:"ct0",.value:"fixture-csrf",.domain:"127.0.0.1",.path:"/"])!
var handoff=false
transport.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
    transport.configuration.websiteDataStore.httpCookieStore.setCookie(csrfCookie) { handoff=true }
}
waitUntil({handoff},"fixture cookie handoff")
var directIdentity=false
transport.callAsyncJavaScript("const r=await fetch('/engine-me',{credentials:'include',headers:{'x-csrf-token':'fixture-csrf'}});return r.status;",arguments:[:],in:nil,in:world) { result in
    switch result { case .success(let value):check(value as? Int == 200,"one-pixel app-owned transport sends real same-origin cookies without fetch shim");case .failure:require(false,"app-owned same-origin fetch failed") };directIdentity=true
}
waitUntil({directIdentity},"unmodified same-origin identity fetch")
var engineInstalled=false
let shim="""
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
    const url = new URL(input, location.href);
    let route;
    if (url.href === 'https://x.com/home') route='/engine-home';
    else if (url.hostname === 'abs.twimg.com') route='/engine-demand';
    else if (url.pathname.endsWith('/account/multi/list.json')) route='/engine-me';
    else if (url.pathname.endsWith('/UserByScreenName')) route='/engine-profile'+url.search;
    else throw new Error('Fixture blocks unexpected network request');
    return originalFetch(route, {...init, credentials:'include'});
};
"""
transport.callAsyncJavaScript(shim+NativeReaderScript.source+";globalThis.__ffnReader=FfnReader;return true;",arguments:[:],in:nil,in:world) { result in
    if case .failure = result { require(false,"production engine install failed") };engineInstalled=true
}
waitUntil({engineInstalled},"production engine")
func engineRequest(_ operation:String,_ variables:[String:Any],_ id:String)->[String:Any] {
    var done=false;var output:[String:Any] = [:]
    transport.callAsyncJavaScript("return await globalThis.__ffnReader.requestSafe(operation,variables,'fixture-csrf',context);",arguments:["operation":operation,"variables":variables,"context":["id":id,"generation":1,"priority":1,"deadline":Date().timeIntervalSince1970*1000+75000]],in:nil,in:world) { result in
        switch result { case .success(let value):output=value as? [String:Any] ?? [:];case .failure:require(false,"production request bridge failed") };done=true
    }
    waitUntil({done},"production \(operation)");return output
}
let identity=engineRequest("Me",[:],"1")
check(identity["status"] as? Int == 200,"real transaction engine and transferred cookies validate identity")
let profile=engineRequest("UserByScreenName",["screen_name":"fixture"],"2")
check(profile["status"] as? Int == 200,"profile request carries operation-specific features")
let unsupported=engineRequest("NotAnOperation",[:],"3")
check((unsupported["fault"] as? [String:Any])?["code"] as? String == "unsupported_response","unsupported request returns safe structured fault")
let xToken=HTTPCookie(properties:[.name:"auth_token",.value:"fixture-token",.domain:".x.com",.path:"/"])!
let xCsrf=HTTPCookie(properties:[.name:"ct0",.value:"fixture-csrf",.domain:".x.com",.path:"/"])!
let wrongCsrf=HTTPCookie(properties:[.name:"ct0",.value:"wrong",.domain:".twitter.com",.path:"/"])!
check(LoginCookies.select([xToken,wrongCsrf]) == nil,"cookie families are never mixed")
check(LoginCookies.select([xToken,xCsrf])?.token == "fixture-token","same-origin cookie pair is captured")
let rotated=HTTPCookie(properties:[.name:"ct0",.value:"rotated-csrf",.domain:".x.com",.path:"/"])!
check(LoginCookies.select([xToken,rotated])?.csrf == "rotated-csrf","request and commit capture current CSRF after rotation")
let twid=HTTPCookie(properties:[.name:"twid",.value:"u%3D42",.domain:".x.com",.path:"/"])!
check(LoginCookies.activeUserId([twid]) == "42","active account identity is decoded without using array order")
check((ConnectionFault.fromMessage("Twitter took too long to respond.")["fault"] as? [String:Any])?["code"] as? String == "timeout","native deadline has a safe fault code")
let nativeFailure=ConnectionFault.transport(stage:"transport_navigation",id:"2",error:NSError(domain:NSURLErrorDomain,code:-1022,userInfo:[NSLocalizedDescriptionKey:"auth_token=secret"]))["fault"] as! [String:Any]
check(nativeFailure["nativeErrorCode"] as? Int == -1022 && nativeFailure["nativeErrorDomain"] as? String == "url" && nativeFailure["description"] == nil,"native diagnostics preserve only fixed domain and numeric code")
check(ConnectionFault.loginMessage("transport_initialization",arabic:false) != ConnectionFault.loginMessage("network_failure",arabic:false),"transport failure does not show generic internet advice")
print("Native session and WebKit checks passed: \(assertions) assertions; fixture traffic only.")
