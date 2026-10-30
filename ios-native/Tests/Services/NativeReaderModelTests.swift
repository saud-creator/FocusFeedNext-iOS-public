import XCTest
@testable import FocusFeedNextNative

/// Local fixture tests only: no provider request or persistent account state.
@MainActor final class NativeReaderModelTests: XCTestCase {
    func testPreferenceImportRejectsNonFiniteAndUnknownValuesBeforePreview() throws {
        let current = ReaderPreferences()
        for entries in [[["reading.size", "NaN"]], [["reading.size", "infinity"]], [["auth_token", "not-a-real-token"]], [["reading.size", "100"], ["reading.size", "110"]], [["monitoring.intervalMinutes", "5.5"]], [["video.autoplay", "anything"]], [["navigation.tabs", "[\"following\",\"following\",\"bookmarks\",\"accounts\"]"]]] {
            XCTAssertThrowsError(try PreferenceDocument(version: 1, preferences: entries).validated(over: current))
        }
        XCTAssertThrowsError(try PreferenceDocument(version: 2, preferences: []).validated(over: current))
        XCTAssertEqual(current.number("reading.size"), 100, "Rejected import must not mutate the original draft.")
    }
    func testPortablePreferencesExcludePermissionsAndAcceptKnownFields() throws {
        let current = ReaderPreferences()
        let keys = Set(current.portableEntries.map { $0[0] })
        XCTAssertFalse(keys.contains("actions.allowUnfollow")); XCTAssertFalse(keys.contains("actions.advanced"))
        XCTAssertFalse(keys.contains("startup.preloadBookmarks"))
        let imported = try PreferenceDocument(version: 1, preferences: [["theme", "oled"], ["reading.size", "120"], ["navigation.tabs", "[\"originals\",\"focus\",\"bookmarks\",\"search\"]"]]).validated(over: current)
        XCTAssertEqual(imported.string("theme"), "oled"); XCTAssertEqual(imported.number("reading.size"), 120)
        XCTAssertEqual(imported.tabs, [.originals, .focus, .bookmarks, .search])
        XCTAssertEqual(imported.bool("actions.allowUnfollow"), current.bool("actions.allowUnfollow"))
    }
    func testTextCollapsePreservesParagraphsAndNeverSplitsURLOrComposedCharacter() {
        let text = "First paragraph.\n\nSecond paragraph 👨‍👩‍👧‍👦 https://example.test/a-long-path more words"
        XCTAssertEqual(ReaderPostText.display(text, collapsed: false, limit: 3), text)
        let marker = text.range(of: "https://")!.lowerBound
        let cutoff = text.distance(from: text.startIndex, to: marker) + 12
        let collapsed = ReaderPostText.display(text, collapsed: true, limit: cutoff)
        XCTAssertEqual(collapsed, String(text[..<marker]) + "…")
        XCTAssertTrue(collapsed.contains("\n\n")); XCTAssertTrue(collapsed.contains("👨‍👩‍👧‍👦"))
        XCTAssertFalse(collapsed.contains("https://"))
    }
    func testPostModelDecodesCanonicalCoreShapeAndCommentFilterIsExplicit() throws {
        let json = #"{"id":"123","text":"A reply","author":{"id":"45","username":"reader","displayName":"Reader","verified":false},"createdAt":"2026-10-30T10:00:00Z","isRepost":false,"isPromoted":false,"metrics":{"replies":0,"reposts":0,"likes":0,"quotes":0,"views":0,"bookmarks":0},"media":[],"isArticle":false,"inReplyTo":"122","provider":"ios-direct"}"#
        let reply = try JSONDecoder().decode(Post.self, from: Data(json.utf8))
        XCTAssertEqual(reply.canonicalURL?.absoluteString, "https://x.com/reader/status/123")
        XCTAssertFalse(FeedFilters().accepts(reply, read: false))
        XCTAssertTrue(FeedFilters().accepts(reply, read: false, includeReplies: true))
        var promoted = reply; promoted.isPromoted = true
        XCTAssertFalse(FeedFilters().accepts(promoted, read: false, includeReplies: true))
        var filters = FeedFilters(); filters.unreadOnly = true
        XCTAssertFalse(filters.accepts(reply, read: true, includeReplies: true))
    }
    func testFeedPagingMetadataDecodesAndPreservesEvictedBodyIDs() throws {
        let json = #"{"posts":[],"fromCache":true,"provider":"ios-direct","readIds":[],"totalCached":400,"nextOffset":80,"missingPostIds":["124"]}"#
        let page = try JSONDecoder().decode(FeedResponse.self, from: Data(json.utf8))
        XCTAssertEqual(page.nextOffset, 80); XCTAssertEqual(page.missingPostIds, ["124"])
        XCTAssertEqual(page.totalCached, 400); XCTAssertNil(page.nextCursor)
    }
}
