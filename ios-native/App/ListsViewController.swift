import UIKit

final class ListsViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate {
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let notice = NoticeView()
    private var lists: [ReaderList] = []
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("groups"); table.dataSource = self; table.delegate = self
        let stack = UIStackView(arrangedSubviews: [notice, table]); stack.axis = .vertical; view.addSubview(stack); stack.pin(to: view, safe: true)
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(create))
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); load() }
    private func load() {
        work = Task { [weak self] in guard let self else { return }; do { lists = try await context.services.call(.groups); table.reloadData(); notice.show(lists.isEmpty ? L10n.text("listEmpty") : nil) } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.load() }) } }
    }
    @objc private func create() { edit(nil) }
    private func edit(_ list: ReaderList?) {
        let editor = ListEditorViewController(context: context, list: list) { [weak self] in self?.load() }
        let nav = UINavigationController(rootViewController: editor); nav.sheetPresentationController?.detents = [.medium(), .large()]; present(nav, animated: true)
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { lists.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let list = lists[indexPath.row]; let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil); cell.textLabel?.text = list.name; cell.detailTextLabel?.text = "\(list.memberCount) · \(L10n.text("members"))"; cell.imageView?.image = UIImage(systemName: "books.vertical.fill"); cell.imageView?.tintColor = ReaderTheme.color(list.color); cell.accessoryType = .disclosureIndicator; return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { tableView.deselectRow(at: indexPath, animated: true); navigationController?.pushViewController(ListFeedViewController(context: context, list: lists[indexPath.row]), animated: true) }
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        let list = lists[indexPath.row]
        let edit = UIContextualAction(style: .normal, title: L10n.text("edit")) { [weak self] _, _, done in self?.edit(list); done(true) }
        let delete = UIContextualAction(style: .destructive, title: L10n.text("delete")) { [weak self] _, _, done in
            self?.confirm(title: L10n.text("deleteList"), message: list.name, action: L10n.text("delete"), destructive: true) { [weak self] in guard let self else { return }; Task { [self] in do { try await context.services.command(.deleteGroup, ["id": .string(list.id)]); load(); done(true) } catch { showError(error); done(false) } } }
        }; return UISwipeActionsConfiguration(actions: [delete, edit])
    }
}

final class ListEditorViewController: ReaderScreen, UIColorPickerViewControllerDelegate {
    private let list: ReaderList?
    private let completion: () -> Void
    private let nameField = UITextField()
    private var selectedColor: UIColor
    private var colorButton: UIButton!
    init(context: ReaderContext, list: ReaderList?, completion: @escaping () -> Void) { self.list = list; self.completion = completion; selectedColor = ReaderTheme.color(list?.color ?? "#6366f1") ?? .systemIndigo; super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text(list == nil ? "newList" : "edit")
        nameField.placeholder = L10n.text("name"); nameField.text = list?.name; nameField.borderStyle = .roundedRect; nameField.font = .preferredFont(forTextStyle: .body); nameField.adjustsFontForContentSizeCategory = true; nameField.accessibilityLabel = L10n.text("name"); nameField.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        colorButton = readerButton(L10n.text("color"), symbol: "circle.fill") { [weak self] in guard let self else { return }; let picker = UIColorPickerViewController(); picker.selectedColor = selectedColor; picker.supportsAlpha = false; picker.delegate = self; present(picker, animated: true) }; colorButton.tintColor = selectedColor
        let stack = UIStackView(arrangedSubviews: [nameField, colorButton]); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24)])
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: L10n.text("cancel"), style: .plain, target: self, action: #selector(cancel)); navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("save"), style: .done, target: self, action: #selector(save))
    }
    func colorPickerViewControllerDidSelectColor(_ viewController: UIColorPickerViewController) { selectedColor = viewController.selectedColor; colorButton.tintColor = selectedColor }
    @objc private func cancel() { dismiss(animated: true) }
    @objc private func save() {
        guard let name = nameField.text?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, name.count <= 80 else { nameField.becomeFirstResponder(); return }
        navigationItem.rightBarButtonItem?.isEnabled = false
        Task { do { try await context.services.command(list == nil ? .createGroup : .updateGroup, ["id": .string(list?.id ?? UUID().uuidString), "name": .string(name), "color": .string(selectedColor.hexString)]); completion(); dismiss(animated: true) } catch { navigationItem.rightBarButtonItem?.isEnabled = true; showError(error) } }
    }
}

