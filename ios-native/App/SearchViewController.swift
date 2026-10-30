import UIKit

final class SearchViewController: FeedViewController, UISearchResultsUpdating {
    private let search = UISearchController(searchResultsController: nil)
    private var searchTask: Task<Void, Never>?
    private var loaded: [Post] = []
    private var readIDs: [String] = []
    private var offset: Int?
    private var query = ""
    private var loading = false
    private var requestRevision: UInt64 = 0
    private var author = ""
    private var since: Date?
    init(context: ReaderContext) { super.init(context: context, route: .search) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        automaticallyLoads = false; super.viewDidLoad(); search.searchResultsUpdater = self; search.obscuresBackgroundDuringPresentation = false; search.searchBar.placeholder = L10n.text("searchStart"); search.searchBar.accessibilityIdentifier = "search.query"; navigationItem.searchController = search
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("filters"), style: .plain, target: self, action: #selector(searchFilters)); notice.show(L10n.text("searchScope"))
    }
    func updateSearchResults(for searchController: UISearchController) {
        searchTask?.cancel(); let next = String((searchController.searchBar.text ?? "").prefix(256)).trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self else { return }; requestRevision &+= 1; loading = false; query = next; highlightedText = next; loaded = []; readIDs = []; offset = 0
            if next.isEmpty { replacePosts([]); notice.show(L10n.text("searchScope")); return }; await loadSearch()
        }
    }
    private func loadSearch() async {
        guard let offset, !query.isEmpty, !loading else { return }; loading = true; let expected = query; let revision = requestRevision; defer { if requestRevision == revision { loading = false } }
        do {
            let result: SearchResponse = try await context.services.call(.searchCachedPosts, ["query": .string(expected), "offset": .number(Double(offset))])
            guard !Task.isCancelled, expected == query, requestRevision == revision else { return }; let ids = Set(loaded.map(\.id)); loaded += result.posts.filter { !ids.contains($0.id) }; readIDs += result.readIds; self.offset = result.nextOffset == offset ? nil : result.nextOffset
            if loaded.count > 300 { loaded = Array(loaded.suffix(300)); let retained = Set(loaded.map(\.id)); readIDs.removeAll { !retained.contains($0) } }
            replacePosts(loaded, readIDs: readIDs); status.text = L10n.text("searchScope"); showSearchState()
        } catch { notice.show(error.localizedDescription, retry: { [weak self] in Task { await self?.loadSearch() } }) }
    }
    override func refreshTapped() { requestRevision &+= 1; loading = false; loaded = []; readIDs = []; offset = 0; Task { await loadSearch() } }
    override func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) { super.collectionView(collectionView, willDisplay: cell, forItemAt: indexPath); if indexPath.item >= posts.count - 5 { Task { await loadSearch() } } }
    @objc private func searchFilters() {
        let editor = SearchFiltersViewController(context: context, author: author, since: since, filters: filters) { [weak self] author, since, filters in
            guard let self else { return }; self.author = author; self.since = since; self.filters = filters
            postPredicate = { post in (author.isEmpty || post.author.username.caseInsensitiveCompare(author) == .orderedSame) && (since == nil || ReaderDates.parse(post.createdAt).map { $0 >= since! } == true) }; apply(); showSearchState()
        }
        let nav = UINavigationController(rootViewController: editor); nav.sheetPresentationController?.detents = [.large()]; present(nav, animated: true)
    }
    private func showSearchState() {
        guard !query.isEmpty else { notice.show(L10n.text("searchScope")); return }
        if posts.isEmpty, offset != nil {
            notice.show(L10n.text("searchMore"), retry: { [weak self] in Task { await self?.loadSearch() } }, actionTitle: L10n.text("loadMore"))
        } else if posts.isEmpty { notice.show(L10n.text("searchEmpty")) }
        else { notice.show(nil) }
    }
    deinit { searchTask?.cancel() }
}

final class SearchFiltersViewController: ReaderScreen {
    private let author = UITextField()
    private let date = UIDatePicker()
    private let useDate = UISwitch()
    private let media = UISegmentedControl()
    private var filters: FeedFilters
    private let completion: (String, Date?, FeedFilters) -> Void
    init(context: ReaderContext, author: String, since: Date?, filters: FeedFilters, completion: @escaping (String, Date?, FeedFilters) -> Void) {
        self.filters = filters; self.completion = completion; super.init(context: context); self.author.text = author; useDate.isOn = since != nil; date.date = since ?? Date()
    }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("filters"); let scroll = UIScrollView(); view.addSubview(scroll); scroll.pin(to: view, safe: true)
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 18; stack.translatesAutoresizingMaskIntoConstraints = false; scroll.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20), stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)])
        stack.addArrangedSubview(readerLabel(L10n.text("searchScope"), style: .footnote, color: .secondaryLabel)); author.placeholder = L10n.text("authorFilter"); author.accessibilityLabel = L10n.text("authorFilter"); author.borderStyle = .roundedRect; author.autocapitalizationType = .none; author.font = .preferredFont(forTextStyle: .body); author.adjustsFontForContentSizeCategory = true; author.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; stack.addArrangedSubview(author)
        stack.addArrangedSubview(readerLabel(L10n.text("contentType"), style: .headline)); for (index, key) in ["all", "photos", "videos", "textOnly"].enumerated() { media.insertSegment(withTitle: L10n.text(key), at: index, animated: false) }; media.selectedSegmentIndex = filters.imagesOnly ? 1 : filters.videosOnly ? 2 : filters.textOnly ? 3 : 0; media.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; stack.addArrangedSubview(media)
        let row = UIStackView(arrangedSubviews: [readerLabel(L10n.text("minimumDate")), useDate]); row.spacing = 12; stack.addArrangedSubview(row); useDate.accessibilityLabel = L10n.text("minimumDate")
        date.datePickerMode = .date; date.preferredDatePickerStyle = .inline; date.maximumDate = Date(); date.isHidden = !useDate.isOn; stack.addArrangedSubview(date); useDate.addAction(UIAction { [weak self] _ in self?.date.isHidden = self?.useDate.isOn != true }, for: .valueChanged)
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("done"), style: .done, target: self, action: #selector(done)); navigationItem.leftBarButtonItem = UIBarButtonItem(title: L10n.text("clearFilters"), style: .plain, target: self, action: #selector(clear))
    }
    @objc private func clear() { author.text = ""; media.selectedSegmentIndex = 0; useDate.isOn = false; date.isHidden = true; filters = FeedFilters() }
    @objc private func done() { filters.imagesOnly = media.selectedSegmentIndex == 1; filters.videosOnly = media.selectedSegmentIndex == 2; filters.textOnly = media.selectedSegmentIndex == 3; completion(String((author.text ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "@ ")).prefix(15)), useDate.isOn ? Calendar.current.startOfDay(for: date.date) : nil, filters); dismiss(animated: true) }
}
