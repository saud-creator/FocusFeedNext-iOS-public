import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

/// Injected local fixture traffic exercises the production collection/cells.
/// It is not evidence of live X, actual network latency, or physical-device FPS.
@MainActor final class NativeFeedIntegrationTests: XCTestCase {
    private var window: UIWindow?
    private var previousWindow: UIWindow?
    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil; window = nil
        previousWindow?.makeKeyAndVisible(); previousWindow = nil; L10n.language = "system"
        super.tearDown()
    }
    private func host(_ controller: UIViewController, size: CGSize = CGSize(width: 390, height: 844), largeText: Bool = false) throws {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = try XCTUnwrap(scenes.first { $0.activationState == .foregroundActive } ?? scenes.first)
        previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene); window.frame = CGRect(origin: .zero, size: size)
        let shell = UIViewController(); shell.addChild(controller); shell.view.addSubview(controller.view)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([controller.view.leadingAnchor.constraint(equalTo: shell.view.leadingAnchor), controller.view.trailingAnchor.constraint(equalTo: shell.view.trailingAnchor), controller.view.topAnchor.constraint(equalTo: shell.view.topAnchor), controller.view.bottomAnchor.constraint(equalTo: shell.view.bottomAnchor)])
        controller.didMove(toParent: shell)
        if largeText { shell.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge), forChild: controller) }
        window.rootViewController = shell; self.window = window; window.makeKeyAndVisible(); shell.view.layoutIfNeeded()
    }
    private func settle(_ controller: UIViewController, attempts: Int = 20) async throws {
        for _ in 0..<attempts { controller.view.setNeedsLayout(); controller.view.layoutIfNeeded(); await Task.yield(); try await Task.sleep(nanoseconds: 2_000_000) }
    }
    func testReturnedFirstPageHasVisibleNativeContentWithin250Milliseconds() async throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context: context); controller.automaticallyLoads = false
        try host(controller); controller.view.layoutIfNeeded()
        // The shell exists before the page returns. Include snapshot and cell
        // construction, layout, and the first visible production post cell.
        let returned = ProcessInfo.processInfo.systemUptime
        controller.replacePosts(service.posts)
        var firstVisible: TimeInterval?
        for _ in 0..<80 {
            controller.view.layoutIfNeeded(); await Task.yield()
            if controller.collection.visibleCells.contains(where: { !$0.frame.intersection(controller.collection.bounds).isEmpty }) { firstVisible = ProcessInfo.processInfo.systemUptime; break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        let visible = try XCTUnwrap(firstVisible, "Returned posts must become visible, not remain skeletons.")
        let milliseconds = (visible - returned) * 1000
        XCTContext.runActivity(named: "Controlled returned-data to visible native content: \(milliseconds) ms") { _ in }
        XCTAssertLessThanOrEqual(milliseconds, 250, "Keep the agreed response-to-content boundary; shell/provider time is separate.")
        XCTAssertTrue(controller.collection.visibleCells.contains { $0.accessibilityIdentifier?.hasPrefix("post.") == true })
    }
    func testArabicLargeTextCellsRemainSeparatedAfterDelayedImageAndResize() async throws {
        L10n.language = "ar"
        let service = try FeedFixtureServices(); service.delayImages = true
        let context = ReaderContext(services: service); context.preferences.set("language", "ar"); context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context: context); controller.automaticallyLoads = false
        try host(controller, largeText: true); controller.replacePosts(service.posts); try await settle(controller)
        try assertSeparated(controller)
        controller.collection.setContentOffset(CGPoint(x: 0, y: 600), animated: false); try await settle(controller)
        try assertSeparated(controller)
        // A logical landscape-size fixture, distinct from a physical rotation.
        window?.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
        controller.collection.collectionViewLayout.invalidateLayout(); try await settle(controller)
        try assertSeparated(controller)
        XCTAssertEqual(controller.view.semanticContentAttribute, .forceRightToLeft)
    }
    func testFailedRefreshKeepsLoadedPostsAndReadingAnchor() async throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context: context); controller.automaticallyLoads = false
        try host(controller); controller.replacePosts(service.posts); try await settle(controller)
        controller.collection.setContentOffset(CGPoint(x: 0, y: 280), animated: false); controller.view.layoutIfNeeded()
        let ids = controller.posts.map(\.id); let offset = controller.collection.contentOffset.y
        service.failRefresh = true; controller.load(refresh: true); try await settle(controller)
        XCTAssertEqual(controller.posts.map(\.id), ids, "A failed refresh cannot erase already readable posts.")
        XCTAssertEqual(controller.collection.contentOffset.y, offset, accuracy: 3)
        XCTAssertFalse(controller.notice.isHidden)
        XCTAssertTrue(controller.notice.label.text?.contains("fixture") == true)
    }
    private func assertSeparated(_ controller: FeedViewController) throws {
        let paths = controller.collection.indexPathsForVisibleItems.sorted()
        XCTAssertFalse(paths.isEmpty)
        let frames = paths.compactMap { controller.collection.layoutAttributesForItem(at: $0)?.frame }
        for pair in zip(frames, frames.dropFirst()) { XCTAssertLessThanOrEqual(pair.0.maxY, pair.1.minY + 1, "Dynamic content must not overlap adjacent post cards.") }
        for frame in frames { XCTAssertGreaterThan(frame.height, 0); XCTAssertGreaterThanOrEqual(frame.minX, -1); XCTAssertLessThanOrEqual(frame.maxX, controller.collection.bounds.width + 1) }
    }
}

