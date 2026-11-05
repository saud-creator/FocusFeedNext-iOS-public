import Foundation
import WebKit

// The engine needs an HTTPS origin, not a second copy of X's application.
// This app-owned document has no page scripts, frames, or external resources.
// Provider HTML is subsequently fetched as data and parsed without executing it.
enum TransportDocument {
    static let baseURL = URL(string: "https://x.com/")!
    static let html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>"
    static let originCheck = "globalThis.origin === 'https://x.com' && document.baseURI === 'https://x.com/'"
    @discardableResult static func load(in view: WKWebView, baseURL: URL = baseURL) -> WKNavigation? {
        view.loadHTMLString(html, baseURL: baseURL)
    }
    static func permitsNavigation(_ url: URL?, bootstrapping: Bool) -> Bool {
        guard bootstrapping, let url = url else { return false }
        return url.absoluteString == baseURL.absoluteString || url.absoluteString == "about:blank"
    }
}