final class ListFeedViewController: FeedViewController {
    let list: ReaderList
    init(context: ReaderContext, list: ReaderList) { self.list = list; super.init(context: context, route: .groups, source: "group:\(list.id)") }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        title = list.name; super.viewDidLoad()
        let members = UIBarButtonItem(title: L10n.text("editMembers"), style: .plain, target: self, action: #selector(editMembers))
        navigationItem.rightBarButtonItems = [members, navigationItem.rightBarButtonItem].compactMap { $0 }
    }
    @objc private func editMembers() { navigationController?.pushViewController(ListMembersViewController(context: context, list: list) { [weak self] in self?.load(refresh: true) }, animated: true) }
}

final class ListMembersViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate, UISearchResultsUpdating {
    private let list: ReaderList
    private let completion: () -> Void
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let notice = NoticeView()
    private let search = UISearchController(searchResultsController: nil)
    private var candidates: [GroupCandidate] = []
    private var shown: [GroupCandidate] = []
    private var original: Set<String> = []
    private var selected: Set<String> = []
    init(context: ReaderContext, list: ReaderList, completion: @escaping () -> Void) { self.list = list; self.completion = completion; super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("chooseMembers"); table.dataSource = self; table.delegate = self; search.searchResultsUpdater = self; search.obscuresBackgroundDuringPresentation = false; navigationItem.searchController = search
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("save"), style: .done, target: self, action: #selector(save))
        let stack = UIStackView(arrangedSubviews: [notice, table]); stack.axis = .vertical; view.addSubview(stack); stack.pin(to: view, safe: true); load()
    }
    private func load() { work = Task { [weak self] in guard let self else { return }; do { candidates = try await context.services.call(.groupCandidates, ["groupId": .string(list.id)]); original = Set(candidates.filter(\.member).map { $0.author.id }); selected = original; updateSearchResults(for: search); notice.show(candidates.isEmpty ? L10n.text("noPeople") : nil) } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.load() }) } } }
    func updateSearchResults(for searchController: UISearchController) { let query = searchController.searchBar.text ?? ""; shown = candidates.filter { query.isEmpty || $0.author.label.localizedCaseInsensitiveContains(query) || $0.author.username.localizedCaseInsensitiveContains(query) }; table.reloadData() }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { shown.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell { let item = shown[indexPath.row]; let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil); cell.textLabel?.text = item.author.label; cell.detailTextLabel?.text = "@\(item.author.username)" + (item.following ? "" : " · \(L10n.text("notFollowing"))"); cell.accessoryType = selected.contains(item.author.id) ? .checkmark : .none; return cell }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { let item = shown[indexPath.row]; if selected.contains(item.author.id) { selected.remove(item.author.id) } else if item.following { selected.insert(item.author.id) }; table.reloadRows(at: [indexPath], with: .none) }
    @objc private func save() {
        navigationItem.rightBarButtonItem?.isEnabled = false
        work = Task { [weak self] in guard let self else { return }; do {
            for id in original.symmetricDifference(selected) { try await context.services.command(.setGroupMember, ["groupId": .string(list.id), "authorId": .string(id), "member": .bool(selected.contains(id))]) }
            completion(); navigationController?.popViewController(animated: true)
        } catch { navigationItem.rightBarButtonItem?.isEnabled = true; showError(error); load() } }
    }
}

extension UIColor {
    var hexString: String { var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0; getRed(&r, green: &g, blue: &b, alpha: &a); return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255)) }
}
