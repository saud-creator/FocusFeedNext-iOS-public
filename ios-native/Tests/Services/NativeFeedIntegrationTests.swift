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
    func testMalformedPhotoSettlesIntoAccessibleRetryInsteadOfLoadingForever() async throws {
        let service = try FeedFixtureServices(); service.malformedImages = true
        let item = PostMedia(kind:"image", url:"ffmedia:malformed-fixture", previewUrl:nil, width:640, height:360, alt:"Fixture photo", durationMs:nil, variants:[])
        let tile = PhotoTile(item:item, services:service)
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertTrue(tile.accessibilityValue?.contains(L10n.text("photoFailed")) == true)
        XCTAssertTrue(tile.accessibilityValue?.contains(L10n.text("retry")) == true)
        XCTAssertNotEqual(tile.accessibilityValue, L10n.text("loading"))
        let missing = PhotoTile(item:PostMedia(kind:"image", url:"", previewUrl:nil, width:nil, height:nil, alt:nil, durationMs:nil, variants:[]), services:service)
        XCTAssertTrue(missing.accessibilityValue?.contains(L10n.text("photoFailed")) == true)
    }
    func testRecoveryOpportunityRetriesOnlyFailedImagesAndAvatars() async throws {
        let service = try FeedFixtureServices(); service.failImages = true
        let item = PostMedia(kind:"image", url:"ffmedia:recovering-photo", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let tile = PhotoTile(item:item, services:service)
        let avatar = RemoteImageView(); avatar.fallbackInitials("Reader"); avatar.load("ffmedia:recovering-avatar", services:service, maxPixel:120)
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertEqual(service.imageRequests[item.url], 1)
        XCTAssertEqual(service.imageRequests["ffmedia:recovering-avatar"], 1)
        service.failImages = false
        tile.recoverIfNeeded(); avatar.recoverIfNeeded()
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertEqual(service.imageRequests[item.url], 2); XCTAssertEqual(service.imageRequests["ffmedia:recovering-avatar"], 2)
        XCTAssertNil(tile.accessibilityValue); XCTAssertNotNil(avatar.image)
        tile.recoverIfNeeded(); avatar.recoverIfNeeded()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(service.imageRequests[item.url], 2, "A healthy tile must not reload on a recovery opportunity.")
        XCTAssertEqual(service.imageRequests["ffmedia:recovering-avatar"], 2, "A healthy avatar must remain untouched.")
    }
    func testManualPhotoRetryRenewsOnceAndUsesReturnedHandle() async throws {
        let service = try FeedFixtureServices(); service.failImages = true
        let item = PostMedia(kind:"image", url:"ffmedia:retry-photo", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let tile = PhotoTile(item:item, services:service)
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertEqual(service.repairRequests.count, 0, "An initial image request is not a manual repair.")
        service.failImages = false
        tile.sendActions(for:.touchUpInside); tile.sendActions(for:.touchUpInside); tile.recoverIfNeeded()
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertEqual(service.repairRequests, [item.url], "Repeated taps must share one bounded manual repair.")
        XCTAssertEqual(service.imageRequests[item.url + "-renewed"], 1)
        XCTAssertEqual(tile.displayItem.url, item.url + "-renewed")
        XCTAssertNil(tile.accessibilityValue); XCTAssertTrue(tile.isEnabled)
    }
    func testHiddenNavigationFeedReleasesBodiesAndRehydratesOnReturn() async throws {
        let service = try FeedFixtureServices(count:300); let context = ReaderContext(services:service)
        context.preferences.set("video.autoplay", "off")
        let first = FeedViewController(context:context, route:.following)
        let navigation = UINavigationController(rootViewController:first)
        try host(navigation); try await settle(navigation)
        XCTAssertEqual(first.posts.count, 300)
        let second = FeedViewController(context:context, route:.bookmarks)
        navigation.pushViewController(second, animated:false); try await settle(navigation)
        XCTAssertTrue(first.posts.isEmpty); XCTAssertTrue(first.state.posts.isEmpty)
        XCTAssertEqual(second.posts.count, 300)
        navigation.popViewController(animated:false); try await settle(navigation)
        XCTAssertTrue(second.posts.isEmpty); XCTAssertTrue(second.state.posts.isEmpty)
        XCTAssertEqual(first.posts.count, 300, "Returning to a route must rehydrate its retained session window.")
    }
    func testMemoryPressureTrimsDistantBodiesWithoutEndingPagination() async throws {
        let service = try FeedFixtureServices(count:300); let context = ReaderContext(services:service)
        context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context:context, route:.bookmarks)
        try host(controller); try await settle(controller)
        controller.trimHydratedForMemoryPressure(); try await settle(controller)
        XCTAssertEqual(controller.state.posts.count, 80)
        XCTAssertEqual(context.timelines.state("bookmarks").posts.count, 80)
        XCTAssertEqual(controller.state.nextCachedOffset, 80)
        XCTAssertFalse(controller.state.exhausted, "Trimming bodies must leave later cached bookmarks reachable.")
    }
    func testResumeDestinationsSeparateSharedFeedsAndExcludeSearchAndComments() throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services:service)
        XCTAssertEqual(FeedViewController(context:context, route:.following).resumeDestination, "following")
        XCTAssertEqual(FeedViewController(context:context, route:.originals).resumeDestination, "originals")
        XCTAssertEqual(FeedViewController(context:context, route:.focus).resumeDestination, "focus")
        XCTAssertEqual(FeedViewController(context:context, route:.following, source:"user:reader").resumeDestination, "user:reader")
        XCTAssertEqual(FeedViewController(context:context, route:.groups, source:"group:fixture").resumeDestination, "group:fixture")
        XCTAssertNil(SearchViewController(context:context).resumeDestination)
        let comments = FeedViewController(context:context, route:.bookmarks); comments.automaticallyLoads = false
        XCTAssertNil(comments.resumeDestination, "A comments viewport must not overwrite its bookmarks marker.")
    }
    func testFailedSpeculationUsesDedicatedReadWithoutRecovery() async throws {
        let service = try FeedFixtureServices(count:30); service.failPrefetch = true
        let context = ReaderContext(services:service)
        context.runtime = ReaderRuntimeSnapshot(foreground:true, wifi:true, expensive:false, constrained:false, lowPower:false, thermal:"nominal", reduceMotion:false, reduceTransparency:false, contentSizeScale:1, memoryRevision:0)
        context.preferences.set("performance.mode", "ultra"); context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context:context); controller.automaticallyLoads = false
        try host(controller); controller.replacePosts(service.posts); try await settle(controller)
        let candidate = try prefetchCandidate(controller)
        let handle = controller.posts[candidate.item].media[0].url
        service.speculativeOnlyHandles.insert(handle)
        controller.collectionView(controller.collection, prefetchItemsAt:[candidate])
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertGreaterThan(service.prefetchRequests[handle] ?? 0, 0)
        XCTAssertEqual(service.speculationThroughVisibleLoader, 0)
        XCTAssertTrue(service.repairRequests.isEmpty)
        XCTAssertFalse(controller.posts.isEmpty)
    }
    func testVisibleCellCancelsSpeculationBeforeCreatingItsImages() async throws {
        let service = try FeedFixtureServices(count:30); service.holdPrefetch = true
        let context = ReaderContext(services:service)
        context.runtime = ReaderRuntimeSnapshot(foreground:true, wifi:true, expensive:false, constrained:false, lowPower:false, thermal:"nominal", reduceMotion:false, reduceTransparency:false, contentSizeScale:1, memoryRevision:0)
        context.preferences.set("performance.mode", "ultra"); context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context:context); controller.automaticallyLoads = false
        try host(controller); controller.replacePosts(service.posts); try await settle(controller)
        let candidate = try prefetchCandidate(controller)
        controller.collectionView(controller.collection, prefetchItemsAt:[candidate])
        for _ in 0..<10 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        let previous = service.cancelledPrefetch
        controller.collection.scrollToItem(at:candidate, at:.top, animated:false)
        try await settle(controller)
        XCTAssertGreaterThan(service.cancelledPrefetch, previous, "Visible image creation must release speculative transfer ownership.")
        XCTAssertEqual(service.speculationThroughVisibleLoader, 0)
        XCTAssertTrue(service.repairRequests.isEmpty)
    }
    func testScreenRecoveryRespectsAncestorClippingAndLeavesHealthyImagesAlone() async throws {
        let service = try FeedFixtureServices(); service.failImages = true
        let context = ReaderContext(services:service); let controller = ReaderScreen(context:context)
        try host(controller)
        let scroll = UIScrollView(frame:CGRect(x:20, y:100, width:120, height:120)); scroll.clipsToBounds = true; scroll.contentSize = CGSize(width:120, height:500); controller.view.addSubview(scroll)
        let visible = RemoteImageView(frame:CGRect(x:0, y:0, width:80, height:80)); scroll.addSubview(visible); visible.load("ffmedia:visible-header", services:service)
        let clipped = RemoteImageView(frame:CGRect(x:0, y:260, width:80, height:80)); scroll.addSubview(clipped); clipped.load("ffmedia:clipped-header", services:service)
        let item = PostMedia(kind:"image", url:"ffmedia:visible-article", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let tile = PhotoTile(item:item, services:service); tile.frame = CGRect(x:200, y:100, width:120, height:120); controller.view.addSubview(tile)
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        service.failImages = false
        NotificationCenter.default.post(name:.readerMediaRecoveryOpportunity, object:context)
        for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds:1_000_000) }
        XCTAssertEqual(service.imageRequests["ffmedia:visible-header"], 2)
        XCTAssertEqual(service.imageRequests["ffmedia:visible-article"], 2)
        XCTAssertEqual(service.imageRequests["ffmedia:clipped-header"], 1, "A descendant outside the scroll viewport must not recover merely because it has a window.")
        NotificationCenter.default.post(name:.readerMediaRecoveryOpportunity, object:context)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(service.imageRequests["ffmedia:visible-header"], 2)
        XCTAssertEqual(service.imageRequests["ffmedia:visible-article"], 2)
        XCTAssertTrue(service.repairRequests.isEmpty)
    }
    private func prefetchCandidate(_ controller: FeedViewController) throws -> IndexPath {
        let visible = controller.collection.indexPathsForVisibleItems.map(\.item)
        let last = try XCTUnwrap(visible.max())
        let runway = max(1, visible.count) * 3
        let index = controller.posts.indices.first { !visible.contains($0) && $0 > last && $0 <= last + runway && controller.posts[$0].media.first?.kind == "image" }
        return IndexPath(item:try XCTUnwrap(index), section:0)
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
    var malformedImages = false
    var failImages = false
    var imageRequests: [String: Int] = [:]
    var repairRequests: [String] = []
    var prefetchRequests: [String: Int] = [:]
    var failPrefetch = false
    var holdPrefetch = false
    var cancelledPrefetch = 0
    var speculativeOnlyHandles = Set<String>()
    var speculationThroughVisibleLoader = 0
    var failRefresh = false
    init(count: Int = 8) throws {
        let author: [String: Any] = ["id":"45", "username":"fixture_reader", "displayName":"قارئ الاختبار", "verified":false]
        let metrics: [String: Any] = ["replies":0, "reposts":0, "likes":0, "quotes":0, "views":0, "bookmarks":0]
        let values: [[String: Any]] = (0..<count).map { index in
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
        if speculativeOnlyHandles.contains(url) { speculationThroughVisibleLoader += 1 }
        imageRequests[url, default:0] += 1
        if delayImages { try await Task.sleep(nanoseconds: 25_000_000) }
        try Task.checkCancellation()
        if failImages { throw AppServiceError(code:"fixture_image_failure", message:"Controlled image failure.") }
        if malformedImages { return Data("Controlled invalid image data".utf8) }
        let image = UIGraphicsImageRenderer(size: CGSize(width:640, height:360)).image { context in UIColor.systemIndigo.setFill(); context.fill(CGRect(x:0, y:0, width:640, height:360)) }
        return try XCTUnwrap(image.pngData())
    }
    func prefetchImageData(url: String, maxPixelDimension: Int) async throws -> Data {
        prefetchRequests[url, default:0] += 1
        do {
            if holdPrefetch { try await Task.sleep(nanoseconds:30_000_000_000) }
            try Task.checkCancellation()
            if failPrefetch { throw AppServiceError(code:"fixture_prefetch_failure", message:"Controlled speculative download failure.") }
            return Data()
        } catch is CancellationError { cancelledPrefetch += 1; throw CancellationError() }
    }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { throw AppServiceError(code:"fixture", message:"Video playback is outside these layout fixtures.") }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"Viewer playback is outside these layout fixtures.") }
    func recoverMedia() async throws {}
    func recoverMediaHandle(_ handle: String) async throws -> String { repairRequests.append(handle); await Task.yield(); return handle + "-renewed" }
}