@MainActor private final class FeedFixtureServices: AppServices {
    let accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    let posts: [Post]
    var delayImages = false
    var failRefresh = false
    init() throws {
        let author: [String: Any] = ["id":"45", "username":"fixture_reader", "displayName":"قارئ الاختبار", "verified":false]
        let metrics: [String: Any] = ["replies":0, "reposts":0, "likes":0, "quotes":0, "views":0, "bookmarks":0]
        let values: [[String: Any]] = (0..<8).map { index in
            ["id":String(1000 + index), "text":"فقرة عربية للاختبار مع English واسم @reader.\n\nAnother authored paragraph with composed characters 👨‍👩‍👧‍👦.", "author":author, "createdAt":"2026-10-30T10:00:00Z", "isRepost":false, "isPromoted":false, "metrics":metrics, "media": index % 2 == 0 ? [["kind":"image", "url":"ffmedia:fixture\(index)", "width":640, "height":360, "variants":[]]] : [], "isArticle":false, "provider":"fixture"]
        }
        posts = try JSONDecoder().decode([Post].self, from: JSONSerialization.data(withJSONObject: values))
    }
    func perform(_ request: AppRequest) async throws -> Data {
        switch request.operation {
        case .refreshFeed, .loadFeedPage:
            if failRefresh { throw AppServiceError(code:"fixture_failure", message:"Controlled fixture refresh failure", retryable:true) }
            return try JSONEncoder().encode(FeedResponse(posts:posts, fromCache:false, provider:"fixture", lastSync:nil, readIds:[], totalCached:posts.count, nextCursor:nil))
        case .cachedFeed: return try JSONEncoder().encode(FeedResponse(posts:posts, fromCache:true, provider:"fixture", lastSync:nil, readIds:[], totalCached:posts.count, nextCursor:nil))
        case .setRead, .hidePost: return Data("null".utf8)
        case .resumeState: return Data("null".utf8)
        default: throw AppServiceError(code:"fixture_unexpected_operation", message:"The fixture does not implement this operation.")
        }
    }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw AppServiceError(code:"fixture", message:"Fixture tests never sign in.") }
    func mediaURL(for handle: String) async throws -> URL { throw AppServiceError(code:"fixture", message:"Fixture media never uses a network URL.") }
    func imageData(url: String, maxPixelDimension: Int) async throws -> Data {
        if delayImages { try await Task.sleep(nanoseconds: 25_000_000) }
        try Task.checkCancellation()
        let image = UIGraphicsImageRenderer(size: CGSize(width:640, height:360)).image { context in UIColor.systemIndigo.setFill(); context.fill(CGRect(x:0, y:0, width:640, height:360)) }
        return try XCTUnwrap(image.pngData())
    }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { throw AppServiceError(code:"fixture", message:"Video playback is outside these layout fixtures.") }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"Viewer playback is outside these layout fixtures.") }
    func recoverMedia() async throws {}
}
