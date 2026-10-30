import UIKit
import UniformTypeIdentifiers

/// A single draft belongs to the whole settings flow, including child screens.
@MainActor final class SettingsDraft {
    var preferences: ReaderPreferences
    var original: ReaderPreferences
    var resume: ResumeState?
    var resumeEnabled = false
    var originalResumeEnabled = false
    var dirty: Bool { preferences.values != original.values || resumeEnabled != originalResumeEnabled }
    init(_ preferences: ReaderPreferences) { self.preferences = preferences; original = preferences }
    func cancel() { preferences = original; resumeEnabled = originalResumeEnabled }
}

final class SettingsViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate, UIDocumentPickerDelegate {
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let categories = ["account", "appearance", "reading", "media", "performance", "navigation", "privacy", "about"]
    private let draft: SettingsDraft
    private let notice = NoticeView()
    init(context: ReaderContext) { draft = SettingsDraft(context.preferences); super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("settings"); view.accessibilityIdentifier = "settings.root"
        table.dataSource = self; table.delegate = self
        let stack = UIStackView(arrangedSubviews: [notice, table]); stack.axis = .vertical; view.addSubview(stack); stack.pin(to: view, safe: true)
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("save"), style: .done, target: self, action: #selector(save))
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: L10n.text("close"), style: .plain, target: self, action: #selector(close))
        Task { [weak self] in
            guard let self, context.session?.hasCredentials == true else { return }
            do { draft.resume = try await context.services.resumeState(); draft.resumeEnabled = draft.resume?.enabled == true; draft.originalResumeEnabled = draft.resumeEnabled }
            catch { notice.show(error.localizedDescription) }
        }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); preview(); table.reloadData(); navigationController?.interactivePopGestureRecognizer?.isEnabled = !draft.dirty
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController?.isBeingDismissed == true { L10n.language = context.preferences.string("language"); navigationController?.interactivePopGestureRecognizer?.isEnabled = true; ReaderTheme.apply(context.preferences, to: navigationController ?? self) }
    }
    private func preview() { ReaderTheme.apply(draft.preferences, to: navigationController ?? self) }
    func numberOfSections(in tableView: UITableView) -> Int { 2 }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 0 ? categories.count : 2 }
    func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { section == 1 ? L10n.text("preferenceTransferHint") : nil }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil)
        let key = indexPath.section == 0 ? categories[indexPath.row] : indexPath.row == 0 ? "importPreferences" : "exportPreferences"
        cell.textLabel?.text = L10n.text(key); cell.accessoryType = .disclosureIndicator; cell.accessibilityIdentifier = "settings.\(key)"
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if indexPath.section == 0 {
            let detail = SettingsDetailViewController(context: context, draft: draft, category: categories[indexPath.row], save: { [weak self] in self?.save() })
            navigationController?.pushViewController(detail, animated: true)
        } else if indexPath.row == 0 {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true); picker.delegate = self; present(picker, animated: true)
        } else { exportPreferences() }
    }
    @objc private func close() {
        if !draft.dirty { leave(); return }
        let alert = UIAlertController(title: L10n.text("unsaved"), message: L10n.text("saveDraftHint"), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L10n.text("keepEditing"), style: .cancel))
        alert.addAction(UIAlertAction(title: L10n.text("discard"), style: .destructive) { [weak self] _ in self?.draft.cancel(); self?.leave() })
        present(alert, animated: true)
    }
    private func leave() {
        L10n.language = context.preferences.string("language"); ReaderTheme.apply(context.preferences, to: navigationController ?? self)
        if navigationController?.viewControllers.first === self { dismiss(animated: true) }
        else { navigationController?.popViewController(animated: true) }
    }
    @objc private func save() {
        guard work == nil else { return }; navigationItem.rightBarButtonItem?.isEnabled = false
        work = Task { [weak self] in
            guard let self else { return }; defer { work = nil; navigationItem.rightBarButtonItem?.isEnabled = true }
            do {
                try await context.save(draft.preferences)
                if draft.resumeEnabled != draft.originalResumeEnabled, context.session?.hasCredentials == true {
                    var marker = draft.resume ?? ResumeState(enabled: false, route: "following", postID: nil, offset: 0, accountID: context.session?.account?.id)
                    marker.enabled = draft.resumeEnabled; try await context.services.saveResumeState(marker); draft.resume = marker
                }
                draft.original = draft.preferences; draft.originalResumeEnabled = draft.resumeEnabled; table.reloadData(); notice.show(L10n.text("saved")); navigationController?.interactivePopGestureRecognizer?.isEnabled = true
            } catch { showError(error) }
        }
    }
    private func exportPreferences() {
        do {
            let bundle = PreferenceDocument(version: 1, preferences: draft.preferences.portableEntries)
            let encoded = try JSONEncoder().encode(bundle)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("FocusFeedNext-preferences-\(UUID().uuidString).json")
            try encoded.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file) }
            sheet.popoverPresentationController?.sourceView = table; sheet.popoverPresentationController?.sourceRect = table.bounds
            present(sheet, animated: true)
        } catch { showError(error) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 32768 else { throw invalidPreferences() }
            let data = try Data(contentsOf: url); guard data.count <= 32768 else { throw invalidPreferences() }
            let bundle = try JSONDecoder().decode(PreferenceDocument.self, from: data)
            let values = try bundle.validated(over: draft.preferences)
            draft.preferences = values; preview(); table.reloadData(); notice.show(L10n.text("importDraft"))
        } catch { showError(invalidPreferences()) }
    }
}

