import UIKit

private struct FeedItemIdentity: Hashable {
    let accountGeneration: UInt64
    let postID: String
}

@MainActor final class TimelineRepository {
    struct State { var posts: [Post] = []; var readIDs: Set<String> = []; var cursor: String?; var lastSync: String?; var fromCache = true; var exhausted = false; var groupOffset = 0; var groupComplete = false; var groupFailures: [AccountFailure] = []; var windowStart = 0; var nextCachedOffset: Int? }
    unowned let context: ReaderContext
    private var states: [String: State] = [:]
    private var pending: [String: (id: UUID, task: Task<FeedResponse, Error>)] = [:]
    init(context: ReaderContext) { self.context = context }
    func state(_ source: String) -> State { states[source] ?? State() }
    func load(_ source: String, refresh: Bool, cached: Bool = false) async throws -> State {
        if let pending = pending[source] { _ = try await pending.task.value; try Task.checkCancellation(); return state(source) }
        let current = state(source)
        if !refresh && !cached && current.exhausted { return current }
        let generation = context.services.accountGeneration
        let task = Task<FeedResponse, Error> {
            if source.hasPrefix("group:") {
                let id = String(source.dropFirst(6))
                let cacheOnly = cached || (!refresh && (current.nextCachedOffset != nil || current.groupComplete))
                let offset = refresh ? 0 : cached ? current.windowStart : cacheOnly ? current.nextCachedOffset ?? current.windowStart : current.windowStart
                let response: GroupFeedResponse = try await context.services.call(cacheOnly ? .groupFeed : .refreshGroupFeed, ["groupId": .string(id), "memberOffset": .number(Double(refresh ? 0 : current.groupOffset)), "offset": .number(Double(offset)), "restart": .bool(refresh), "filters": try .encoded(FeedFilters()), "perAccount": .number(30), "limit": .number(80)])
                if generation == context.services.accountGeneration {
                    var state = self.state(source); state.groupOffset = response.nextMemberOffset ?? response.memberCount; state.groupComplete = response.nextMemberOffset == nil; state.groupFailures = response.failures; state.exhausted = response.nextMemberOffset == nil && response.nextOffset == nil; states[source] = state
                }
                return response.feed
            }
            let useCachedPage = !refresh && !cached && current.nextCachedOffset != nil
            return try await context.services.feed(source, filters: FeedFilters(), cursor: refresh || cached || useCachedPage ? nil : current.cursor, cached: cached || useCachedPage, offset: useCachedPage ? current.nextCachedOffset ?? 0 : cached ? current.windowStart : 0)
        }
        let id = UUID(); pending[source] = (id, task)
        defer { if pending[source]?.id == id { pending[source] = nil } }
        let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
        try Task.checkCancellation()
        guard generation == context.services.accountGeneration else { throw CancellationError() }
        var next = state(source)
        if refresh || cached { next.posts = result.posts; if refresh { next.windowStart = 0 } }
        else { let ids = Set(next.posts.map(\.id)); next.posts += result.posts.filter { !ids.contains($0.id) } }
        if source.hasPrefix("group:") { next.posts.sort { $0.createdAt > $1.createdAt } }
        next.nextCachedOffset = result.nextOffset
        if next.posts.count > 300 { let remove = next.posts.count - 300; next.posts.removeFirst(remove); next.windowStart += remove }
        next.readIDs.formUnion(result.readIds); next.cursor = result.nextCursor; next.lastSync = result.lastSync; next.fromCache = result.fromCache
        if !source.hasPrefix("group:") { next.exhausted = !cached && result.nextOffset == nil && (result.nextCursor == nil || (!refresh && current.cursor == result.nextCursor)) }
        // Inactive destinations retain lightweight cursor/anchor metadata,
        // while post bodies can be rehydrated from the session index.
        for key in states.keys where key != source { states[key]?.posts.removeAll(keepingCapacity: false) }
        states[source] = next
        return next
    }
    func setRead(_ id: String, read: Bool) { for key in states.keys { if read { states[key]?.readIDs.insert(id) } else { states[key]?.readIDs.remove(id) } } }
    func hide(_ id: String) { for key in states.keys { states[key]?.posts.removeAll { $0.id == id } } }
    func earlier(_ source: String) async throws -> State {
        var current = state(source); guard current.windowStart > 0 else { return current }
        let start = max(0, current.windowStart - 80)
        let result = try await context.services.feed(source, filters: FeedFilters(), cached: true, offset: start)
        let known = Set(current.posts.map(\.id)); current.posts = result.posts.filter { !known.contains($0.id) } + current.posts
        current.windowStart = start; current.readIDs.formUnion(result.readIds)
        if current.posts.count > 300 { current.posts = Array(current.posts.prefix(300)); current.nextCachedOffset = start + current.posts.count; current.exhausted = false }
        states[source] = current; return current
    }
    func trimForMemoryPressure() { for key in states.keys { states[key]?.posts.removeAll(keepingCapacity: false) } }
    func releaseHydratedPosts() { pending.values.forEach { $0.task.cancel() }; pending.removeAll(); trimForMemoryPressure() }
    func restoreMetadata(_ source: String, _ state: State) { var metadata = state; metadata.posts = []; states[source] = metadata }
    func retainWorkingSet(_ source: String, _ state: State) { trimForMemoryPressure(); states[source] = state }
    func reset() { pending.values.forEach { $0.task.cancel() }; pending.removeAll(); states.removeAll() }
}

