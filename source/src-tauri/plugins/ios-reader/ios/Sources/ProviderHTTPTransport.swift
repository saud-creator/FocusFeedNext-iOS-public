import Foundation
import WebKit

// Registered only in the app-owned engine's private content world.
final class ProviderHTTPBridge: NSObject, WKScriptMessageHandlerWithReply {
    var handle: (([String: Any], @escaping ([String: Any]) -> Void) -> Void)?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let handle = handle else {
            replyHandler(ConnectionFault.value("bridge_failure", "bridge", retryable: false), nil); return
        }
        handle(body) { replyHandler($0, nil) }
    }
}

/// A single bounded HTTP request. Cookies and authentication stay native, and
/// downloaded HTML/JS are returned as text data, never executed by this class.
final class ProviderHTTPTransport: NSObject, URLSessionDataDelegate {
    static let operations = ["Me", "TweetDetail", "TweetResultByRestId", "HomeTimeline", "HomeLatestTimeline", "Bookmarks", "UserByScreenName", "UserTweets", "Following", "ListLatestTweetsTimeline", "DeleteBookmark", "Follow", "Unfollow"]
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    static func permits(_ url: URL, method: String, operation: String) -> Bool {
        guard operations.contains(operation), url.scheme == "https", url.port == nil || url.port == 443,
              url.user == nil, url.password == nil, url.fragment == nil, url.absoluteString.utf8.count <= 65536 else { return false }
        if url.host == "abs.twimg.com" {
            return method == "GET" && url.query == nil && url.path.range(of: "^/responsive-web/client-web[^/]*/[A-Za-z0-9_.-]+\\.js$", options: .regularExpression) != nil
        }
        guard url.host == "x.com" else { return false }
        if url.path == "/home" { return method == "GET" && url.query == nil }
        let rest = ["Me": "/i/api/1.1/account/multi/list.json", "Follow": "/i/api/1.1/friendships/create.json", "Unfollow": "/i/api/1.1/friendships/destroy.json"]
        if let path = rest[operation] { return url.path == path && method == (operation == "Me" ? "GET" : "POST") }
        let parts = url.path.split(separator: "/")
        return parts.count == 5 && parts[0] == "i" && parts[1] == "api" && parts[2] == "graphql" &&
            parts[3].range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil && parts[4] == operation &&
            method == (operation == "DeleteBookmark" ? "POST" : "GET")
    }
    static func stage(_ url: URL) -> String { url.host == "abs.twimg.com" || url.path == "/home" ? "bootstrap" : "provider" }
    static func cookieHeader(_ cookies: [HTTPCookie], url: URL) -> String? {
        // Provider cookies must never be sent to the public asset CDN.
        guard url.host == "x.com" else { return nil }
        let applicable = cookies.filter {
            $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == "x.com" &&
            (url.path == $0.path || url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/")) &&
            ($0.expiresDate == nil || $0.expiresDate! > Date())
        }
        return HTTPCookie.requestHeaderFields(with: applicable)["Cookie"]
    }
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var bytes = Data()
    private var oversize = false
    private let url: URL
    private let request: URLRequest
    private let limit: Int
    private let started = Date()
    private var completion: (([String: Any], [HTTPCookie]) -> Void)?

    // A loopback base is injected by native integration tests; callers from
    // JavaScript cannot supply it or change the production URL policy.
    init(url: URL, method: String, headers: [String: String], body: String?, cookies: [HTTPCookie], csrf: String, timeout: Double, fixtureBase: URL? = nil) {
        self.url = url; limit = url.host == "abs.twimg.com" ? 8 * 1024 * 1024 : 4 * 1024 * 1024
        let networkURL = fixtureBase.flatMap { URL(string: url.path + (url.query.map { "?" + $0 } ?? ""), relativeTo: $0)?.absoluteURL } ?? url
        var request = URLRequest(url: networkURL)
        request.httpMethod = method; request.httpBody = body?.data(using: .utf8)
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")
        if url.host == "x.com" {
            request.setValue(Self.cookieHeader(cookies, url: url), forHTTPHeaderField: "Cookie")
            if url.path.hasPrefix("/i/api/") {
                request.setValue("Bearer \(IdentityTransport.bearer)", forHTTPHeaderField: "authorization")
                request.setValue(csrf, forHTTPHeaderField: "x-csrf-token")
                request.setValue("OAuth2Session", forHTTPHeaderField: "x-twitter-auth-type")
                request.setValue("yes", forHTTPHeaderField: "x-twitter-active-user")
                request.setValue("en", forHTTPHeaderField: "x-twitter-client-language")
                request.setValue("https://x.com", forHTTPHeaderField: "Origin")
                request.setValue("https://x.com/home", forHTTPHeaderField: "Referer")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                for name in ["x-client-transaction-id", "content-type"] { if let value = headers[name] { request.setValue(value, forHTTPHeaderField: name) } }
            } else { request.setValue("text/html", forHTTPHeaderField: "Accept") }
        }
        self.request = request
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = max(0.1, min(18, timeout)); config.timeoutIntervalForResource = max(0.1, min(18, timeout))
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }
    func start(_ completion: @escaping ([String: Any], [HTTPCookie]) -> Void) {
        self.completion = completion; task = session.dataTask(with: request); task?.resume()
    }
    func cancel() { finish(ConnectionFault.value("cancelled", Self.stage(url), retryable: false)); task?.cancel(); session.invalidateAndCancel() }
    private func finish(_ result: [String: Any], cookies: [HTTPCookie] = []) {
        let done = completion; completion = nil; session.finishTasksAndInvalidate(); done?(result, cookies)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse; oversize = response.expectedContentLength > limit
        completionHandler(oversize ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if bytes.count + data.count > limit { oversize = true; dataTask.cancel() } else { bytes.append(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard completion != nil else { return }
        if oversize { finish(ConnectionFault.value("unsupported_response", Self.stage(url), retryable: false)); return }
        if let error = error {
            var fault = ConnectionFault.transport(stage: Self.stage(url), error: error)["fault"] as! [String: Any]
            fault["code"] = (error as NSError).code == NSURLErrorTimedOut ? "timeout" : "network_failure"
            finish(["fault": fault]); return
        }
        guard let response = response, let text = String(data: bytes, encoding: .utf8) else { finish(ConnectionFault.value("unsupported_response", Self.stage(url), retryable: false)); return }
        if (300..<400).contains(response.statusCode) {
            let location = response.value(forHTTPHeaderField: "Location").flatMap { URL(string: $0, relativeTo: url) }
            let code = location?.host == "x.com" && location?.path.hasPrefix("/account/access") == true ? "account_challenge" : "provider_rejection"
            finish(ConnectionFault.value(code, Self.stage(url), retryable: false, status: response.statusCode)); return
        }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            if let key = entry.key as? String, let value = entry.value as? String { result[key] = value }
        }
        let changed = url.host == "x.com" ? HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).filter { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == "x.com" } : []
        var exposed: [String: String] = [:]
        for name in ["content-type", "x-rate-limit-reset", "retry-after"] { if let value = response.value(forHTTPHeaderField: name) { exposed[name] = value } }
        finish(["status": response.statusCode, "text": text, "headers": exposed, "httpMs": min(75000, Date().timeIntervalSince(started) * 1000)], cookies: changed)
    }
}