struct PreferenceDocument: Codable {
    var version: Int
    var preferences: [[String]]
    func validated(over current: ReaderPreferences) throws -> ReaderPreferences {
        guard version == 1, preferences.count <= 80 else { throw invalidPreferences() }
        let eligible = Set(current.portableEntries.map { $0[0] }); var seen = Set<String>(); var next = current
        for pair in preferences {
            guard pair.count == 2, eligible.contains(pair[0]), seen.insert(pair[0]).inserted, pair[1].utf8.count <= 4096, valid(key: pair[0], value: pair[1]) else { throw invalidPreferences() }
            next.set(pair[0], pair[1])
        }
        return next
    }
    private func valid(key: String, value: String) -> Bool {
        let enumerated: [String: Set<String>] = ["language":["system", "en", "ar"], "theme":["system", "dark", "oled", "light"], "density":["comfortable", "compact"], "performance.mode":["balanced", "fast", "battery", "ultra"], "video.autoplay":["off", "wifi", "any"], "appearance.shadow":["none", "soft", "strong"], "appearance.timestampStyle":["relative", "absolute"], "video.quality":["auto", "best", "1080", "720", "480", "360"]]
        if let choices = enumerated[key] { return choices.contains(value) }
        if key.hasPrefix("pages.openBehavior") { return ["", "off", "refresh", "reset"].contains(value) }
        let numeric: [String: ClosedRange<Double>] = ["appearance.radius":0...24, "appearance.textContrast":0...100, "reading.size":80...160, "monitoring.intervalMinutes":1...60, "content.readDelayMs":0...10000, "content.autoRefreshMinutes":0...240, "video.defaultSpeed":0.25...4]
        if let range = numeric[key] { guard let number = Double(value), number.isFinite, range.contains(number) else { return false }; return key == "monitoring.intervalMinutes" ? Int(value) != nil : true }
        if ["appearance.accent", "appearance.background", "appearance.surface", "appearance.elevated", "appearance.border", "appearance.mediaBackground"].contains(key) { return value.isEmpty || value.range(of: "^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$", options: .regularExpression) != nil }
        if key == "navigation.tabs" { guard let data = value.data(using: .utf8), let tabs = try? JSONDecoder().decode([ReaderRoute].self, from: data) else { return false }; return tabs.count == 4 && Set(tabs).count == 4 && !tabs.contains(.settings) }
        return ["true", "false"].contains(value)
    }
}
private func invalidPreferences() -> AppServiceError { AppServiceError(code: "invalid_preferences", message: L10n.text("invalidImport")) }

