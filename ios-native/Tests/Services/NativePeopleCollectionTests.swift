import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

/// Exercises the production native account collection with local account data.
/// These checks do not qualify provider traversal, VoiceOver or physical FPS.
@MainActor final class NativePeopleCollectionTests: XCTestCase {
    private var window: UIWindow?
    private var previousWindow: UIWindow?
    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil; window = nil
        previousWindow?.makeKeyAndVisible(); previousWindow = nil; L10n.language = "system"
        super.tearDown()
    }
    private func host(_ controller: UIViewController, largeText: Bool = false) throws -> UINavigationController {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = try XCTUnwrap(scenes.first { $0.activationState == .foregroundActive } ?? scenes.first)
        previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene); window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let navigation = UINavigationController(rootViewController: controller)
        if largeText { navigation.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge), forChild: controller) }
        window.rootViewController = navigation; self.window = window; window.makeKeyAndVisible()
        navigation.view.layoutIfNeeded(); return navigation
    }
    private func settle(_ controller: PeopleViewController, until condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while ProcessInfo.processInfo.systemUptime < deadline {
            controller.view.layoutIfNeeded(); controller.collection.layoutIfNeeded()
            if condition() { return }
            await Task.yield(); try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("The controlled account collection did not settle.")
        throw FixtureFailure.didNotSettle
    }
    private enum FixtureFailure: Error { case didNotSettle }

    func testCompleteAccountCollectionUsesNativeReusableRowsAndArabicSelfSizing() async throws {
        L10n.language = "ar"
        let services = PeopleCollectionServices(count: 400)
        services.pinnedIDs = [services.accounts[0].id]
        // Repeated provider IDs must not become duplicate diffable identities.
        services.accounts.append(services.accounts[0])
        let context = ReaderContext(services: services); context.preferences.set("language", "ar")
        let controller = PeopleViewController(context: context); _ = try host(controller, largeText: true)
        try await settle(controller) { controller.collection.numberOfItems(inSection: 0) == 400 && !controller.collection.visibleCells.isEmpty }
        XCTAssertTrue(controller.collection.collectionViewLayout is UICollectionViewCompositionalLayout)
        XCTAssertEqual(controller.view.semanticContentAttribute, .forceRightToLeft)
        let cell = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 0, section: 0)) as? UICollectionViewListCell)
        let content = try XCTUnwrap(cell.contentConfiguration as? UIListContentConfiguration)
        XCTAssertEqual(content.text, services.accounts[0].label + " 📌")
        XCTAssertEqual(content.secondaryText, "@reader_0")
        XCTAssertGreaterThanOrEqual(cell.bounds.height, 44)
        let first = try XCTUnwrap(controller.collection.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)))
        let next = try XCTUnwrap(controller.collection.layoutAttributesForItem(at: IndexPath(item: 1, section: 0)))
        XCTAssertLessThanOrEqual(first.frame.maxY, next.frame.minY + 1)
        controller.collection.scrollToItem(at: IndexPath(item: 399, section: 0), at: .bottom, animated: false)
        try await settle(controller) { controller.collection.cellForItem(at: IndexPath(item: 399, section: 0)) != nil }
        let last = try XCTUnwrap(controller.collection.cellForItem(at: IndexPath(item: 399, section: 0)))
        XCTAssertEqual(last.accessibilityIdentifier, "person.1.400", "Account collections must remain complete beyond the feed's 300-post working budget.")
    }

    func testSearchAndUpdatesKeepStableIdentityAndRejectPreviousAccountSelection() async throws {
        let services = PeopleCollectionServices(count: 400); let context = ReaderContext(services: services)
        let controller = PeopleViewController(context: context); let navigation = try host(controller)
        try await settle(controller) { controller.collection.numberOfItems(inSection: 0) == 400 }
        let search = try XCTUnwrap(controller.navigationItem.searchController)
        search.searchBar.text = "READER_399"; controller.updateSearchResults(for: search)
        try await settle(controller) { controller.collection.numberOfItems(inSection: 0) == 1 && !controller.collection.visibleCells.isEmpty }
        let first = IndexPath(item: 0, section: 0)
        XCTAssertEqual(controller.collection.cellForItem(at: first)?.accessibilityIdentifier, "person.1.400")
        services.accounts[399].displayName = "اسم محدث Updated account"
        NotificationCenter.default.post(name: .readerFollowingChanged, object: context)
        try await settle(controller) {
            (controller.collection.cellForItem(at: first)?.contentConfiguration as? UIListContentConfiguration)?.text == services.accounts[399].displayName
        }
        XCTAssertEqual(controller.collection.cellForItem(at: first)?.accessibilityIdentifier, "person.1.400")
        XCTAssertNotNil(controller.collectionView(controller.collection, contextMenuConfigurationForItemAt: first, point: .zero))
        services.accountGeneration = 2
        controller.collectionView(controller.collection, didSelectItemAt: first)
        XCTAssertEqual(navigation.viewControllers.count, 1, "A row from the previous account generation must not navigate or act on the new account.")
        NotificationCenter.default.post(name: .readerFollowingChanged, object: context)
        try await settle(controller) { controller.collection.cellForItem(at: first)?.accessibilityIdentifier == "person.2.400" }
        controller.collectionView(controller.collection, didSelectItemAt: first)
        XCTAssertTrue(navigation.topViewController is ProfileViewController)
    }

    func testPullToRefreshKeepsAccountRowsAndReportsActualTraversalProgress() async throws {
        let services = PeopleCollectionServices(count: 20); let context = ReaderContext(services: services)
        let controller = PeopleViewController(context: context); _ = try host(controller)
        try await settle(controller) { controller.collection.numberOfItems(inSection: 0) == 20 }
        let refresh = try XCTUnwrap(controller.collection.refreshControl)
        refresh.sendActions(for: .valueChanged)
        let notice = try XCTUnwrap((controller.view.subviews.first as? UIStackView)?.arrangedSubviews.compactMap { $0 as? NoticeView }.first)
        try await settle(controller) { services.syncRequests == 1 && !notice.isHidden }
        XCTAssertEqual(controller.collection.numberOfItems(inSection: 0), 20)
        XCTAssertEqual(notice.label.text, L10n.text("followingProgress"))
    }

    func testFinalProgressDuringHeldSnapshotIsReloadedAfterTheCurrentLoadSettles() async throws {
        let services = PeopleCollectionServices(count: 20)
        services.complete = false; services.syncing = true; services.holdFirstSnapshot = true
        defer { services.completeHeldSnapshot() }
        let context = ReaderContext(services: services); let controller = PeopleViewController(context: context)
        _ = try host(controller)
        try await settle(controller) { services.pendingSnapshot != nil }
        services.complete = true; services.syncing = false
        // This notification arrives after the first snapshot was read, but
        // before that older response can finish rendering its busy state.
        NotificationCenter.default.post(name: .readerFollowingChanged, object: context)
        services.completeHeldSnapshot()
        let notice = try XCTUnwrap((controller.view.subviews.first as? UIStackView)?.arrangedSubviews.compactMap { $0 as? NoticeView }.first)
        try await settle(controller) { services.snapshotRequests >= 2 && notice.isHidden && controller.collection.numberOfItems(inSection: 0) == 20 }
        XCTAssertEqual(services.snapshotRequests, 2, "Progress bursts require one coalesced follow-up load, not an independent task per event.")
        XCTAssertEqual(services.syncRequests, 0)
    }
}

