import UIKit

/// Root bootstrap used by the standalone native application's scene delegate.
@MainActor final class NativeAppRootController: UIViewController {
    let context: ReaderContext
    private var active: UIViewController?
    private var identity = "boot"
    private var startup: Task<Void, Never>?
    init(services: AppServices) { context = ReaderContext(services: services); super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use injected services") }
    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: .readerContextChanged, object: context)
        boot()
    }
    private func boot() {
        let loading = UIViewController(); loading.view.backgroundColor = .systemBackground
        let notice = NoticeView(); loading.view.addSubview(notice); notice.pin(to: loading.view, safe: true); notice.show(L10n.text("checking"), busy: true); replace(loading)
        startup?.cancel(); startup = Task { [weak self] in
            guard let self else { return }
            do { try await context.start(); changed() }
            catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.boot() }) }
        }
    }
    @objc private func changed() {
        ReaderTheme.apply(context.preferences, to: self)
        let next = context.session?.hasCredentials == true ? context.session?.account?.id ?? "connected" : "welcome"
        if next != identity {
            identity = next
            if next == "welcome" { replace(UINavigationController(rootViewController: WelcomeViewController(context: context))) }
            else { replace(NativeTabs(context: context)) }
        } else if let tabs = active as? NativeTabs { tabs.updateConfiguration() }
    }
    private func replace(_ controller: UIViewController) {
        active?.willMove(toParent: nil); active?.view.removeFromSuperview(); active?.removeFromParent()
        addChild(controller); view.addSubview(controller.view); controller.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), controller.view.topAnchor.constraint(equalTo: view.topAnchor), controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        controller.didMove(toParent: self); active = controller
    }
    deinit { startup?.cancel(); NotificationCenter.default.removeObserver(self) }
}

@MainActor final class NativeTabs: UITabBarController, UITabBarControllerDelegate {
    let context: ReaderContext
    private var signature = ""
    init(context: ReaderContext) { self.context = context; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() { super.viewDidLoad(); delegate = self; updateConfiguration() }
    func updateConfiguration() {
        ReaderTheme.apply(context.preferences, to: self)
        let next = context.preferences.tabs.map(\.rawValue).joined(separator: ",") + L10n.locale.identifier
        guard next != signature else { return }; signature = next
        let oldRoute = (selectedViewController as? UINavigationController)?.viewControllers.first?.restorationIdentifier
        let controllers = context.preferences.tabs.map { route -> UIViewController in
            let root = screen(for: route, context: context); root.restorationIdentifier = route.rawValue
            let nav = UINavigationController(rootViewController: root); nav.tabBarItem = UITabBarItem(title: route.title, image: UIImage(systemName: route.symbol), selectedImage: nil); nav.tabBarItem.accessibilityIdentifier = "tab.\(route.rawValue)"
            return nav
        }
        let more = UINavigationController(rootViewController: MoreViewController(context: context)); more.tabBarItem = UITabBarItem(title: L10n.text("more"), image: UIImage(systemName: "ellipsis.circle"), selectedImage: nil); more.tabBarItem.accessibilityIdentifier = "tab.more"
        setViewControllers(controllers + [more], animated: false)
        if let oldRoute, let index = context.preferences.tabs.firstIndex(where: { $0.rawValue == oldRoute }) { selectedIndex = index }
    }
    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        if viewController === selectedViewController, let nav = viewController as? UINavigationController {
            if nav.viewControllers.count > 1 { nav.popToRootViewController(animated: true) }
            else { (nav.viewControllers.first as? FeedViewController)?.returnToTop() }
        }
        return true
    }
}

@MainActor func screen(for route: ReaderRoute, context: ReaderContext) -> UIViewController {
    switch route {
    case .following, .originals, .focus, .bookmarks: return FeedViewController(context: context, route: route)
    case .accounts: return PeopleViewController(context: context)
    case .groups: return ListsViewController(context: context)
    case .search: return SearchViewController(context: context)
    case .settings: return SettingsViewController(context: context)
    }
}

final class MoreViewController: ReaderScreen, UITableViewDataSource, UITableViewDelegate {
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private var routes: [ReaderRoute] { ReaderRoute.allCases.filter { !context.preferences.tabs.contains($0) } }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("more"); table.dataSource = self; table.delegate = self; view.addSubview(table); table.pin(to: view, safe: true)
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { routes.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let route = routes[indexPath.row]; let cell = ReaderTableCell(style: .subtitle, reuseIdentifier: nil); cell.textLabel?.text = route.title; cell.imageView?.image = UIImage(systemName: route.symbol); cell.accessoryType = .disclosureIndicator; return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) { tableView.deselectRow(at: indexPath, animated: true); navigationController?.pushViewController(screen(for: routes[indexPath.row], context: context), animated: true) }
}

final class WelcomeViewController: ReaderScreen {
    private let notice = NoticeView()
    private var signIn: UIButton!
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("nativeReader")
        let scroll = UIScrollView(); view.addSubview(scroll); scroll.pin(to: view, safe: true)
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false; scroll.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 42), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24), stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)])
        stack.addArrangedSubview(readerLabel(L10n.text("welcome"), style: .largeTitle)); stack.addArrangedSubview(readerLabel(L10n.text("welcomeBody"), style: .title3))
        signIn = readerButton(L10n.text("signIn"), symbol: "person.crop.circle.badge.checkmark") { [weak self] in self?.connect() }; signIn.accessibilityIdentifier = "welcome.signIn"; stack.addArrangedSubview(signIn)
        stack.addArrangedSubview(notice)
        stack.addArrangedSubview(readerButton(L10n.text("settings"), symbol: "gearshape") { [weak self] in guard let self else { return }; navigationController?.pushViewController(SettingsViewController(context: context), animated: true) })
        stack.addArrangedSubview(readerLabel(L10n.text("privacyWelcome"), style: .footnote, color: .secondaryLabel))
    }
    private func connect() {
        guard work == nil else { return }; signIn.isEnabled = false; notice.show(L10n.text("checking"), busy: true)
        work = Task { [weak self] in
            guard let self else { return }
            defer { work = nil; signIn.isEnabled = true }
            do { let snapshot = try await context.services.signIn(presenting: self); await context.accept(snapshot); notice.show(nil) }
            catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.connect() }) }
        }
    }
}