private enum SettingKind {
    case toggle, choices([(String, String)]), number([Double]), color
}
private struct SettingDefinition { let key: String; let title: String; let kind: SettingKind }

final class SettingsDetailViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate, UIColorPickerViewControllerDelegate {
    private let draft: SettingsDraft
    private let category: String
    private let saveDraft: () -> Void
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private var colorKey: String?
    private var resumeSwitch: UISwitch?
    init(context: ReaderContext, draft: SettingsDraft, category: String, save: @escaping () -> Void) { self.draft = draft; self.category = category; saveDraft = save; super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use settings draft") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text(category); view.accessibilityIdentifier = "settings.detail.\(category)"
        table.dataSource = self; table.delegate = self; table.rowHeight = UITableView.automaticDimension; table.estimatedRowHeight = 60; view.addSubview(table); table.pin(to: view, safe: true)
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: L10n.text("save"), style: .done, target: self, action: #selector(save))
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); ReaderTheme.apply(draft.preferences, to: self); table.reloadData() }
    @objc private func save() { saveDraft() }
    private var fields: [SettingDefinition] {
        func choice(_ key: String, _ title: String, _ values: [String]) -> SettingDefinition { SettingDefinition(key: key, title: title, kind: .choices(values.map { ($0, L10n.text($0)) })) }
        func toggle(_ key: String, _ title: String) -> SettingDefinition { SettingDefinition(key: key, title: title, kind: .toggle) }
        func number(_ key: String, _ title: String, _ values: [Double]) -> SettingDefinition { SettingDefinition(key: key, title: title, kind: .number(values)) }
        switch category {
        case "appearance":
            return [choice("theme", "theme", ["system", "light", "dark", "oled"]), choice("language", "language", ["system", "en", "ar"]), choice("density", "density", ["comfortable", "compact"]), number("appearance.radius", "radius", [0, 4, 8, 12, 16, 20, 24]), choice("appearance.shadow", "shadow", ["none", "soft", "strong"])] + ["accent", "background", "surface", "elevated", "border", "mediaBackground"].map { SettingDefinition(key: "appearance.\($0)", title: $0, kind: .color) } + [number("appearance.textContrast", "contrast", [0, 25, 50, 75, 100])]
        case "reading":
            return [number("reading.size", "readingSize", [80, 90, 100, 110, 120, 140, 160]), choice("appearance.timestampStyle", "timestamps", ["relative", "absolute"]), toggle("appearance.collapseLongPosts", "collapseLong"), toggle("content.hideReposts", "noReposts"), toggle("content.unreadOnly", "unreadOnly"), number("content.readDelayMs", "readDelay", [0, 500, 1000, 1500, 2000, 3000, 5000, 10000]), number("content.autoRefreshMinutes", "autoRefresh", [0, 1, 5, 15, 30, 60, 120, 240]), choice("pages.openBehavior", "pageOpen", ["off", "refresh", "reset"])] + ["following", "bookmarks", "accounts", "groups", "profile"].map { SettingDefinition(key: "pages.openBehavior.\($0)", title: "pageOpen.\($0)", kind: .choices([("", L10n.text("inherit")), ("off", L10n.text("keepLoaded")), ("refresh", L10n.text("refresh")), ("reset", L10n.text("resetPage"))])) }
        case "media":
            return [choice("video.autoplay", "autoplay", ["off", "wifi", "any"]), choice("video.quality", "quality", ["auto", "best", "1080", "720", "480", "360"]), number("video.defaultSpeed", "speed", [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]), toggle("video.loop", "loop"), toggle("video.gifAutoplay", "gifAutoplay"), toggle("video.clickToggle", "tapPlay"), toggle("video.offscreenCleanup", "offscreenCleanup")]
        case "performance":
            return [choice("performance.mode", "performance", ["balanced", "fast", "ultra", "battery"]), toggle("appearance.haptics", "haptics"), toggle("startup.preloadBookmarks", "preloadBookmarks"), toggle("startup.preloadFollowing", "preloadFollowing"), toggle("monitoring.autoCheck", "autoCheck"), number("monitoring.intervalMinutes", "monitorInterval", [1, 2, 5, 10, 15, 30, 60])]
        case "account": return [toggle("actions.allowUnfollow", "allowAccountActions"), toggle("actions.advanced", "advancedActions")]
        default: return []
        }
    }
    private var actionKeys: [String] {
        switch category {
        case "account": return context.session?.hasCredentials == true ? ["accountIdentity", "checkConnection", "recover", "switchAccount", "signOut"] : ["signIn"]
        case "reading": return ["mutedWords"]
        case "privacy": return ["resume", "diagnostics", "clearSession"]
        case "about": return ["version", "source", "privacyBody"]
        default: return []
        }
    }
    func numberOfSections(in tableView: UITableView) -> Int { 2 }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 0 ? (category == "navigation" ? 4 : fields.count) : actionKeys.count }
    func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        guard section == 0 else { return category == "privacy" ? L10n.text("privacyBody") : nil }
        if category == "performance" { let policy = ImagePrefetchPolicy.effective(mode: draft.preferences.string("performance.mode"), runtime: context.runtime); return L10n.text("performanceHint") + "\n\n" + L10n.text(policy.capacity == 0 ? "prefetchPaused" : "prefetchActive") }
        return category == "media" ? L10n.text("nativeCleanup") : category == "privacy" ? L10n.text("resumeHint") : nil
    }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil)
        if indexPath.section == 0, category == "navigation" {
            cell.textLabel?.text = "\(L10n.text("tab")) \((indexPath.row + 1).formatted(.number.locale(L10n.locale)))"
            let tabs = draft.preferences.tabs; let button = UIButton(type: .system); button.showsMenuAsPrimaryAction = true; button.setTitle(tabs[indexPath.row].title, for: .normal)
            button.menu = UIMenu(children: ReaderRoute.allCases.filter { $0 != .settings }.map { route in UIAction(title: route.title, state: tabs[indexPath.row] == route ? .on : .off) { [weak self] _ in guard let self else { return }; var next = draft.preferences.tabs; if let old = next.firstIndex(of: route) { next[old] = next[indexPath.row] }; next[indexPath.row] = route; draft.preferences.setTabs(next); table.reloadData() } })
            button.sizeToFit(); button.frame.size.height = max(44, button.frame.height); cell.accessoryView = button; return cell
        }
        if indexPath.section == 0 {
            let field = fields[indexPath.row]; cell.textLabel?.text = L10n.text(field.title); cell.accessibilityIdentifier = "setting.\(field.key)"
            switch field.kind {
            case .toggle:
                let toggle = UISwitch(); toggle.isOn = draft.preferences.bool(field.key); toggle.accessibilityLabel = L10n.text(field.title)
                toggle.addAction(UIAction { [weak self, weak toggle] _ in guard let self, let toggle else { return }; changed(field.key, toggle.isOn ? "true" : "false") }, for: .valueChanged); cell.accessoryView = toggle
            case .choices(let choices):
                let current = draft.preferences.string(field.key); cell.detailTextLabel?.text = choices.first(where: { $0.0 == current })?.1 ?? current
                cell.accessoryType = .disclosureIndicator
            case .number:
                cell.detailTextLabel?.text = formatted(draft.preferences.number(field.key), key: field.key); cell.accessoryType = .disclosureIndicator
            case .color:
                let value = draft.preferences.string(field.key); cell.detailTextLabel?.text = value.isEmpty ? L10n.text("system") : value; cell.imageView?.image = UIImage(systemName: "circle.fill"); cell.imageView?.tintColor = ReaderTheme.color(value) ?? .systemGray; cell.accessoryType = .disclosureIndicator
            }
            return cell
        }
        let key = actionKeys[indexPath.row]; cell.textLabel?.text = L10n.text(key); cell.accessoryType = .disclosureIndicator
        if key == "accountIdentity" { cell.textLabel?.text = context.session?.account?.label; cell.detailTextLabel?.text = context.session?.account.map { "@\($0.username)" }; cell.accessoryType = .none }
        if key == "resume" { let toggle = UISwitch(); toggle.isOn = draft.resumeEnabled; toggle.isEnabled = context.session?.hasCredentials == true; toggle.accessibilityLabel = L10n.text("resume"); toggle.addAction(UIAction { [weak self, weak toggle] _ in self?.draft.resumeEnabled = toggle?.isOn == true }, for: .valueChanged); cell.accessoryView = toggle; cell.detailTextLabel?.text = L10n.text("resumeHint"); cell.accessoryType = .none; resumeSwitch = toggle }
        if key == "version" { cell.detailTextLabel?.text = "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.10.0") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))"; cell.accessoryType = .none }
        if key == "source" { cell.detailTextLabel?.text = sourceCommit(); cell.accessoryType = .none }
        if key == "privacyBody" { cell.textLabel?.text = L10n.text("nativeReader"); cell.detailTextLabel?.text = L10n.text("privacyBody"); cell.accessoryType = .none }
        if ["signOut", "clearSession"].contains(key) { cell.textLabel?.textColor = .systemRed }
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if indexPath.section == 0 {
            guard category != "navigation" else { return }; let field = fields[indexPath.row]
            switch field.kind {
            case .toggle: changed(field.key, draft.preferences.bool(field.key) ? "false" : "true")
            case .choices(let choices): choose(field, choices: choices)
            case .number(let values): choose(field, choices: values.map { ($0.rounded() == $0 ? String(Int($0)) : String($0), formatted($0, key: field.key)) })
            case .color:
                colorKey = field.key; let picker = UIColorPickerViewController(); picker.supportsAlpha = false; picker.selectedColor = ReaderTheme.color(draft.preferences.string(field.key)) ?? .systemIndigo; picker.delegate = self; present(picker, animated: true)
            }
            return
        }
        let action = actionKeys[indexPath.row]
        switch action {
        case "signIn", "switchAccount":
            work = Task { [weak self] in guard let self else { return }; do { let snapshot = try await context.services.signIn(presenting: self); await context.accept(snapshot); table.reloadData() } catch { showError(error) } }
        case "signOut": confirm(title: L10n.text("signOut"), message: L10n.text("signOutHint"), action: L10n.text("signOut"), destructive: true) { [weak self] in self?.run(.disconnect, refreshSession: true) }
        case "checkConnection": run(.checkSession, refreshSession: true)
        case "recover": work = Task { [weak self] in do { try await self?.context.services.recoverMedia() } catch { self?.showError(error) } }
        case "clearSession": confirm(title: L10n.text("clearSession"), message: L10n.text("clearSessionBody"), action: L10n.text("delete"), destructive: true) { [weak self] in self?.run(.clearCache) }
        case "diagnostics": navigationController?.pushViewController(DiagnosticsViewController(context: context), animated: true)
        case "mutedWords": navigationController?.pushViewController(MutedWordsViewController(context: context), animated: true)
        default: break
        }
    }
    private func run(_ operation: AppOperation, refreshSession: Bool = false) {
        work = Task { [weak self] in guard let self else { return }; do { if refreshSession { let snapshot: SessionSnapshot = try await context.services.call(operation); await context.accept(snapshot) } else { try await context.services.command(operation) }; table.reloadData() } catch { showError(error) } }
    }
    private func changed(_ key: String, _ value: String) { draft.preferences.set(key, value); ReaderTheme.apply(draft.preferences, to: navigationController ?? self); table.reloadData() }
    private func choose(_ field: SettingDefinition, choices: [(String, String)]) {
        let alert = UIAlertController(title: L10n.text(field.title), message: nil, preferredStyle: .actionSheet)
        for (value, title) in choices { alert.addAction(UIAlertAction(title: title, style: .default) { [weak self] _ in self?.changed(field.key, value) }) }
        if case .color = field.kind { alert.addAction(UIAlertAction(title: L10n.text("system"), style: .default) { [weak self] _ in self?.changed(field.key, "") }) }
        alert.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); alert.popoverPresentationController?.sourceView = table; alert.popoverPresentationController?.sourceRect = table.bounds; present(alert, animated: true)
    }
    private func formatted(_ value: Double, key: String) -> String {
        if value == 0 && ["content.readDelayMs", "content.autoRefreshMinutes"].contains(key) { return L10n.text("disabled") }
        if key == "video.defaultSpeed" { return value.formatted(.number.locale(L10n.locale)) + "×" }
        if key == "reading.size" || key == "appearance.textContrast" { return value.formatted(.number.locale(L10n.locale)) + "%" }
        if key == "content.readDelayMs" { let formatter = MeasurementFormatter(); formatter.locale = L10n.locale; formatter.unitOptions = .providedUnit; formatter.unitStyle = .short; return formatter.string(from: Measurement(value: value / 1000, unit: UnitDuration.seconds)) }
        if key.contains("Minutes") { let formatter = MeasurementFormatter(); formatter.locale = L10n.locale; formatter.unitOptions = .providedUnit; formatter.unitStyle = .short; return formatter.string(from: Measurement(value: value, unit: UnitDuration.minutes)) }
        return value.formatted(.number.locale(L10n.locale))
    }
    func colorPickerViewControllerDidSelectColor(_ viewController: UIColorPickerViewController) { if let key = colorKey { changed(key, viewController.selectedColor.hexString) } }
    private func sourceCommit() -> String {
        guard let url = Bundle.main.url(forResource: "BuildProvenance", withExtension: "json"), let data = try? Data(contentsOf: url), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return L10n.text("unavailable") }
        return value["sourceCommit"] as? String ?? L10n.text("unavailable")
    }
}

