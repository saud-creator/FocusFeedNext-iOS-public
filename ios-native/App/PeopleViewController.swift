import UIKit

final class PeopleViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate, UISearchResultsUpdating {
    private let table = UITableView(frame: .zero, style: .plain)
    private let notice = NoticeView()
    private let search = UISearchController(searchResultsController: nil)
    private var snapshot: FollowingSnapshot?
    private var people: [Author] = []
    private var pinned: Set<String> = []
    private var allowed = false
    private var refreshing = false
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("accounts"); search.searchResultsUpdater = self; search.obscuresBackgroundDuringPresentation = false; search.searchBar.placeholder = L10n.text("searchPeople"); navigationItem.searchController = search
        table.dataSource = self; table.delegate = self; table.rowHeight = UITableView.automaticDimension; table.estimatedRowHeight = 76
        let refresh = UIRefreshControl(); refresh.addTarget(self, action: #selector(retry), for: .valueChanged); table.refreshControl = refresh
        let column = UIStackView(arrangedSubviews: [notice, table]); column.axis = .vertical; view.addSubview(column); column.pin(to: view, safe: true)
        NotificationCenter.default.addObserver(self, selector: #selector(progress), name: .readerFollowingChanged, object: context)
        load(startIfNeeded: true)
    }
    @objc private func progress() { load(startIfNeeded: false) }
    @objc private func retry() { Task { [weak self] in guard let self else { return }; do { let _: Bool = try await context.services.call(.startFollowingSync); load(startIfNeeded: false) } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.retry() }) } } }
    private func load(startIfNeeded: Bool) {
        guard !refreshing else { return }; refreshing = true
        work = Task { [weak self] in
            guard let self else { return }; defer { refreshing = false; table.refreshControl?.endRefreshing() }
            do {
                snapshot = try await context.services.call(.followingSnapshot)
                let pins: [Author] = try await context.services.call(.pinnedAccounts); pinned = Set(pins.map(\.id)); allowed = try await context.services.call(.unfollowAllowed)
                updatePeople()
                if let snapshot, !snapshot.complete, !snapshot.syncing, startIfNeeded, snapshot.state != "failed", snapshot.state != "cancelled" { let _: Bool = try await context.services.call(.startFollowingSync) }
                if let error = snapshot?.lastError { notice.show(error, retry: { [weak self] in self?.retry() }) }
                else if snapshot?.syncing == true { notice.show(L10n.text("followingProgress"), busy: true) }
                else if snapshot?.complete == false { notice.show(L10n.text("followingIncomplete"), retry: { [weak self] in self?.retry() }) }
                else { notice.show(people.isEmpty ? L10n.text("noPeople") : nil) }
            } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.retry() }) }
        }
    }
    private func updatePeople() {
        let query = search.searchBar.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        people = (snapshot?.accounts ?? []).filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) || $0.username.localizedCaseInsensitiveContains(query) }; table.reloadData()
    }
    func updateSearchResults(for searchController: UISearchController) { updatePeople() }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { people.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let author = people[indexPath.row]; let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil); cell.textLabel?.text = author.label + (pinned.contains(author.id) ? " 📌" : ""); cell.detailTextLabel?.text = "@\(author.username)"; cell.accessoryType = .disclosureIndicator; return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { tableView.deselectRow(at: indexPath, animated: true); openProfile(people[indexPath.row].username) }
    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        let author = people[indexPath.row]
        return UIContextMenuConfiguration(identifier: author.id as NSString, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            var actions: [UIMenuElement] = [UIAction(title: L10n.text(pinned.contains(author.id) ? "unpin" : "pin"), image: UIImage(systemName: "pin")) { [weak self] _ in self?.pin(author) }, UIAction(title: L10n.text("addToList"), image: UIImage(systemName: "books.vertical")) { [weak self] _ in self?.addToList(author) }]
            if allowed && context.capabilities?.unfollow == true { actions.append(UIAction(title: L10n.text("unfollow"), attributes: .destructive) { [weak self] _ in self?.unfollow(author) }) }
            return UIMenu(children: actions)
        }
    }
    private func pin(_ author: Author) { Task { do { try await context.services.command(.pinAccount, ["authorId": .string(author.id), "pinned": .bool(!pinned.contains(author.id))]); load(startIfNeeded: false) } catch { showError(error) } } }
    private func addToList(_ author: Author) {
        Task { do {
            let groups: [ReaderList] = try await context.services.call(.groups)
            let sheet = UIAlertController(title: L10n.text("addToList"), message: groups.isEmpty ? L10n.text("listEmpty") : nil, preferredStyle: .actionSheet)
            for group in groups { sheet.addAction(UIAlertAction(title: group.name, style: .default) { [weak self] _ in guard let self else { return }; Task { do { try await context.services.command(.setGroupMember, ["groupId": .string(group.id), "authorId": .string(author.id), "member": .bool(true)]) } catch { showError(error) } } }) }
            sheet.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); sheet.popoverPresentationController?.sourceView = view; sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1); present(sheet, animated: true)
        } catch { showError(error) } }
    }
    private func unfollow(_ author: Author) {
        confirm(title: "\(L10n.text("unfollow")) @\(author.username)?", message: L10n.text("unfollowBody") + "\n" + L10n.text("actionNoRetry"), action: L10n.text("unfollow"), destructive: true) { [weak self] in
            guard let self else { return }; Task { do { try await context.services.command(.unfollow, ["username": .string(author.username), "confirmed": .bool(true)]); load(startIfNeeded: false) } catch { showError(error) } }
        }
    }
    deinit { NotificationCenter.default.removeObserver(self) }
}
