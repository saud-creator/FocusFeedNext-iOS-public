import UIKit

@MainActor protocol ReaderClipboardStore: AnyObject {
    var string: String? { get set }
    var url: URL? { get set }
}
extension UIPasteboard: ReaderClipboardStore {}

@MainActor enum ReaderClipboard {
    @discardableResult static func copyText(_ text: String, to store: ReaderClipboardStore? = nil, announce: Bool = true) -> Bool {
        let target = store ?? UIPasteboard.general
        target.string = text
        let copied = target.string == text
        if announce { UIAccessibility.post(notification: .announcement, argument: L10n.text(copied ? "copied" : "copyFailed")) }
        return copied
    }
    @discardableResult static func copyURL(_ url: URL, to store: ReaderClipboardStore? = nil, announce: Bool = true) -> Bool {
        let target = store ?? UIPasteboard.general
        target.url = url
        let copied = target.url == url
        if announce { UIAccessibility.post(notification: .announcement, argument: L10n.text(copied ? "copied" : "copyFailed")) }
        return copied
    }
}
