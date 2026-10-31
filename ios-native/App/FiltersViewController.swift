import UIKit

final class FiltersViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate {
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private var filters: FeedFilters
    private let applyFilters: (FeedFilters) -> Void
    private var presets: [FilterPreset] = []
    init(context: ReaderContext, filters: FeedFilters, apply: @escaping (FeedFilters) -> Void) { self.filters = filters; applyFilters = apply; super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("filters"); table.dataSource = self; table.delegate = self; view.addSubview(table); table.pin(to: view, safe: true)
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("done"), style: .done, target: self, action: #selector(done))
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: L10n.text("clearFilters"), style: .plain, target: self, action: #selector(reset))
        Task { [weak self] in guard let self else { return }; do { presets = try await context.services.presets(); table.reloadData() } catch { showError(error) } }
    }
    @objc private func done() { applyFilters(filters); dismiss(animated: true) }
    @objc private func reset() { filters = FeedFilters(); table.reloadData() }
    func numberOfSections(in tableView: UITableView) -> Int { 3 }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 0 ? 3 : section == 1 ? 2 : presets.count + 1 }
    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { section == 0 ? L10n.text("filters") : section == 1 ? L10n.text("contentType") : L10n.text("preset") }
    func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { section == 0 ? L10n.text("adsExcluded") : nil }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil)
        if indexPath.section == 0 {
            let key = ["noReposts", "unreadOnly", "hideRead"][indexPath.row]; cell.textLabel?.text = L10n.text(key)
            let toggle = UISwitch(); toggle.isOn = [filters.hideReposts, filters.unreadOnly, filters.hideRead][indexPath.row]; toggle.accessibilityLabel = L10n.text(key); toggle.tag = indexPath.row; toggle.addTarget(self, action: #selector(toggled(_:)), for: .valueChanged); cell.accessoryView = toggle
        } else if indexPath.section == 1 {
            let button = UIButton(type: .system); button.showsMenuAsPrimaryAction = true
            if indexPath.row == 0 {
                cell.textLabel?.text = L10n.text("contentType"); let selected = filters.imagesOnly ? 1 : filters.videosOnly ? 2 : filters.textOnly ? 3 : 0
                button.setTitle(L10n.text(["all", "photos", "videos", "textOnly"][selected]), for: .normal)
                button.menu = UIMenu(children: ["all", "photos", "videos", "textOnly"].enumerated().map { index, key in UIAction(title: L10n.text(key), state: selected == index ? .on : .off) { [weak self] _ in self?.filters.imagesOnly = index == 1; self?.filters.videosOnly = index == 2; self?.filters.textOnly = index == 3; self?.table.reloadData() } })
            } else {
                cell.textLabel?.text = L10n.text("maximumAge"); button.setTitle(filters.maxAgeHours == 0 ? L10n.text("anyTime") : L10n.hours(filters.maxAgeHours), for: .normal)
                button.menu = UIMenu(children: [0, 6, 24, 72, 168].map { hours in UIAction(title: hours == 0 ? L10n.text("anyTime") : L10n.hours(hours), state: filters.maxAgeHours == hours ? .on : .off) { [weak self] _ in self?.filters.maxAgeHours = hours; self?.table.reloadData() } })
            }
            button.sizeToFit(); button.frame.size.height = max(44, button.frame.height); cell.accessoryView = button
        } else { cell.textLabel?.text = indexPath.row < presets.count ? presets[indexPath.row].name : L10n.text("savePreset"); cell.accessoryType = .disclosureIndicator }
        return cell
    }
    @objc private func toggled(_ sender: UISwitch) { if sender.tag == 0 { filters.hideReposts = sender.isOn } else if sender.tag == 1 { filters.unreadOnly = sender.isOn } else { filters.hideRead = sender.isOn } }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true); guard indexPath.section == 2 else { return }
        if indexPath.row < presets.count { filters = presets[indexPath.row].filters; table.reloadData(); return }
        let alert = UIAlertController(title: L10n.text("savePreset"), message: nil, preferredStyle: .alert); alert.addTextField { $0.placeholder = L10n.text("name") }
        alert.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); alert.addAction(UIAlertAction(title: L10n.text("save"), style: .default) { [weak self, weak alert] _ in
            guard let self, let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, name.count <= 80 else { return }
            let next = self.presets + [FilterPreset(id: UUID().uuidString, name: name, filters: self.filters)]
            Task { [self] in do { try await self.context.services.savePresets(next); self.presets = next; self.table.reloadData() } catch { self.showError(error) } }
        }); present(alert, animated: true)
    }
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard indexPath.section == 2, indexPath.row < presets.count else { return nil }
        let action = UIContextualAction(style: .destructive, title: L10n.text("delete")) { [weak self] _, _, done in
            guard let self else { done(false); return }; var next = self.presets; next.remove(at: indexPath.row)
            Task { [self] in do { try await self.context.services.savePresets(next); self.presets = next; self.table.reloadData(); done(true) } catch { self.showError(error); done(false) } }
        }; return UISwipeActionsConfiguration(actions: [action])
    }
}
