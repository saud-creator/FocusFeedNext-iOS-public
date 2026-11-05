import UIKit

@main final class NativeAppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "NativeReader", sessionRole: session.role)
        configuration.delegateClass = NativeSceneDelegate.self
        return configuration
    }
}

final class NativeSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var services: NativeApplicationServices?
    private var startup: Task<Void, Never>?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene); self.window = window
        let loading = UIViewController(); loading.view.backgroundColor = .systemBackground
        let activity = UIActivityIndicatorView(style: .large); activity.translatesAutoresizingMaskIntoConstraints = false
        loading.view.addSubview(activity); NSLayoutConstraint.activate([activity.centerXAnchor.constraint(equalTo: loading.view.centerXAnchor), activity.centerYAnchor.constraint(equalTo: loading.view.centerYAnchor)])
        activity.startAnimating(); window.rootViewController = loading; window.makeKeyAndVisible()
        start()
    }
    @MainActor private func start() {
        startup = Task { [weak self] in
            guard let self, let window else { return }
            do {
                let service = try await NativeApplicationServices.open(window: window)
                self.services = service
                window.rootViewController = NativeAppRootController(services: service)
            } catch {
                let controller = UIViewController(); controller.view.backgroundColor = .systemBackground
                let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
                let message = UILabel(); message.numberOfLines = 0; message.font = .preferredFont(forTextStyle: .body); message.adjustsFontForContentSizeCategory = true
                message.text = L10n.text("storagePreserved")
                let retry = UIButton(type: .system); retry.setTitle(L10n.text("retry"), for: .normal); retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
                retry.addAction(UIAction { [weak self] _ in self?.start() }, for: .touchUpInside)
                stack.addArrangedSubview(message); stack.addArrangedSubview(retry); controller.view.addSubview(stack)
                NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor)])
                window.rootViewController = controller
            }
        }
    }
    func sceneDidDisconnect(_ scene: UIScene) { startup?.cancel(); services?.pause() }
    func sceneDidEnterBackground(_ scene: UIScene) { services?.pause() }
}
