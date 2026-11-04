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
        let snapshotReturned = ProcessInfo.processInfo.systemUptime
        var firstVisible: TimeInterval?
        for _ in 0..<80 {
            controller.view.layoutIfNeeded()
            controller.collection.layoutIfNeeded()
            if controller.collection.visibleCells.contains(where: { !$0.frame.intersection(controller.collection.bounds).isEmpty }) {
                firstVisible = ProcessInfo.processInfo.systemUptime
                break
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        let visible = try XCTUnwrap(firstVisible, "Returned posts must become visible, not remain skeletons.")
        let milliseconds = (visible - returned) * 1000
        XCTContext.runActivity(named: "Controlled returned-data to visible native content: \(milliseconds) ms") { _ in }
        let snapshotMs = (snapshotReturned - returned) * 1000
        XCTContext.runActivity(named: "Snapshot update: \(snapshotMs) ms; layout and visibility: \(milliseconds - snapshotMs) ms") { _ in }
        XCTAssertLessThanOrEqual(milliseconds, 250, "Keep the agreed response-to-content boundary; shell/provider time is separate.")
        XCTAssertTrue(controller.collection.visibleCells.contains { $0.accessibilityIdentifier?.hasPrefix("post.") == true })
    }
    func testSavedFollowingDefaultsFilterContentWithoutOverridingExplicitEditsOrFocus() async throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services: service)
        context.preferences.set("content.hideReposts", "true"); context.preferences.set("content.unreadOnly", "true"); context.preferences.set("video.autoplay", "off")
        var posts = service.posts; posts[0].isRepost = true
        let following = FeedViewController(context: context); following.automaticallyLoads = false
        try host(following); following.replacePosts(posts, readIDs: [posts[1].id]); try await settle(following)
        XCTAssertFalse(following.posts.contains { $0.id == posts[0].id || $0.id == posts[1].id })
        following.filters.hideReposts = false; following.filters.unreadOnly = false; following.apply()
        context.changed(); try await settle(following)
        XCTAssertEqual(following.posts.count, posts.count, "A later preference/runtime publish must not undo explicit filter choices.")
        context.preferences.set("content.hideReposts", "false"); context.preferences.set("content.unreadOnly", "false")
        let focus = FeedViewController(context: context, route: .focus)
        XCTAssertTrue(focus.filters.hideReposts); XCTAssertTrue(focus.filters.unreadOnly)
        XCTAssertEqual(ProfileViewController(context: context, username: "reader").pagePreferenceKey, "profile")
    }
    func testPeoplePageRefreshOverrideAndTabHapticPreferenceHaveRealEffects() async throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services: service)
        context.preferences.set("pages.openBehavior", "off"); context.preferences.set("pages.openBehavior.accounts", "refresh")
        let people = PeopleViewController(context: context); try host(people); try await settle(people)
        XCTAssertEqual(service.followingSyncRequests, 1, "An explicit People refresh override starts a traversal even for a complete snapshot.")
        var selections = 0
        let tabs = NativeTabs(context: context, selectionFeedback: { selections += 1 })
        context.preferences.set("appearance.haptics", "false"); tabs.tabBarController(tabs, didSelect: people)
        XCTAssertEqual(selections, 0)
        context.preferences.set("appearance.haptics", "true"); tabs.tabBarController(tabs, didSelect: people)
        XCTAssertEqual(selections, 1)
    }
    func testDeepWindowRetapLoadsActualBeginningAndReturnsToStablePostAfterRefresh() async throws {
        let service = try FeedFixtureServices(count: 500); service.paginatedCache = true
        let context = ReaderContext(services: service); context.preferences.set("video.autoplay", "off")
        let controller = FeedViewController(context: context, route: .bookmarks)
        try host(controller); try await settle(controller)
        var deep = TimelineRepository.State(); deep.posts = Array(service.posts[160..<460]); deep.windowStart = 160; deep.nextCachedOffset = 460
        context.timelines.retainWorkingSet("bookmarks", deep); NotificationCenter.default.post(name: .readerContentChanged, object: context); try await settle(controller)
        let anchor = try XCTUnwrap(controller.firstAnchor())
        controller.returnToTop(); try await settle(controller)
        XCTAssertEqual(controller.state.windowStart, 0)
        XCTAssertEqual(controller.posts.first?.id, service.posts.first?.id, "Re-tap must reach the complete feed's beginning, not the first retained row.")
        var newer = service.posts[0]; newer.id = "999"; service.newerPosts = [newer]
        controller.refreshTapped(); try await settle(controller)
        XCTAssertEqual(controller.posts.first?.id, "999")
        let returnAction = try XCTUnwrap(controller.notice.retry, "Return must remain available after a refresh changes row positions.")
        returnAction(); try await settle(controller)
        let restored = try XCTUnwrap(controller.posts.firstIndex { $0.id == anchor.0 })
        let attributes = try XCTUnwrap(controller.collection.layoutAttributesForItem(at: IndexPath(item: restored, section: 0)))
        XCTAssertEqual(controller.collection.contentOffset.y - attributes.frame.minY, anchor.1, accuracy: 3, "Return restores the same post and intra-item place, not a stale CGPoint.")
        XCTAssertLessThanOrEqual(controller.state.posts.count, 300)
    }
    func testLaunchResumeSharesThreeReadBudgetWithInitialPageAndManualPagingIsUnrestricted() async throws {
        let service = try FeedFixtureServices(count: 500); service.providerPaging = true
        let account = try XCTUnwrap(service.posts.first?.author)
        service.resumeMarker = ResumeState(enabled: true, route: "bookmarks", postID: "9999999", offset: 0, accountID: account.id)
        let context = ReaderContext(services: service); context.preferences.set("video.autoplay", "off")
        context.session = SessionSnapshot(state: "connected", reason: "ok", checking: false, account: account, checkedAt: nil, lastSuccessAt: nil, latencyMs: nil, hasCredentials: true, detail: nil)
        let controller = FeedViewController(context: context, route: .bookmarks)
        try host(controller); try await settle(controller, attempts: 40)
        XCTAssertEqual(service.providerOffsets.count, 3, "Initial loading and saved-marker search share one three-request allowance.")
        XCTAssertFalse(controller.posts.isEmpty)
        XCTAssertEqual(controller.notice.label.text, L10n.text("resumeUnavailable"))
        controller.load(refresh: false); try await settle(controller)
        XCTAssertEqual(service.providerOffsets.count, 4, "A user's next paging action runs outside automatic restoration's allowance.")
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
    func testRetainedAppearanceSettingsAffectRenderedNativeCardAndMedia() async throws {
        let service = try FeedFixtureServices(); let context = ReaderContext(services: service)
        context.preferences = ReaderPreferences(entries: [["density", "compact"], ["appearance.shadow", "strong"], ["appearance.radius", "8"], ["appearance.surface", "#fafafa"], ["appearance.elevated", "#eeeeee"], ["appearance.border", "#224466"], ["appearance.mediaBackground", "#112233"], ["video.autoplay", "off"]])
        let controller = FeedViewController(context: context); controller.automaticallyLoads = false
        try host(controller); controller.replacePosts(service.posts); try await settle(controller)
        let cell = try XCTUnwrap(controller.collection.visibleCells.compactMap { $0 as? PostCell }.first { $0.representedPostID == service.posts.first?.id })
        XCTAssertEqual(cell.contentView.backgroundColor, ReaderTheme.color("#fafafa"))
        XCTAssertEqual(cell.contentView.layer.cornerRadius, 14)
        XCTAssertGreaterThan(cell.contentView.layer.shadowOpacity, 0.1)
        XCTAssertEqual(UIColor(cgColor: try XCTUnwrap(cell.contentView.layer.borderColor)), ReaderTheme.color("#224466"))
        let stack = try XCTUnwrap(cell.contentView.subviews.compactMap { $0 as? UIStackView }.first)
        XCTAssertEqual(stack.spacing, 8)
        func photo(in root: UIView) -> PhotoTile? { if let tile = root as? PhotoTile { return tile }; for child in root.subviews { if let tile = photo(in: child) { return tile } }; return nil }
        let tile = try XCTUnwrap(photo(in: cell)); XCTAssertEqual(tile.backgroundColor, ReaderTheme.color("#112233"))
        context.preferences.set("appearance.shadow", "none"); cell.updateAppearance(context.preferences)
        XCTAssertEqual(cell.contentView.layer.shadowOpacity, 0)
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
    func testPhotoDecoderReturnsDownsampledBitmapAtItsCacheCost() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 360), format: format)
        let data = renderer.pngData { context in
            UIColor.systemIndigo.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
        }
        let decoded = try NativeMediaService.downsample(data, maximum: 256)
        let bitmap = try XCTUnwrap(decoded.image.cgImage)
        XCTAssertEqual(max(bitmap.width, bitmap.height), 256)
        XCTAssertEqual(decoded.cost, bitmap.bytesPerRow * bitmap.height)
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
    func testEarlierListWindowUsesListCacheAndPreservesMemberProgress() async throws {
        let service = try FeedFixtureServices(count: 400); let context = ReaderContext(services: service)
        var window = TimelineRepository.State()
        window.posts = Array(service.posts[160..<320]); window.windowStart = 160
        window.groupOffset = 7; window.groupComplete = false
        context.timelines.retainWorkingSet("group:fixture-list", window)
        let earlier = try await context.timelines.earlier("group:fixture-list")
        XCTAssertEqual(service.groupCacheOffsets, [80])
        XCTAssertEqual(earlier.windowStart, 80)
        XCTAssertEqual(earlier.posts.first?.id, service.posts[80].id)
        XCTAssertEqual(earlier.posts.last?.id, service.posts[319].id)
        XCTAssertEqual(earlier.groupOffset, 7, "Revisiting cached rows must not advance member traversal.")
        XCTAssertFalse(earlier.groupComplete)
    }
    func testSearchCanRevisitEarlierResultsAfterItsWorkingWindowIsTrimmed() async throws {
        let service = try FeedFixtureServices(count: 500); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = SearchViewController(context: context)
        try host(controller)
        let search = try XCTUnwrap(controller.navigationItem.searchController)
        search.searchBar.text = "fixture"; controller.updateSearchResults(for: search)
        try await Task.sleep(nanoseconds: 230_000_000); try await settle(controller)
        for _ in 0..<4 {
            let last = max(0, controller.posts.count - 1)
            controller.collectionView(controller.collection, willDisplay: UICollectionViewCell(frame: .zero), forItemAt: IndexPath(item: last, section: 0))
            try await settle(controller)
        }
        XCTAssertLessThanOrEqual(controller.posts.count, 300)
        XCTAssertNotEqual(controller.posts.first?.id, service.posts.first?.id, "The fixture must have crossed the bounded working window.")
        let requestsBefore = service.searchOffsets.count
        for _ in 0..<5 {
            controller.collection.setContentOffset(CGPoint(x: 0, y: -controller.collection.adjustedContentInset.top), animated: false)
            controller.loadEarlierIfNeeded(); try await settle(controller)
            if controller.posts.first?.id == service.posts.first?.id { break }
        }
        XCTAssertGreaterThan(service.searchOffsets.count, requestsBefore)
        XCTAssertEqual(controller.posts.first?.id, service.posts.first?.id, "A memory budget must not become a search-result ceiling.")
        XCTAssertLessThanOrEqual(controller.posts.count, 300)
        XCTAssertEqual(Set(controller.posts.map(\.id)).count, controller.posts.count)
    }
    func testDeepSearchRetapReturnsToFirstResultAndStablePlaceAfterRefresh() async throws {
        let service = try FeedFixtureServices(count: 500); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = SearchViewController(context: context)
        try await loadDeepSearch(controller)
        let anchor = try XCTUnwrap(controller.firstAnchor())
        XCTAssertNotEqual(controller.posts.first?.id, service.posts.first?.id)
        controller.returnToTop(); try await settle(controller)
        XCTAssertEqual(controller.posts.first?.id, service.posts.first?.id, "Search re-tap must reach the complete result set's beginning.")
        var newer = service.posts[0]; newer.id = "999"; service.newerPosts = [newer]
        controller.refreshTapped(); try await settle(controller)
        XCTAssertEqual(controller.posts.first?.id, "999")
        let returnAction = try XCTUnwrap(controller.notice.retry)
        returnAction(); try await settle(controller)
        let index = try XCTUnwrap(controller.posts.firstIndex { $0.id == anchor.0 })
        let attributes = try XCTUnwrap(controller.collection.layoutAttributesForItem(at: IndexPath(item: index, section: 0)))
        XCTAssertEqual(controller.collection.contentOffset.y - attributes.frame.minY, anchor.1, accuracy: 3)
        XCTAssertLessThanOrEqual(controller.posts.count, 300)
    }
    func testDelayedSearchReturnCannotReplaceAnEditedQuery() async throws {
        let service = try FeedFixtureServices(count: 500); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = SearchViewController(context: context)
        try await loadDeepSearch(controller)
        controller.returnToTop(); try await settle(controller)
        service.holdNextSearch = true
        defer { service.completeHeldSearch() }
        try XCTUnwrap(controller.notice.retry)(); try await awaitHeldSearch(service, controller: controller)
        service.emptySearchQueries.insert("replacement")
        let search = try XCTUnwrap(controller.navigationItem.searchController)
        search.searchBar.text = "replacement"; controller.updateSearchResults(for: search)
        try await Task.sleep(nanoseconds: 230_000_000); try await settle(controller)
        service.completeHeldSearch(); try await settle(controller)
        XCTAssertEqual(controller.highlightedText, "replacement")
        XCTAssertTrue(controller.posts.isEmpty, "A late return response must not replace the new query's results.")
        XCTAssertNotEqual(controller.notice.label.text, L10n.text("returnPlace"))
    }
    func testDelayedSearchReturnCannotRepopulateADisconnectedAccount() async throws {
        let service = try FeedFixtureServices(count: 500); let context = ReaderContext(services: service)
        context.preferences.set("video.autoplay", "off")
        let controller = SearchViewController(context: context)
        try await loadDeepSearch(controller)
        controller.returnToTop(); try await settle(controller)
        service.holdNextSearch = true
        defer { service.completeHeldSearch() }
        try XCTUnwrap(controller.notice.retry)(); try await awaitHeldSearch(service, controller: controller)
        service.accountGeneration &+= 1; context.changed()
        service.completeHeldSearch(); try await settle(controller)
        XCTAssertTrue(controller.posts.isEmpty)
        XCTAssertEqual(controller.navigationItem.searchController?.searchBar.text, "")
        XCTAssertNotEqual(controller.notice.label.text, L10n.text("returnPlace"))
    }
    private func loadDeepSearch(_ controller: SearchViewController) async throws {
        try host(controller)
        let search = try XCTUnwrap(controller.navigationItem.searchController)
        search.searchBar.text = "fixture"; controller.updateSearchResults(for: search)
        try await Task.sleep(nanoseconds: 230_000_000); try await settle(controller)
        for _ in 0..<4 {
            controller.collectionView(controller.collection, willDisplay: UICollectionViewCell(frame: .zero), forItemAt: IndexPath(item: max(0, controller.posts.count - 1), section: 0))
            try await settle(controller)
        }
    }
    private func awaitHeldSearch(_ service: FeedFixtureServices, controller: UIViewController) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while service.pendingSearch == nil, ProcessInfo.processInfo.systemUptime < deadline { try await settle(controller, attempts: 1) }
        _ = try XCTUnwrap(service.pendingSearch, "The controlled return request must be in flight before changing its identity.")
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
    var accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    let posts: [Post]
    private let fixtureImage: UIImage
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
    var groupCacheOffsets: [Int] = []
    var searchOffsets: [Int] = []
    var holdNextSearch = false
    var pendingSearch: CheckedContinuation<Void, Never>?
    var emptySearchQueries: Set<String> = []
    var cachedOffsets: [Int] = []
    var paginatedCache = false
    var providerPaging = false
    var providerOffsets: [Int] = []
    var newerPosts: [Post] = []
    var resumeMarker: ResumeState?
    var followingSyncRequests = 0
    init(count: Int = 8) throws {
        let author: [String: Any] = ["id":"45", "username":"fixture_reader", "displayName":"قارئ الاختبار", "verified":false]
        let metrics: [String: Any] = ["replies":0, "reposts":0, "likes":0, "quotes":0, "views":0, "bookmarks":0]
        let text = "فقرة عربية للاختبار مع English واسم @reader.\n\nAnother authored paragraph with composed characters 👨‍👩‍👧‍👦."
        let variants: [[String: Any]] = []
        var values: [[String: Any]] = []
        values.reserveCapacity(count)
        for index in 0..<count {
            var media: [[String: Any]] = []
            if index % 2 == 0 {
                let image: [String: Any] = ["kind": "image", "url": "ffmedia:fixture\(index)", "width": 640, "height": 360, "variants": variants]
                media.append(image)
            }
            let post: [String: Any] = [
                "id": String(1000 + index), "text": text, "author": author,
                "createdAt": "2026-10-30T10:00:00Z", "isRepost": false,
                "isPromoted": false, "metrics": metrics, "media": media,
                "isArticle": false, "provider": "fixture"
            ]
            values.append(post)
        }
        let fixtureData = try JSONSerialization.data(withJSONObject: values)
        posts = try JSONDecoder().decode([Post].self, from: fixtureData)
        // The fake returns an already-decoded bitmap. Production decoding runs
        // off the main actor, so fake rendering must not occupy the UI thread.
        fixtureImage = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 360)).image { context in
            UIColor.systemIndigo.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
        }
    }
    func perform(_ request: AppRequest) async throws -> Data {
        switch request.operation {
        case .refreshFeed, .loadFeedPage:
            if failRefresh { throw AppServiceError(code:"fixture_failure", message:"Controlled fixture refresh failure", retryable:true) }
            if providerPaging {
                try NativeReadingRestoreScope.budget?.consume()
                let offset: Int
                if case .string(let cursor)? = request.args["cursor"] { offset = Int(cursor) ?? 0 } else { offset = 0 }
                providerOffsets.append(offset)
                let page = Array(posts.dropFirst(offset).prefix(80)); let next = offset + page.count
                let cursor: String? = next < posts.count ? String(next) : nil
                let response = FeedResponse(posts: page, fromCache: false, provider: "fixture", lastSync: nil, readIds: [], totalCached: posts.count, nextCursor: cursor)
                return try JSONEncoder().encode(response)
            }
            if paginatedCache {
                let values = newerPosts + posts; let page = Array(values.prefix(80))
                let response = FeedResponse(posts: page, fromCache: false, provider: "fixture", lastSync: nil, readIds: [], totalCached: values.count, nextCursor: nil, nextOffset: page.count < values.count ? page.count : nil)
                return try JSONEncoder().encode(response)
            }
            return try JSONEncoder().encode(FeedResponse(posts:posts, fromCache:false, provider:"fixture", lastSync:nil, readIds:[], totalCached:posts.count, nextCursor:nil))
        case .cachedFeed:
            let offset: Int
            if case .number(let value)? = request.args["offset"] { offset = Int(value) } else { offset = 0 }
            cachedOffsets.append(offset)
            if providerPaging { return try JSONEncoder().encode(FeedResponse(posts: [], fromCache: true, provider: "fixture", lastSync: nil, readIds: [], totalCached: 0, nextCursor: nil)) }
            if paginatedCache {
                let values = newerPosts + posts; let page = Array(values.dropFirst(offset).prefix(80)); let next = offset + page.count
                let response = FeedResponse(posts: page, fromCache: true, provider: "fixture", lastSync: nil, readIds: [], totalCached: values.count, nextCursor: nil, nextOffset: next < values.count ? next : nil)
                return try JSONEncoder().encode(response)
            }
            return try JSONEncoder().encode(FeedResponse(posts:posts, fromCache:true, provider:"fixture", lastSync:nil, readIds:[], totalCached:posts.count, nextCursor:nil))
        case .groupFeed:
            let offset: Int
            if case .number(let value)? = request.args["offset"] { offset = Int(value) } else { offset = 0 }
            groupCacheOffsets.append(offset)
            let page: [Post] = Array(posts.dropFirst(offset).prefix(80))
            let end = offset + page.count
            let nextOffset: Int? = end < posts.count ? end : nil
            let response = GroupFeedResponse(posts: page, fromCache: true, provider: "fixture", lastSync: nil, readIds: [], totalCached: posts.count, nextCursor: nil, failures: [], nextOffset: nextOffset, memberCount: 10, loadedAccounts: 7, nextMemberOffset: 7)
            return try JSONEncoder().encode(response)
        case .searchCachedPosts:
            let offset: Int
            if case .number(let value)? = request.args["offset"] { offset = Int(value) } else { offset = 0 }
            searchOffsets.append(offset)
            if holdNextSearch {
                holdNextSearch = false
                // Deliberately deliver after task cancellation to exercise the
                // production query/account guards, as a late bridge can do.
                await withCheckedContinuation { pendingSearch = $0 }
            }
            let query: String
            if case .string(let value)? = request.args["query"] { query = value } else { query = "" }
            let values = emptySearchQueries.contains(query) ? [] : newerPosts + posts
            let page: [Post] = Array(values.dropFirst(offset).prefix(80))
            let end = offset + page.count
            let nextOffset: Int? = end < values.count ? end : nil
            let response = SearchResponse(posts: page, readIds: [], nextOffset: nextOffset)
            return try JSONEncoder().encode(response)
        case .setRead, .hidePost: return Data("null".utf8)
        case .resumeState: return try JSONEncoder().encode(resumeMarker)
        case .followingSnapshot: return try JSONEncoder().encode(FollowingSnapshot(accounts: [], complete: true, syncing: false, state: "complete", lastError: nil, lastProgressAt: nil))
        case .pinnedAccounts: return try JSONEncoder().encode([Author]())
        case .unfollowAllowed: return Data("true".utf8)
        case .startFollowingSync: followingSyncRequests += 1; return Data("true".utf8)
        default: throw AppServiceError(code:"fixture_unexpected_operation", message:"The fixture does not implement this operation.")
        }
    }
    func completeHeldSearch() { let completion = pendingSearch; pendingSearch = nil; completion?.resume() }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw AppServiceError(code:"fixture", message:"Fixture tests never sign in.") }
    func mediaURL(for handle: String) async throws -> URL { throw AppServiceError(code:"fixture", message:"Fixture media never uses a network URL.") }
    func loadImage(url: String, maxPixelDimension: Int) async throws -> UIImage {
        if speculativeOnlyHandles.contains(url) { speculationThroughVisibleLoader += 1 }
        imageRequests[url, default:0] += 1
        if delayImages { try await Task.sleep(nanoseconds: 25_000_000) }
        try Task.checkCancellation()
        if failImages { throw AppServiceError(code:"fixture_image_failure", message:"Controlled image failure.") }
        if malformedImages {
            return try NativeMediaService.downsample(Data("Controlled invalid image data".utf8), maximum: maxPixelDimension).image
        }
        return fixtureImage
    }
    func prefetchImage(url: String, maxPixelDimension: Int) async throws {
        prefetchRequests[url, default:0] += 1
        do {
            if holdPrefetch { try await Task.sleep(nanoseconds:30_000_000_000) }
            try Task.checkCancellation()
            if failPrefetch { throw AppServiceError(code:"fixture_prefetch_failure", message:"Controlled speculative download failure.") }
        } catch is CancellationError { cancelledPrefetch += 1; throw CancellationError() }
    }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { throw AppServiceError(code:"fixture", message:"Video playback is outside these layout fixtures.") }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"Viewer playback is outside these layout fixtures.") }
    func recoverMedia() async throws {}
    func recoverMediaHandle(_ handle: String) async throws -> String { repairRequests.append(handle); await Task.yield(); return handle + "-renewed" }
}