class FeedViewController: ReaderScreen, UICollectionViewDelegate, UICollectionViewDataSourcePrefetching, PostCellDelegate {
    let route: ReaderRoute
    let source: String
    var filters: FeedFilters
    private(set) var state = TimelineRepository.State()
    var posts: [Post] = []
    let notice = NoticeView()
    let status = readerLabel(style: .caption1, color: .secondaryLabel)
    let refreshControl = UIRefreshControl()
    private(set) var collection: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, FeedItemIdentity>!
    private let renderedCells = NSHashTable<PostCell>.weakObjects()
    private var busy = false
    private var initiallyLoaded = false
    private var activeReading = false
    private var releasedForInactivity = false
    private var heldOffset: CGPoint?
    private var sessionAnchor: (String, CGFloat)?
    private var lastHeight: CGFloat = 0
    private var refreshTimer: Timer?
    private var imagePrefetch: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    private var lastMemoryRevision = 0
    private var accountGeneration: UInt64 = 0
    private let topActions = UIStackView()
    var profileHeader: UIView?
    var postPredicate: ((Post) -> Bool)?
    var automaticallyLoads = true
    var includesReplies = false
    var highlightedText = ""
    init(context: ReaderContext, route: ReaderRoute = .following, source: String? = nil, filters: FeedFilters? = nil) {
        self.route = route; self.source = source ?? (route == .bookmarks ? "bookmarks" : "following")
        self.filters = filters ?? (route == .originals ? .originals : route == .focus ? .focus : FeedFilters())
        super.init(context: context)
    }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); if title == nil { title = route.title }; accountGeneration = context.services.accountGeneration
        let layout = UICollectionViewCompositionalLayout { [weak self] _, environment in
            let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(380)))
            let group = NSCollectionLayoutGroup.vertical(layoutSize: item.layoutSize, subitems: [item]); let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = 12
            let inset = max(12, (environment.container.effectiveContentSize.width - 760) / 2)
            section.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: inset, bottom: 20, trailing: inset)
            if self?.profileHeader != nil { section.boundarySupplementaryItems = [NSCollectionLayoutBoundarySupplementaryItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(300)), elementKind: UICollectionView.elementKindSectionHeader, alignment: .top)] }
            return section
        }
        collection = UICollectionView(frame: .zero, collectionViewLayout: layout); collection.backgroundColor = .clear; collection.delegate = self; collection.prefetchDataSource = self; collection.alwaysBounceVertical = true; collection.accessibilityIdentifier = "reader.feed"
        collection.register(PostCell.self, forCellWithReuseIdentifier: PostCell.reuseID); collection.register(FeedHeader.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: "header")
        refreshControl.addTarget(self, action: #selector(refreshTapped), for: .valueChanged); collection.refreshControl = refreshControl
        topActions.axis = .horizontal; topActions.spacing = 8; topActions.alignment = .center
        topActions.addArrangedSubview(status)
        if [.following, .focus].contains(route) && source == "following" { topActions.addArrangedSubview(readerButton(L10n.text("filters"), symbol: "line.3.horizontal.decrease") { [weak self] in self?.openFilters() }) }
        let column = UIStackView(arrangedSubviews: [topActions, notice, collection]); column.axis = .vertical; column.spacing = 0; view.addSubview(column); column.pin(to: view, safe: true)
        topActions.isLayoutMarginsRelativeArrangement = true; topActions.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 8)
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "arrow.clockwise"), style: .plain, target: self, action: #selector(refreshTapped)); navigationItem.rightBarButtonItem?.accessibilityLabel = L10n.text("refresh")
        dataSource = UICollectionViewDiffableDataSource<Int, FeedItemIdentity>(collectionView: collection) { [weak self] collection, indexPath, item in
            let id = item.postID
            guard let self, let post = posts.first(where: { $0.id == id }), let cell = collection.dequeueReusableCell(withReuseIdentifier: PostCell.reuseID, for: indexPath) as? PostCell else { return nil }
            renderedCells.add(cell)
            cancelImagePrefetch(for: post)
            cell.configure(post, read: state.readIDs.contains(id), bookmark: route == .bookmarks && !includesReplies, context: context, delegate: self)
            cell.highlight(highlightedText)
            if collection.indexPathsForVisibleItems.contains(indexPath) { DispatchQueue.main.async { [weak cell, weak self] in if self?.viewIfLoaded?.window != nil { cell?.visible(read: self?.state.readIDs.contains(id) ?? false) } } }
            cell.markRead = { [weak self] in self?.markRead(post.id, read: true) }; return cell
        }
        dataSource.supplementaryViewProvider = { [weak self] collection, kind, path in
            let header = collection.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: "header", for: path) as! FeedHeader
            header.install(self?.profileHeader); return header
        }
        NotificationCenter.default.addObserver(self, selector: #selector(contextChanged), name: .readerContextChanged, object: context)
        NotificationCenter.default.addObserver(self, selector: #selector(contentChanged), name: .readerContentChanged, object: context)
        NotificationCenter.default.addObserver(self, selector: #selector(recoverVisibleMedia), name: .readerMediaRecoveryOpportunity, object: context)
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        activeReading = true
        guard automaticallyLoads else { return }
        if releasedForInactivity { context.timelines.restoreMetadata(source, state); releasedForInactivity = false }
        if !initiallyLoaded { initiallyLoaded = true; loadInitial() }
        else { state = context.timelines.state(source); if state.posts.isEmpty { loadInitial() } else { apply(); restore(sessionAnchor) } }
        scheduleRefresh()
    }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); cancelImagePrefetch(); refreshTimer?.invalidate(); refreshTimer = nil; sessionAnchor = firstAnchor(); collection.visibleCells.compactMap { $0 as? PostCell }.forEach { $0.stop() }; persistAnchor() }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); activeReading = false; releaseHydratedContent() }
    /// Hidden navigation stacks retain cursor/window metadata, not another set
    /// of hydrated post bodies and cells. Subclasses also release their buffers.
    func releaseHydratedContent() {
        work?.cancel(); work = nil; busy = false; cancelImagePrefetch()
        renderedCells.allObjects.forEach { $0.releaseContent() }
        if let anchor = sessionAnchor, let index = state.posts.firstIndex(where: { $0.id == anchor.0 }) { state.windowStart += index }
        state.posts = []; posts = []; releasedForInactivity = true
        if dataSource != nil { var snapshot = NSDiffableDataSourceSnapshot<Int, FeedItemIdentity>(); snapshot.appendSections([0]); dataSource.apply(snapshot, animatingDifferences:false) }
    }
    func restoreSessionAnchor() { restore(sessionAnchor) }
    func trimHydratedForMemoryPressure() {
        guard activeReading else { releaseHydratedContent(); return }
        guard automaticallyLoads, state.posts.count > 80 else { return }
        let anchor = firstAnchor()
        let visible = anchor.flatMap { value in state.posts.firstIndex { $0.id == value.0 } } ?? 0
        let start = max(0, visible - 20); let end = min(state.posts.count, start + 80)
        let hadLater = end < state.posts.count
        state.posts = Array(state.posts[start..<end]); state.windowStart += start
        if hadLater { state.nextCachedOffset = state.windowStart + state.posts.count; state.exhausted = false }
        context.timelines.retainWorkingSet(source, state); apply(); restore(anchor)
    }
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        let anchor = collection == nil ? nil : firstAnchor(); super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.collection?.collectionViewLayout.invalidateLayout(); self?.restore(anchor) }
    }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) { super.traitCollectionDidChange(previousTraitCollection); if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory, collection != nil { let anchor = firstAnchor(); apply(); collection.collectionViewLayout.invalidateLayout(); restore(anchor) } }
    @objc private func contextChanged() {
        ReaderTheme.apply(context.preferences, to: self)
        let policy = ImagePrefetchPolicy.effective(mode: context.preferences.string("performance.mode"), runtime: context.runtime)
        let memory = context.runtime?.memoryRevision ?? 0
        let memoryChanged = memory != lastMemoryRevision
        if policy.capacity == 0 || memory != lastMemoryRevision || imagePrefetch.count > policy.capacity { cancelImagePrefetch() }
        lastMemoryRevision = memory
        if memoryChanged { trimHydratedForMemoryPressure() }
        if accountGeneration != context.services.accountGeneration { cancelImagePrefetch(); accountGeneration = context.services.accountGeneration; state = TimelineRepository.State(); posts = []; context.timelines.reset(); initiallyLoaded = false; if activeReading && automaticallyLoads { initiallyLoaded = true; loadInitial() }; return }
        if context.runtime?.foreground == false { collection.visibleCells.compactMap { $0 as? PostCell }.forEach { $0.stop() } }
        scheduleRefresh()
        switch context.recovery {
        case "reconnecting", "recovering": status.text = L10n.text("reconnecting")
        case "updated": status.text = L10n.text("updated")
        case "recovered": status.text = L10n.text("recovered")
        case "needsAttention": status.text = L10n.text("attention")
        case "readyToRetry": status.text = L10n.text("retry")
        case "offline": status.text = L10n.text("offline")
        default: break
        }
    }
    @objc private func contentChanged() { guard activeReading, automaticallyLoads else { return }; state = context.timelines.state(source); apply() }
    @objc private func recoverVisibleMedia() {
        guard viewIfLoaded?.window != nil, context.runtime?.foreground != false,
              accountGeneration == context.services.accountGeneration else { return }
        collection.visibleCells.compactMap { $0 as? PostCell }.forEach { $0.recoverFailedMedia() }
    }
    private func loadInitial() {
        work?.cancel(); busy = true; notice.show(L10n.text("loading"), busy: true)
        work = Task { [weak self] in
            guard let self else { return }
            defer { busy = false; refreshControl.endRefreshing() }
            do {
                state = try await context.timelines.load(source, refresh: false, cached: true); apply()
                let behavior = context.preferences.values["pages.openBehavior.\(route.rawValue)"] ?? context.preferences.string("pages.openBehavior")
                if state.posts.isEmpty || behavior != "off" { state = try await context.timelines.load(source, refresh: true); apply() }
                if sessionAnchor != nil { restoreSessionAnchor() } else { await restoreAnchor() }
            } catch { failure(error) }
        }
    }
    @objc func refreshTapped() { load(refresh: true) }
    func load(refresh: Bool) {
        guard !busy else { return }; busy = true; if posts.isEmpty { notice.show(L10n.text("loading"), busy: true) }
        work = Task { [weak self] in
            guard let self else { return }
            defer { busy = false; refreshControl.endRefreshing() }
            let anchor = firstAnchor()
            do { state = try await context.timelines.load(source, refresh: refresh); apply(); if refresh || source.hasPrefix("group:") { restore(anchor) } }
            catch { failure(error) }
        }
    }
    func replacePosts(_ incoming: [Post], readIDs: [String] = []) { state.posts = incoming; state.readIDs = Set(readIDs); state.exhausted = true; apply() }
    func apply() {
        guard collection != nil else { return }
        posts = state.posts.filter { filters.accepts($0, read: state.readIDs.contains($0.id), includeReplies: includesReplies) && (postPredicate?($0) ?? true) }
        let retained = Set(state.posts.map(\.id))
        renderedCells.allObjects.filter { cell in cell.representedPostID.map { !retained.contains($0) } == true }.forEach { $0.releaseContent() }
        let previous = Set(dataSource.snapshot().itemIdentifiers)
        let items = posts.map { FeedItemIdentity(accountGeneration:context.services.accountGeneration,postID:$0.id) }
        var snapshot = NSDiffableDataSourceSnapshot<Int, FeedItemIdentity>(); snapshot.appendSections([0]); snapshot.appendItems(items); snapshot.reconfigureItems(items.filter { previous.contains($0) }); dataSource.apply(snapshot, animatingDifferences: false)
        if posts.isEmpty, !state.exhausted {
            notice.show(L10n.text("empty") + "\n" + L10n.text("emptyHint"), retry: { [weak self] in self?.load(refresh: false) }, actionTitle: L10n.text("loadMore"))
        } else if posts.isEmpty { notice.show(L10n.text("empty") + "\n" + L10n.text("emptyHint")) }
        else { notice.show(nil) }
        if !state.groupFailures.isEmpty { notice.show(L10n.text("partialList"), retry: { [weak self] in self?.load(refresh: true) }) }
        if let last = state.lastSync { status.text = "\(L10n.text("updated")) \(ReaderDates.label(last))" } else { status.text = state.fromCache ? L10n.text("cached") : nil }
    }
    private func failure(_ error: Error) { guard !(error is CancellationError) else { return }; notice.show(error.localizedDescription, retry: { [weak self] in self?.load(refresh: true) }); status.text = L10n.text("attention") }
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        if let post = posts[safe: indexPath.item] { cancelImagePrefetch(for: post); (cell as? PostCell)?.visible(read: state.readIDs.contains(post.id)) }
        if indexPath.item >= posts.count - 5 && !state.exhausted && !busy { load(refresh: false) }
    }
    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) { (cell as? PostCell)?.stop() }
    func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
        let policy = ImagePrefetchPolicy.effective(mode: context.preferences.string("performance.mode"), runtime: context.runtime)
        guard policy.capacity > 0, viewIfLoaded?.window != nil else { cancelImagePrefetch(); return }
        let visible = collectionView.indexPathsForVisibleItems.map(\.item)
        guard let first = visible.min(), let last = visible.max() else { return }
        let runway = max(1, visible.count) * policy.screensAhead
        let generation = context.services.accountGeneration
        // Match PhotoTile's visible-image decode key so warming the bounded
        // service cache does not cause a second differently-sized download.
        let pixels = 1200
        for path in indexPaths.sorted() {
            guard imagePrefetch.count < policy.capacity else { break }
            guard !visible.contains(path.item), path.item >= max(0, first - runway), path.item <= last + runway,
                  let post = posts[safe: path.item], let item = post.media.first(where: { $0.kind == "image" }), imagePrefetch[item.url] == nil else { continue }
            let id = UUID(); let handle = item.url
            let task = Task(priority: .utility) { [weak self] in
                guard let self else { return }
                defer { if imagePrefetch[handle]?.id == id { imagePrefetch.removeValue(forKey: handle) } }
                guard generation == context.services.accountGeneration else { return }
                do { _ = try await context.services.imageData(url: handle, maxPixelDimension: pixels); try Task.checkCancellation() }
                catch { /* Speculation never presents an error or runs recovery. */ }
            }
            imagePrefetch[handle] = (id, task)
        }
    }
    func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
        for path in indexPaths { if let post = posts[safe: path.item] { cancelImagePrefetch(for: post) } }
    }
    private func cancelImagePrefetch(for post: Post) {
        for item in post.media where item.kind == "image" { imagePrefetch.removeValue(forKey: item.url)?.task.cancel() }
    }
    private func cancelImagePrefetch() { imagePrefetch.values.forEach { $0.task.cancel() }; imagePrefetch.removeAll(keepingCapacity: false) }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { loadEarlierIfNeeded() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { loadEarlierIfNeeded() } }
    private func loadEarlierIfNeeded() {
        guard source.hasPrefix("group:") == false, state.windowStart > 0, !busy, collection.contentOffset.y < 120 else { return }
        busy = true; let anchor = firstAnchor()
        work = Task { [weak self] in guard let self else { return }; defer { busy = false }; do { state = try await context.timelines.earlier(source); apply(); restore(anchor) } catch { failure(error) } }
    }
    private func scheduleRefresh() {
        refreshTimer?.invalidate(); refreshTimer = nil
        let minutes = context.preferences.number("content.autoRefreshMinutes")
        guard automaticallyLoads, minutes > 0, context.runtime?.foreground != false, viewIfLoaded?.window != nil else { return }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: max(60, minutes * 60), repeats: true) { [weak self] _ in Task { @MainActor in self?.load(refresh: true) } }
    }
    func returnToTop() {
        guard collection.contentOffset.y > 50 else { return }
        heldOffset = collection.contentOffset; collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: !UIAccessibility.isReduceMotionEnabled)
        notice.show(L10n.text("returnPlace"), retry: { [weak self] in guard let self, let offset = heldOffset else { return }; collection.setContentOffset(offset, animated: !UIAccessibility.isReduceMotionEnabled); notice.show(nil); heldOffset = nil })
        Task { [weak self] in try? await Task.sleep(nanoseconds: 10_000_000_000); guard !Task.isCancelled, let self, heldOffset != nil else { return }; heldOffset = nil; notice.show(nil) }
    }
    private func firstAnchor() -> (String, CGFloat)? {
        guard let index = collection.indexPathsForVisibleItems.sorted().first, let post = posts[safe: index.item], let attributes = collection.layoutAttributesForItem(at: index) else { return nil }; return (post.id, collection.contentOffset.y - attributes.frame.minY)
    }
    private func restore(_ anchor: (String, CGFloat)?) {
        guard let anchor, let index = posts.firstIndex(where: { $0.id == anchor.0 }) else { return }
        collection.layoutIfNeeded(); collection.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false); collection.contentOffset.y += anchor.1
    }
    private func persistAnchor() {
        guard let destination = resumeDestination, let anchor = firstAnchor() else { return }; let account = context.session?.account?.id
        Task { [services = context.services, route = destination] in
            guard let state = try? await services.call(.resumeState, ["route": .string(route)], as: ResumeState?.self), state.enabled else { return }
            try? await services.saveResumeState(ResumeState(enabled: true, route: route, postID: anchor.0, offset: Double(anchor.1), accountID: account))
        }
    }
    private func restoreAnchor() async {
        guard let destination = resumeDestination, let saved = try? await context.services.call(.resumeState, ["route": .string(destination)], as: ResumeState?.self), saved.enabled, saved.accountID == context.session?.account?.id, let id = saved.postID else { return }
        if posts.contains(where: { $0.id == id }) { restore((id, CGFloat(saved.offset))); return }
        for _ in 0..<3 {
            guard !state.exhausted else { break }
            do { state = try await context.timelines.load(source, refresh: false); apply() } catch { break }
            if posts.contains(where: { $0.id == id }) { restore((id, CGFloat(saved.offset))); return }
        }
        notice.show(L10n.text("resumeUnavailable"))
    }
    var resumeDestination: String? {
        guard automaticallyLoads else { return nil }
        if source.hasPrefix("user:") || source.hasPrefix("group:") { return source }
        return [.following, .originals, .focus, .bookmarks].contains(route) ? route.rawValue : nil
    }
    private func openFilters() {
        let controller = FiltersViewController(context: context, filters: filters) { [weak self] next in self?.filters = next; self?.apply() }
        let nav = UINavigationController(rootViewController: controller); nav.sheetPresentationController?.detents = [.medium(), .large()]; present(nav, animated: true)
    }
    func markRead(_ id: String, read: Bool) {
        Task { [weak self] in guard let self else { return }; do { try await context.services.setRead(id, read: read); context.timelines.setRead(id, read: read); if read { state.readIDs.insert(id) } else { state.readIDs.remove(id) }; readStateDidChange(id, read:read); apply() } catch { showError(error) } }
    }
    func readStateDidChange(_ id: String, read: Bool) {}
    func postDidHide(_ id: String) {}
    func postCellOpenProfile(_ username: String) { openProfile(username) }
    func postCellSetRead(_ post: Post, read: Bool) { markRead(post.id, read: read) }
    func postCellOpenArticle(_ post: Post) { navigationController?.pushViewController(ArticleViewController(context: context, post: post), animated: true) }
    func postCellComments(_ post: Post) { navigationController?.pushViewController(CommentsViewController(context: context, post: post), animated: true) }
    func postCellOpenURL(_ url: URL) { Task { do { try await context.services.command(.openExternal, ["url": .string(url.absoluteString)]) } catch { showError(error) } } }
    func postCellPresentMedia(_ request: MediaPresentation) { Task { do { let result = try await context.services.presentMedia(request, from: self); if let key = request.playbackKey { context.rememberMedia(key, paused: !result.playing, position: result.position, speed: result.speed, muted: result.muted, loopPlayback: result.loopPlayback, selectedHandle: result.selectedHandle) } } catch { showError(error) } } }
    func postCellActions(_ post: Post, source: UIView) {
        let sheet = UIAlertController(title: post.author.label, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: L10n.text(state.readIDs.contains(post.id) ? "markUnread" : "markRead"), style: .default) { [weak self] _ in self?.markRead(post.id, read: !(self?.state.readIDs.contains(post.id) ?? false)) })
        sheet.addAction(UIAlertAction(title: L10n.text("copyText"), style: .default) { _ in ReaderClipboard.copyText(post.text) })
        if let url = post.canonicalURL { sheet.addAction(UIAlertAction(title: L10n.text("copyLink"), style: .default) { _ in ReaderClipboard.copyURL(url) }) }
        sheet.addAction(UIAlertAction(title: L10n.text("hide"), style: .default) { [weak self] _ in self?.hide(post) })
        if route == .bookmarks && !includesReplies && context.capabilities?.unbookmark == true {
            sheet.addAction(UIAlertAction(title: L10n.text("removeBookmark"), style: .destructive) { [weak self] _ in
                self?.confirm(title: L10n.text("removeBookmark"), message: L10n.text("removeBookmarkBody"), action: L10n.text("delete"), destructive: true) { [weak self] in self?.removeBookmark(post) }
            })
        }
        sheet.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); sheet.popoverPresentationController?.sourceView = source; sheet.popoverPresentationController?.sourceRect = source.bounds; present(sheet, animated: true)
    }
    private func hide(_ post: Post) { Task { do { try await context.services.hide(post.id); context.timelines.hide(post.id); state.posts.removeAll { $0.id == post.id }; postDidHide(post.id); apply() } catch { showError(error) } } }
    private func removeBookmark(_ post: Post) { Task { do { try await context.services.command(.removeBookmark, ["postId": .string(post.id), "confirmed": .bool(true)]); context.timelines.hide(post.id); state.posts.removeAll { $0.id == post.id }; apply() } catch { showError(error) } } }
    deinit { imagePrefetch.values.forEach { $0.task.cancel() }; refreshTimer?.invalidate(); NotificationCenter.default.removeObserver(self) }
}

final class FeedHeader: UICollectionReusableView {
    private weak var installed: UIView?
    func install(_ header: UIView?) { installed?.removeFromSuperview(); guard let header else { return }; addSubview(header); header.pin(to: self); installed = header }
}
extension Array { subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil } }
