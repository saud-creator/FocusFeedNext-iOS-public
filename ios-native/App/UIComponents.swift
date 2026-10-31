import UIKit

extension UIView {
    func pin(to other: UIView, inset: CGFloat = 0, safe: Bool = false) {
        translatesAutoresizingMaskIntoConstraints = false
        let guide = safe ? other.safeAreaLayoutGuide : other.layoutMarginsGuide
        NSLayoutConstraint.activate([leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: inset), trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -inset), topAnchor.constraint(equalTo: guide.topAnchor, constant: inset), bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -inset)])
    }
}
@MainActor func readerLabel(_ text: String = "", style: UIFont.TextStyle = .body, color: UIColor = .label) -> UILabel {
    let label = UILabel(); label.text = text; label.font = .preferredFont(forTextStyle: style); label.adjustsFontForContentSizeCategory = true; label.numberOfLines = 0; label.textColor = color
    return label
}
@MainActor func readerButton(_ title: String, symbol: String? = nil, action: @escaping () -> Void) -> UIButton {
    var config = UIButton.Configuration.plain(); config.title = title; config.image = symbol.flatMap(UIImage.init(systemName:)); config.imagePadding = 7; config.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
    let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() }); button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    button.titleLabel?.numberOfLines = 0; button.titleLabel?.adjustsFontForContentSizeCategory = true
    return button
}
@MainActor class ReaderScreen: UIViewController {
    let context: ReaderContext
    var work: Task<Void, Never>?
    init(context: ReaderContext) { self.context = context; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use dependency injection") }
    override func viewDidLoad() { super.viewDidLoad(); ReaderTheme.apply(context.preferences, to: self) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController?.isBeingDismissed == true { work?.cancel() }
    }
    func showError(_ error: Error) {
        if error is CancellationError { return }
        let alert = UIAlertController(title: L10n.text("error"), message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L10n.text("close"), style: .cancel)); present(alert, animated: true)
    }
    func confirm(title: String, message: String? = nil, action: String, destructive: Bool = false, perform: @escaping () -> Void) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L10n.text("cancel"), style: .cancel))
        alert.addAction(UIAlertAction(title: action, style: destructive ? .destructive : .default) { _ in perform() }); present(alert, animated: true)
    }
    func share(_ items: [Any], source: UIView? = nil) {
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = source ?? view
        sheet.popoverPresentationController?.sourceRect = source?.bounds ?? CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }
    func openProfile(_ username: String) { navigationController?.pushViewController(ProfileViewController(context: context, username: username), animated: true) }
    deinit { work?.cancel() }
}

final class NoticeView: UIStackView {
    let label = readerLabel(style: .subheadline, color: .secondaryLabel)
    let spinner = UIActivityIndicatorView(style: .medium)
    var retry: (() -> Void)?
    private lazy var retryButton = readerButton(L10n.text("retry")) { [weak self] in self?.retry?() }
    override init(frame: CGRect) {
        super.init(frame: frame); axis = .vertical; spacing = 8; alignment = .center
        isLayoutMarginsRelativeArrangement = true; directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
        addArrangedSubview(spinner); addArrangedSubview(label); addArrangedSubview(retryButton)
        label.textAlignment = .center; accessibilityIdentifier = "reader.notice"; isHidden = true
    }
    required init(coder: NSCoder) { fatalError("Use init") }
    func show(_ text: String?, busy: Bool = false, retry: (() -> Void)? = nil, actionTitle: String? = nil) {
        let previousText = label.text
        let wasBusy = !spinner.isHidden
        isHidden = text?.isEmpty != false; label.text = text; self.retry = retry; retryButton.isHidden = retry == nil
        retryButton.setTitle(actionTitle ?? L10n.text("retry"), for: .normal)
        spinner.isHidden = !busy; busy ? spinner.startAnimating() : spinner.stopAnimating()
        if let text, !text.isEmpty, !busy, previousText != text || wasBusy { UIAccessibility.post(notification: .announcement, argument: text) }
    }
}

final class ReaderTableCell: UITableViewCell {
    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) { super.init(style: .subtitle, reuseIdentifier: reuseIdentifier); textLabel?.numberOfLines = 0; textLabel?.adjustsFontForContentSizeCategory = true; detailTextLabel?.numberOfLines = 0; detailTextLabel?.adjustsFontForContentSizeCategory = true }
    required init?(coder: NSCoder) { fatalError("Use init") }
}

/// Per-view image ownership prevents a recycled cell accepting another post's late image.
final class RemoteImageView: UIImageView {
    private var task: Task<Void, Never>?
    private var attempt = UUID()
    private var represented = ""
    private weak var sourceServices: AppServices?
    private var dimension = 1200
    private var failed = false
    private var loading = false
    var failure: (() -> Void)?
    var loaded: (() -> Void)?
    private var fallback: UILabel?
    func fallbackInitials(_ name: String) {
        if fallback == nil { let label = readerLabel(style: .headline, color: .secondaryLabel); label.textAlignment = .center; label.isAccessibilityElement = false; label.translatesAutoresizingMaskIntoConstraints = false; addSubview(label); NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: leadingAnchor), label.trailingAnchor.constraint(equalTo: trailingAnchor), label.centerYAnchor.constraint(equalTo: centerYAnchor)]); fallback = label }
        fallback?.text = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2)).localizedUppercase; fallback?.isHidden = image != nil
    }
    func load(_ handle: String?, services: AppServices, maxPixel: Int = 1200) {
        task?.cancel(); image = nil; fallback?.isHidden = false; represented = handle ?? ""; sourceServices = services; dimension = maxPixel; failed = false; loading = false
        let id = UUID(); attempt = id
        guard let handle, !handle.isEmpty else { return }
        loading = true
        task = Task { [weak self] in
            defer { if self?.attempt == id { self?.loading = false; self?.task = nil } }
            do {
                let data = try await services.imageData(url: handle, maxPixelDimension: maxPixel)
                try Task.checkCancellation()
                guard self?.represented == handle, self?.attempt == id else { return }
                guard let decoded = UIImage(data: data) else { throw AppServiceError(code: "image_decode_failed", message: L10n.text("photoFailed")) }
                self?.image = decoded; self?.fallback?.isHidden = true; self?.loaded?()
            } catch { if !(error is CancellationError), self?.represented == handle, self?.attempt == id { self?.failed = true; self?.failure?() } }
        }
    }
    var needsRecovery: Bool { !represented.isEmpty && !loading && image == nil }
    func recoverIfNeeded() {
        guard (failed || needsRecovery), !loading, let services = sourceServices else { return }
        load(represented, services: services, maxPixel: dimension)
    }
    func cancel() { attempt = UUID(); task?.cancel(); task = nil; loading = false; failed = false; represented = ""; image = nil; fallback?.isHidden = false }
    deinit { task?.cancel() }
}
