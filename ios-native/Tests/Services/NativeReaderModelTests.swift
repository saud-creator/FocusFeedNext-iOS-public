import XCTest
import UIKit
@testable import FocusFeedNextNative

/// Local fixture tests only: no provider request or persistent account state.
@MainActor final class NativeReaderModelTests: XCTestCase {
    func testPageOpenOverridesFallBackWithoutUsingAnotherPagesSetting() {
        let preferences = ReaderPreferences(entries: [["pages.openBehavior", "refresh"], ["pages.openBehavior.following", "off"], ["pages.openBehavior.profile", "reset"], ["pages.openBehavior.accounts", ""]])
        XCTAssertEqual(preferences.openBehavior(for: "following"), .off)
        XCTAssertEqual(preferences.openBehavior(for: "profile"), .reset)
        XCTAssertEqual(preferences.openBehavior(for: "accounts"), .refresh, "An empty override inherits the general policy.")
        XCTAssertEqual(preferences.openBehavior(for: "groups"), .refresh)
    }
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
    func testSelfPermalinkRemovalUsesExactPostIdentityAndPreservesOtherURLs() throws {
        let own = try XCTUnwrap(URL(string: "https://x.com/Reader/status/123"))
        let otherURLs = [
            "https://x.com/reader/status/12345", "https://x.com/another/status/123",
            "https://x.com/reader/status/123/analytics", "https://x.com/reader/status/123abc",
            "https://x.com/reader/status/00123", "https://example.test/reader/status/123",
            "https://example.test/?next=https://x.com/reader/status/123", "https://x.com/reader/status/124?quote=123"
        ]
        let text = otherURLs.joined(separator: "\n\n")
        XCTAssertEqual(ReaderPostText.removingSelfPermalink(from: text, canonicalURL: own), text)
        for alias in ["https://x.com/reader/status/123", "https://twitter.com/READER/status/123?ref=feed#context", "https://www.x.com/Reader/status/123/", "http://www.twitter.com/reader/status/123"] {
            XCTAssertEqual(ReaderPostText.removingSelfPermalink(from: "Before\n\n\(alias)\n\nAfter", canonicalURL: own), "Before\n\n\n\nAfter")
        }
    }
    func testSelfPermalinkRemovalKeepsAuthoredPunctuationAndParagraphBreaks() throws {
        let own = try XCTUnwrap(URL(string: "https://x.com/reader/status/123"))
        let text = "First paragraph 👨‍👩‍👧‍👦.\n\nSecond paragraph (https://twitter.com/reader/status/123?ref=app).\n\nhttps://example.test/article."
        let expected = "First paragraph 👨‍👩‍👧‍👦.\n\nSecond paragraph ().\n\nhttps://example.test/article."
        XCTAssertEqual(ReaderPostText.removingSelfPermalink(from: text, canonicalURL: own), expected)
        XCTAssertEqual(ReaderPostText.removingSelfPermalink(from: text, canonicalURL: nil), text)
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
    func testContrastPreferenceChangesSemanticTextAndAcceptsPortableShortHex() throws {
        let background = try XCTUnwrap(ReaderTheme.color("#aabbcc"))
        XCTAssertEqual(ReaderTheme.color("#abc"), background, "Accepted portable short colors must render, not silently fall back.")
        var low = ReaderPreferences(entries: [["appearance.surface", "#f0f0f0"], ["appearance.textContrast", "0"]])
        let lowRatio = ReaderTheme.contrastRatio(ReaderTheme.text(low), ReaderTheme.surface(low), traits: UITraitCollection(userInterfaceStyle: .light))
        low.set("appearance.textContrast", "100")
        let highRatio = ReaderTheme.contrastRatio(ReaderTheme.text(low), ReaderTheme.surface(low), traits: UITraitCollection(userInterfaceStyle: .light))
        XCTAssertGreaterThan(highRatio, lowRatio)
        XCTAssertGreaterThanOrEqual(highRatio, 4.5)
    }
}