final class DiagnosticsViewController: ReaderScreen {
    private let text = UITextView()
    private let notice = NoticeView()
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("diagnostics"); text.isEditable = false; text.font = .preferredFont(forTextStyle: .footnote); text.adjustsFontForContentSizeCategory = true; text.accessibilityIdentifier = "diagnostics.report"
        let generate = readerButton(L10n.text("refresh"), symbol: "arrow.clockwise") { [weak self] in self?.load() }
        let share = readerButton(L10n.text("shareReport"), symbol: "square.and.arrow.up") { [weak self] in guard let self, !text.text.isEmpty else { return }; self.share([text.text ?? ""]) }
        let stack = UIStackView(arrangedSubviews: [generate, notice, text, share]); stack.axis = .vertical; stack.spacing = 12; view.addSubview(stack); stack.pin(to: view, safe: true); load()
    }
    private func load() { work = Task { [weak self] in guard let self else { return }; notice.show(L10n.text("loading"), busy: true); do { text.text = try await context.services.call(.diagnosticsReport); notice.show(nil) } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.load() }) } } }
}

final class MutedWordsViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate {
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private var words: [String] = []
    override func viewDidLoad() { super.viewDidLoad(); title = L10n.text("mutedWords"); table.dataSource = self; table.delegate = self; view.addSubview(table); table.pin(to: view, safe: true); navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(add)); load() }
    private func load() { work = Task { [weak self] in guard let self else { return }; do { words = try await context.services.call(.mutedWords); table.reloadData() } catch { showError(error) } } }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { words.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell { let cell = ReaderTableCell(style: .default, reuseIdentifier: nil); cell.textLabel?.text = words[indexPath.row]; return cell }
    func tableView(_ tableView: UITableView, commit editingStyle: UITableViewCell.EditingStyle, forRowAt indexPath: IndexPath) { guard editingStyle == .delete else { return }; update(words[indexPath.row], muted: false) }
    private func update(_ word: String, muted: Bool) { Task { do { try await context.services.command(.setMutedWord, ["word": .string(word), "muted": .bool(muted)]); load() } catch { showError(error) } }
    @objc private func add() {
        let alert = UIAlertController(title: L10n.text("addWord"), message: nil, preferredStyle: .alert); alert.addTextField { $0.autocapitalizationType = .none }
        alert.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel)); alert.addAction(UIAlertAction(title: L10n.text("add"), style: .default) { [weak self, weak alert] _ in guard let value = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= 100 else { return }; self?.update(value, muted: true) }); present(alert, animated: true)
    }
}
