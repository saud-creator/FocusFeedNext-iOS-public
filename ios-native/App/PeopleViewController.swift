import UIKit

private struct PersonItemIdentity: Hashable {
    let accountGeneration: UInt64
    let accountID: String
}

private final class PersonListCell: UICollectionViewListCell {
    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("Use registered cells") }
}

final class PeopleViewController: ReaderScreen, UICollectionViewDelegate, UISearchResultsUpdating {
    private(set) var collection: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Int, PersonItemIdentity>!
    private let notice = NoticeView()
    private let search = UISearchController(searchResultsController: nil)
    private var snapshot: FollowingSnapshot?
    private var snapshotGeneration: UInt64?
    private var people: [Author] = []
    private var authors: [String: Author] = [:]
    private var pinned: Set<String> = []
    private var allowed = false
    private var refreshing = false
    private var pendingProgressGeneration: UInt64?
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("accounts"); search.searchResultsUpdater = self; search.obscuresBackgroundDuringPresentation = false; search.searchBar.placeholder = L10n.text("searchPeople"); navigationItem.searchController = search
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.backgroundColor = .clear
        collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: configuration))
        collection.backgroundColor = .clear; collection.delegate = self; collection.alwaysBounceVertical = true
        collection.accessibilityIdentifier = "reader.people"
        let registration = UICollectionView.CellRegistration<PersonListCell, PersonItemIdentity> { [weak self] cell, _, item in
            guard let self, item.accountGeneration == context.services.accountGeneration, let author = authors[item.accountID] else { cell.contentConfiguration = nil; cell.accessories = []; return }
            var content = cell.defaultContentConfiguration()
            content.text = author.label + (pinned.contains(author.id) ? " 📌" : "")
            content.secondaryText = "@\(author.username)"
            content.textProperties.font = ReaderTheme.font(.body, preferences: context.preferences)
            content.secondaryTextProperties.font = ReaderTheme.font(.subheadline, preferences: context.preferences)
            content.textProperties.color = ReaderTheme.text(context.preferences)
            content.secondaryTextProperties.color = ReaderTheme.text(context.preferences, secondary: true)
            content.textProperties.numberOfLines = 0; content.secondaryTextProperties.numberOfLines = 0
            content.textProperties.adjustsFontForContentSizeCategory = true; content.secondaryTextProperties.adjustsFontForContentSizeCategory = true
            cell.contentConfiguration = content
            var background = UIBackgroundConfiguration.listPlainCell(); background.backgroundColor = ReaderTheme.surface(context.preferences)
            cell.backgroundConfiguration = background; cell.accessories = [.disclosureIndicator()]
            cell.accessibilityIdentifier = "person.\(item.accountGeneration).\(item.accountID)"
        }
        dataSource = UICollectionViewDiffableDataSource<Int, PersonItemIdentity>(collectionView: collection) { collection, indexPath, item in
            collection.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: item)
        }
        let refresh = UIRefreshControl(); refresh.addTarget(self, action: #selector(retry), for: .valueChanged); collection.refreshControl = refresh
        let column = UIStackView(arrangedSubviews: [notice, collection]); column.axis = .vertical; view.addSubview(column); column.pin(to: view, safe: true)
        NotificationCenter.default.addObserver(self, selector: #selector(progress), name: .readerFollowingChanged, object: context)
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let behavior = context.preferences.openBehavior(for: "accounts")
        if behavior == .reset { search.searchBar.text = ""; collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false) }
        load(startIfNeeded: true, refresh: behavior != .off)
    }
    @objc private func progress() {
        if refreshing { pendingProgressGeneration = context.services.accountGeneration; return }
        load(startIfNeeded: false)
    }
    @objc private func retry() {
        let generation = context.services.accountGeneration
        Task { [weak self] in
            guard let self, generation == context.services.accountGeneration else { return }
            do {
                let _: Bool = try await context.services.call(.startFollowingSync)
                guard generation == context.services.accountGeneration else { return }
                progress()
            } catch { if !(error is CancellationError) { notice.show(error.localizedDescription, retry: { [weak self] in self?.retry() }) } }
        }
    }
    private func load(startIfNeeded: Bool, refresh: Bool = false) {
        guard !refreshing else { pendingProgressGeneration = context.services.accountGeneration; return }; refreshing = true
        let generation = context.services.accountGeneration
        work = Task { [weak self] in
            guard let self else { return }
            defer {
                refreshing = false; collection.refreshControl?.endRefreshing()
                if let pending = pendingProgressGeneration {
                    pendingProgressGeneration = nil
                    if pending == context.services.accountGeneration { load(startIfNeeded: false) }
                }
            }
            do {
                if refresh { let _: Bool = try await context.services.call(.startFollowingSync) }
                let nextSnapshot: FollowingSnapshot = try await context.services.call(.followingSnapshot)
                let pins: [Author] = try await context.services.call(.pinnedAccounts)
                let nextAllowed: Bool = try await context.services.call(.unfollowAllowed)
                guard generation == context.services.accountGeneration else { throw CancellationError() }
                snapshot = nextSnapshot; snapshotGeneration = generation; pinned = Set(pins.map(\.id)); allowed = nextAllowed
                updatePeople()
                if let snapshot, !snapshot.complete, !snapshot.syncing, startIfNeeded, !refresh, snapshot.state != "failed", snapshot.state != "cancelled" {
                    let _: Bool = try await context.services.call(.startFollowingSync)
                    guard generation == context.services.accountGeneration else { throw CancellationError() }
                    self.snapshot = try await context.services.call(.followingSnapshot)
                    guard generation == context.services.accountGeneration else { throw CancellationError() }
                    updatePeople()
                }
                if let error = snapshot?.lastError { notice.show(error, retry: { [weak self] in self?.retry() }) }
                else if snapshot?.syncing == true { notice.show(L10n.text("followingProgress"), busy: true) }
                else if snapshot?.complete == false { notice.show(L10n.text("followingIncomplete"), retry: { [weak self] in self?.retry() }) }
                else { notice.show(people.isEmpty ? L10n.text("noPeople") : nil) }
            } catch { if !(error is CancellationError) { notice.show(error.localizedDescription, retry: { [weak self] in self?.retry() }) } }
        }
    }
    private func updatePeople() {
        let query = search.searchBar.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var seen = Set<String>()
        let accounts = snapshotGeneration == context.services.accountGeneration ? snapshot?.accounts ?? [] : []
        people = accounts.filter { (query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) || $0.username.localizedCaseInsensitiveContains(query)) && seen.insert($0.id).inserted }
        authors = Dictionary(uniqueKeysWithValues: people.map { ($0.id, $0) })
        guard dataSource != nil else { return }
        let previous = Set(dataSource.snapshot().itemIdentifiers)
        let items = people.map { PersonItemIdentity(accountGeneration: context.services.accountGeneration, accountID: $0.id) }
        var next = NSDiffableDataSourceSnapshot<Int, PersonItemIdentity>(); next.appendSections([0]); next.appendItems(items)
        next.reconfigureItems(items.filter { previous.contains($0) })
        dataSource.apply(next, animatingDifferences: false)
    }
    func updateSearchResults(for searchController: UISearchController) { updatePeople() }
    private func person(at indexPath: IndexPath) -> (PersonItemIdentity, Author)? {
        guard let item = dataSource.itemIdentifier(for: indexPath), item.accountGeneration == context.services.accountGeneration, let author = authors[item.accountID] else { return nil }
        return (item, author)
    }
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) { collectionView.deselectItem(at: indexPath, animated: true); if let (_, author) = person(at: indexPath) { openProfile(author.username) } }
    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard let (item, author) = person(at: indexPath) else { return nil }
        return UIContextMenuConfiguration(identifier: author.id as NSString, previewProvider: nil) { [weak self] _ in
            guard let self, item.accountGeneration == context.services.accountGeneration else { return nil }
            var actions: [UIMenuElement] = [UIAction(title: L10n.text(pinned.contains(author.id) ? "unpin" : "pin"), image: UIImage(systemName: "pin")) { [weak self] _ in self?.pin(author, generation: item.accountGeneration) }, UIAction(title: L10n.text("addToList"), image: UIImage(systemName: "books.vertical")) { [weak self] _ in self?.addToList(author, generation: item.accountGeneration) }]
            if allowed && context.capabilities?.unfollow == true { actions.append(UIAction(title: L10n.text("unfollow"), attributes: .destructive) { [weak self] _ in self?.unfollow(author, generation: item.accountGeneration) }) }
            return UIMenu(children: actions)
        }
    }
    private func pin(_ author: Author, generation: UInt64) { Task { guard generation == context.services.accountGeneration else { return }; do { try await context.services.command(.pinAccount, ["authorId": .string(author.id), "pinned": .bool(!pinned.contains(author.id))]); load(startIfNeeded: false) } catch { showError(error) } } }
    private func addToList(_ author: Author, generation: UInt64) {
        Task { guard generation == context.services.accountGeneration else { return }; do {
            let groups: [ReaderList] = try await context.services.call(.groups)
            guard generation == context.services.accountGeneration else { return }
            let sheet = UIAlertController(title: L10n.text("addToList"), message: groups.isEmpty ? L10n.text("listEmpty") : nil, preferredStyle: .actionSheet)
            for group in groups { sheet.addAction(UIAlertAction(title: group.name, style: .default) { [weak self] _ in guard let self else { return }; Task { [self] in guard generation == self.context.services.accountGeneration else { return }; do { try await self.context.services.command(.setGroupMember, ["groupId": .string(group.id), "authorId": .string(author.id), "member": .bool(true)]) } catch { self.showError(error) } } }) }
            sheet.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); sheet.popoverPresentationController?.sourceView = view; sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1); present(sheet, animated: true)
        } catch { showError(error) } }
    }
    private func unfollow(_ author: Author, generation: UInt64) {
        guard generation == context.services.accountGeneration else { return }
        confirm(title: "\(L10n.text("unfollow")) @\(author.username)?", message: L10n.text("unfollowBody") + "\n" + L10n.text("actionNoRetry"), action: L10n.text("unfollow"), destructive: true) { [weak self] in
            guard let self else { return }; Task { [self] in guard generation == self.context.services.accountGeneration else { return }; do { try await self.context.services.command(.unfollow, ["username": .string(author.username), "confirmed": .bool(true)]); self.load(startIfNeeded: false) } catch { self.showError(error) } }
        }
    }
    deinit { NotificationCenter.default.removeObserver(self) }
}
