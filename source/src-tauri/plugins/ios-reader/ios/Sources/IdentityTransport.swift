import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Identity verification does not require a WebKit document or GraphQL bootstrap.
/// This ephemeral, read-only transport never uses the system cookie jar and never
/// follows redirects (CSRF headers must not travel to another origin).
final class IdentityTransport: NSObject, URLSessionDataDelegate {
    static let bearer = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
    static let paths = ["/i/api/1.1/account/multi/list.json", "/i/api/1.1/account/verify_credentials.json?include_entities=false&skip_status=true"]
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var bytes = Data()
    private var oversize = false
    private var completion: (([String: Any], [HTTPCookie]) -> Void)?
    private var index = 0
    private var retries = 0
    private let baseURL: URL
    private let expectedUserId: String?
    private var csrf: String
    private let started = Date()
    private var cookies: [HTTPCookie]
    var observed: ((Int, Int?) -> Void)?

    init(cookies: [HTTPCookie], csrf: String, expectedUserId: String? = nil, baseURL: URL = URL(string: "https://x.com")!) {
        self.cookies = cookies; self.csrf = csrf; self.expectedUserId = expectedUserId; self.baseURL = baseURL
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 18
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }
    func start(_ completion: @escaping ([String: Any], [HTTPCookie]) -> Void) {
        self.completion = completion; send()
    }
    func cancel() {
        completion = nil; task?.cancel(); session.invalidateAndCancel()
    }
    private func send() {
        guard completion != nil else { return }
        response = nil; bytes = Data(); oversize = false
        let url = URL(string: Self.paths[index], relativeTo: baseURL)!.absoluteURL
        var request = URLRequest(url: url)
        request.setValue("Bearer \(Self.bearer)", forHTTPHeaderField: "authorization")
        request.setValue(csrf, forHTTPHeaderField: "x-csrf-token")
        request.setValue("OAuth2Session", forHTTPHeaderField: "x-twitter-auth-type")
        request.setValue("yes", forHTTPHeaderField: "x-twitter-active-user")
        request.setValue("en", forHTTPHeaderField: "x-twitter-client-language")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let applicable = cookies.filter { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return url.host == domain && url.path.hasPrefix(cookie.path) && (!cookie.isSecure || url.scheme == "https") && (cookie.expiresDate == nil || cookie.expiresDate! > Date())
        }
        request.setValue(HTTPCookie.requestHeaderFields(with: applicable)["Cookie"], forHTTPHeaderField: "Cookie")
        task = session.dataTask(with: request); task?.resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        oversize = response.expectedContentLength > 524288
        completionHandler(oversize ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if bytes.count + data.count > 524288 { oversize = true; dataTask.cancel() }
        else { bytes.append(data) }
    }
    static func definitive(status: Int, body: Any) -> Bool {
        let errors = (body as? [String: Any])?["errors"] as? [[String: Any]] ?? []
        return status == 401 || status == 429 || errors.contains { [32, 89, 215, 326, 88].contains($0["code"] as? Int ?? 0) }
    }
    static func hasIdentity(_ body: Any, expectedUserId: String? = nil) -> Bool {
        let dictionary = body as? [String: Any]
        let rows = dictionary?["users"] as? [[String: Any]] ?? body as? [[String: Any]] ?? (dictionary.map { [$0] } ?? [])
        let users = rows.map { $0["user"] as? [String: Any] ?? $0 }
        func id(_ user: [String: Any]) -> String? {
            for key in ["user_id","id_str","rest_id","id"] {
                if let value = user[key] as? String { return value }
                if let value = user[key] as? NSNumber { return value.stringValue }
            }
            return nil
        }
        let candidates: [[String: Any]]
        if let expected = expectedUserId { candidates = users.filter { id($0) == expected } }
        else {
            let active = users.filter { $0["is_active"] as? Bool == true }
            candidates = active.count == 1 ? active : users
        }
        guard candidates.count == 1, let user = candidates.first, let value = id(user), !value.isEmpty,
              value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let username = user["screen_name"] as? String, !username.isEmpty, username.count <= 15 else { return false }
        return username.utf8.allSatisfy { ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard completion != nil else { return }
        let status = response?.statusCode ?? 0
        let body = (try? JSONSerialization.jsonObject(with: bytes)) ?? [:]
        observed?(index, status == 0 ? nil : status)
        if !oversize && (error != nil || [502,503,504].contains(status)), retries == 0 {
            retries += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.send() }; return
        }
        if error == nil, let response = response, let url = response.url {
            let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
                if let name = entry.key as? String, let value = entry.value as? String { result[name] = value }
            }
            let updated = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
            for cookie in updated {
                cookies.removeAll { $0.name == cookie.name && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) && $0.path == cookie.path }
                cookies.append(cookie)
                if cookie.name == "ct0", cookie.path == "/", cookie.expiresDate == nil || cookie.expiresDate! > Date() { csrf = cookie.value }
            }
        }
        if error == nil, !oversize, !Self.definitive(status: status, body: body),
           !(200..<300).contains(status) || !Self.hasIdentity(body,expectedUserId:expectedUserId), index == 0 {
            index = 1; send(); return
        }
        var result: [String: Any] = ["status": status, "body": body]
        if oversize { result = ConnectionFault.value("unsupported_response", "identity", retryable: false) }
        else if let error = error {
            result = ConnectionFault.transport(stage: "identity", error: error)
            var fault = result["fault"] as! [String: Any]
            fault["code"] = (error as NSError).code == NSURLErrorTimedOut ? "timeout" : "network_failure"
            result["fault"] = fault
        }
        result["identityMs"] = min(75000, max(0, Date().timeIntervalSince(started) * 1000))
        let done = completion; completion = nil; session.finishTasksAndInvalidate()
        done?(result, cookies)
    }
}
