import XCTest
import UIKit
@testable import FocusFeedNextNative

@MainActor final class NativeClipboardTests: XCTestCase {
    func testCopySuccessRequiresMatchingReadback() throws {
        let pasteboard = FixtureClipboard()
        XCTAssertTrue(ReaderClipboard.copyText("Authored text\n\nفقرة أخرى", to:pasteboard, announce:false))
        let url = try XCTUnwrap(URL(string:"https://x.com/reader/status/123"))
        XCTAssertTrue(ReaderClipboard.copyURL(url, to:pasteboard, announce:false))
        pasteboard.rejectWrites = true
        XCTAssertFalse(ReaderClipboard.copyText("A different value", to:pasteboard, announce:false))
        XCTAssertFalse(ReaderClipboard.copyURL(try XCTUnwrap(URL(string:"https://x.com/reader/status/124")), to:pasteboard, announce:false))
    }
}

@MainActor private final class FixtureClipboard: ReaderClipboardStore {
    var rejectWrites = false
    private var text: String?
    private var link: URL?
    var string: String? { get { text } set { if !rejectWrites { text = newValue } } }
    var url: URL? { get { link } set { if !rejectWrites { link = newValue } } }
}
