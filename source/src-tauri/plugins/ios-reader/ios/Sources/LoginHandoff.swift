import Foundation

/// Capture and scene activation can race. Publishing credentials is independent
/// of dismissal: the login controller stays visible until the session commits.
final class LoginHandoff {
    private var captured = false
    private var settled = false
    static func permitsProviderRequest(loginOpen: Bool, authentication: Bool) -> Bool { !loginOpen || authentication }
    func didCapture() { captured = true }
    func cancel() { settled = true }
    func finish(active: Bool) -> Bool {
        guard captured, active, !settled else { return false }
        settled = true
        return true
    }
}

enum LoginNavigation {
    static func isHome(_ url: URL?) -> Bool {
        guard let url = url, ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].contains(url.host ?? "") else { return false }
        return url.path == "/home" || url.path == "/home/"
    }
    static func ignore(_ error: Error, captured: Bool) -> Bool {
        let error = error as NSError
        return captured || (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
    }
    static func recoverOnReturn(_ error: Error, captured: Bool, active: Bool) -> Bool {
        !active && !ignore(error,captured:captured)
    }
}