@MainActor private final class PeopleCollectionServices: AppServices {
    var accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    var accounts: [Author]
    var pinnedIDs = Set<String>()
    var complete = true
    var syncing = false
    var syncRequests = 0
    var snapshotRequests = 0
    var holdFirstSnapshot = false
    var pendingSnapshot: CheckedContinuation<Data, Never>?
    private var heldSnapshot: Data?
    init(count: Int) {
        accounts = (0..<count).map { index in
            let name = index == 0 ? "اسم عربي طويل لاختبار التفاف السطور مع English والاتجاه المختلط في قائمة الحسابات" : "قارئ \(index)"
            return Author(id: String(index + 1), username: "reader_\(index)", displayName: name, avatarUrl: nil, bannerUrl: nil, verified: false, bio: nil, followersCount: nil, followingCount: nil, location: nil, website: nil, joinedAt: nil, postsCount: nil)
        }
    }
    func perform(_ request: AppRequest) async throws -> Data {
        switch request.operation {
        case .followingSnapshot:
            snapshotRequests += 1
            let response = try JSONEncoder().encode(FollowingSnapshot(accounts: accounts, complete: complete, syncing: syncing, state: syncing ? "loading" : "idle", lastError: nil, lastProgressAt: nil))
            if holdFirstSnapshot, snapshotRequests == 1 {
                heldSnapshot = response
                return await withCheckedContinuation { pendingSnapshot = $0 }
            }
            return response
        case .pinnedAccounts: return try JSONEncoder().encode(accounts.filter { pinnedIDs.contains($0.id) })
        case .unfollowAllowed: return Data("false".utf8)
        case .startFollowingSync: syncRequests += 1; complete = false; syncing = true; return Data("true".utf8)
        case .resumeState: return Data("null".utf8)
        case .userProfile:
            let requested: String
            if case .string(let username)? = request.args["username"] { requested = username } else { requested = "" }
            guard let author = accounts.first(where: { $0.username == requested }) else { throw unavailable }
            return try JSONEncoder().encode(author)
        case .cachedFeed, .refreshFeed, .loadFeedPage:
            return try JSONEncoder().encode(FeedResponse(posts: [], fromCache: true, provider: "fixture", lastSync: nil, readIds: [], totalCached: 0, nextCursor: nil, nextOffset: nil))
        default: throw unavailable
        }
    }
    func completeHeldSnapshot() {
        let continuation = pendingSnapshot; pendingSnapshot = nil
        let response = heldSnapshot; heldSnapshot = nil
        if let continuation { continuation.resume(returning: response ?? Data("null".utf8)) }
    }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw unavailable }
    func mediaURL(for handle: String) async throws -> URL { throw unavailable }
    func loadImage(url: String, maxPixelDimension: Int) async throws -> UIImage { throw unavailable }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { throw unavailable }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw unavailable }
    func recoverMedia() async throws { throw unavailable }
    private var unavailable: AppServiceError { AppServiceError(code: "unexpected_fixture_operation", message: "This fixture only exercises native account-list behavior.") }
}
