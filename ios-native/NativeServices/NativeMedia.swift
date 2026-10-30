import AVKit
import UIKit

struct NativeMediaVariant: Decodable {
    let label: String
    let url: String
}
struct NativeMediaItem: Decodable {
    let url: String
    let kind: String
    let alt: String?
    let variants: [NativeMediaVariant]?
}
struct NativeMediaArgs: Decodable {
    let revision: UInt64?
    let items: [NativeMediaItem]
    let index: Int
    let position: Double?
    let playing: Bool?
    let speed: Double?
    let muted: Bool?
    let loop: Bool?
    let retryLabel: String?
    let locale: String?
}

/// Native presentation shares the same broker validation, image budget, and
/// playback owner as the inline reader. There is no second media transport.
@MainActor final class NativeMediaPresenter {
    private var order = PresentationOrder()
    private var controller: UIViewController?
    private var presentationID: UUID?
    private var completion: (([String: Any]) -> Void)?
    weak var service: NativeMediaService? {
        didSet { service?.ownershipInvalidated = { [weak self] in self?.dismiss(revision: nil) } }
    }
    var isPresented: Bool { controller != nil || presentationID != nil }
    func present(_ args: NativeMediaArgs, from root: UIViewController, done: @escaping ([String: Any]) -> Void) -> Bool {
        guard order.accept(args.revision) else { done(["index": args.index, "position": args.position ?? 0, "playing": false]); return true }
        guard !isPresented, let service = service, !args.items.isEmpty, args.items.indices.contains(args.index) else { return false }
        let id = UUID(); presentationID = id; completion = done
        let finish: ([String: Any]) -> Void = { [weak self] result in
            guard let self = self, self.presentationID == id else { return }
            let reply = self.completion
            self.presentationID = nil; self.completion = nil; self.controller = nil
            reply?(result)
        }
        if ["video", "gif"].contains(args.items[args.index].kind) {
            let video = NativeVideoController(source: args.items[args.index].url, service: service, args: args, owner: id)
            video.finished = finish; video.modalPresentationStyle = .fullScreen
            controller = video; root.present(video, animated: true)
        } else {
            let photos = NativePhotoPager(items: args.items, index: args.index, service: service,
                                          retryLabel: args.retryLabel ?? "Retry image", arabic: args.locale == "ar")
            photos.finished = { finish(["index": $0, "position": 0, "playing": false]) }
            let navigation = UINavigationController(rootViewController: photos)
            navigation.modalPresentationStyle = .fullScreen; navigation.overrideUserInterfaceStyle = .dark
            controller = navigation; root.present(navigation, animated: true)
        }
        return true
    }
    func dismiss(revision: UInt64?) {
        // nil means a hard account/scene invalidation and must always be accepted.
        guard revision == nil || order.accept(revision) else { return }
        let previous = controller; let reply = completion; let owner = presentationID
        let result = (previous as? NativeVideoController)?.dismissalResult() ?? ["index": 0, "position": 0, "playing": false]
        presentationID = nil; completion = nil; controller = nil
        if let owner = owner { service?.releasePlayer(owner: owner) }
        previous?.dismiss(animated: false)
        reply?(result)
    }
    func pause() { service?.pauseAll() }
}

@MainActor private final class NativeVideoController: AVPlayerViewController {
    private var source: String
    private let service: NativeMediaService
    private let args: NativeMediaArgs
    private let owner: UUID
    private let retry = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private let options = UIButton(type: .system)
    private var loading: Task<Void, Never>?
    private var endObserver: NSObjectProtocol?
    private var readyObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var wasPlaying = false
    private var selectedSpeed: Float
    private var looping: Bool
    var finished: (([String: Any]) -> Void)?
    init(source: String, service: NativeMediaService, args: NativeMediaArgs, owner: UUID) {
        self.source = source; self.service = service; self.args = args; self.owner = owner
        selectedSpeed = Float(args.speed ?? 1); looping = args.loop ?? true
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.accessibilityIdentifier = "native-video-loading"
        let overlay = contentOverlayView ?? view!
        retry.setTitle(args.locale == "ar" ? "إعادة المحاولة" : "Retry video", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .body)
        retry.backgroundColor = .secondarySystemBackground; retry.layer.cornerRadius = 12
        retry.translatesAutoresizingMaskIntoConstraints = false; retry.isHidden = true
        retry.addTarget(self, action: #selector(retryVideo), for: .touchUpInside)
        closeButton.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        closeButton.accessibilityLabel = args.locale == "ar" ? "إغلاق" : "Close"
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        options.setImage(UIImage(systemName: "ellipsis.circle.fill"), for: .normal)
        options.accessibilityLabel = args.locale == "ar" ? "خيارات الفيديو" : "Video options"
        options.translatesAutoresizingMaskIntoConstraints = false; options.showsMenuAsPrimaryAction = true
        overlay.addSubview(retry); overlay.addSubview(closeButton); overlay.addSubview(options)
        NSLayoutConstraint.activate([
            retry.centerXAnchor.constraint(equalTo: overlay.centerXAnchor), retry.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44), retry.widthAnchor.constraint(greaterThanOrEqualToConstant: 150),
            closeButton.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            closeButton.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor, constant: 8),
            closeButton.widthAnchor.constraint(equalToConstant: 44), closeButton.heightAnchor.constraint(equalToConstant: 44),
            options.leadingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            options.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor, constant: 8),
            options.widthAnchor.constraint(equalToConstant: 44), options.heightAnchor.constraint(equalToConstant: 44)
        ])
        service.setFailureHandler(owner: owner) { [weak self] _ in
            self?.retry.isHidden = false; self?.view.accessibilityIdentifier = "native-video-failed"
        }
        updateOptions()
        load(fresh: false)
    }
    private func updateOptions() {
        let arabic = args.locale == "ar"
        let speeds: [Float] = [0.5, 0.75, 1, 1.25, 1.5, 2]
        let speed = UIMenu(title: arabic ? "السرعة" : "Speed", children: speeds.map { rate in
            UIAction(title: "\(rate)×", state: rate == selectedSpeed ? .on : .off) { [weak self] _ in
                guard let self = self else { return }
                self.selectedSpeed = rate
                if (self.player?.rate ?? 0) > 0 { self.player?.rate = rate }
                self.updateOptions()
            }
        })
        let variants = args.items[args.index].variants ?? []
        let quality = UIMenu(title: arabic ? "الجودة" : "Quality", children: variants.map { variant in
            UIAction(title: variant.label, state: variant.url == source ? .on : .off) { [weak self] _ in
                self?.source = variant.url; self?.load(fresh: false); self?.updateOptions()
            }
        })
        let loop = UIAction(title: arabic ? "تكرار" : "Loop", state: looping ? .on : .off) { [weak self] _ in
            guard let self = self else { return }; self.looping.toggle(); self.updateOptions()
        }
        let children: [UIMenuElement] = variants.isEmpty ? [speed, loop] : [quality, speed, loop]
        options.menu = UIMenu(children: children)
    }
    private func load(fresh: Bool) {
        loading?.cancel(); retry.isHidden = true; view.accessibilityIdentifier = "native-video-loading"
        let position = player?.currentTime().seconds ?? args.position ?? 0
        let shouldPlay = player.map { $0.rate > 0 } ?? (args.playing ?? true)
        loading = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                let url = fresh ? try await self.service.recover(url: self.source, freshSource: true).absoluteString : self.source
                let player = try await self.service.makePlayer(url: url, owner: self.owner)
                try Task.checkCancellation()
                self.source = url
                self.player = player; player.isMuted = self.args.muted ?? false
                if position.isFinite && position > 0 { await player.seek(to: CMTime(seconds: position, preferredTimescale: 600)) }
                try Task.checkCancellation()
                if let observer = self.endObserver { NotificationCenter.default.removeObserver(observer) }
                self.endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] _ in
                    guard let self = self, self.looping, UIApplication.shared.applicationState == .active else { return }
                    self.player?.seek(to: .zero); self.player?.playImmediately(atRate: self.selectedSpeed)
                }
                self.itemObservation = player.observe(\.currentItem, options: [.initial, .new]) { [weak self] player, _ in
                    Task { @MainActor in
                        guard let self = self, self.player === player else { return }
                        self.readyObservation = player.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                            Task { @MainActor in
                                guard let self = self, self.player?.currentItem === item else { return }
                                self.view.accessibilityIdentifier = item.status == .readyToPlay ? "native-video-ready" : item.status == .failed ? "native-video-failed" : "native-video-loading"
                            }
                        }
                    }
                }
                self.updateOptions()
                if shouldPlay && UIApplication.shared.applicationState == .active { player.playImmediately(atRate: self.selectedSpeed) }
            } catch {
                guard !Task.isCancelled else { return }
                self.retry.isHidden = false; self.view.accessibilityIdentifier = "native-video-failed"
            }
        }
    }
    @objc private func retryVideo() { load(fresh: true) }
    @objc private func close() { dismiss(animated: true) }
    func dismissalResult() -> [String: Any] {
        let time = player?.currentTime().seconds ?? args.position ?? 0
        return ["index": args.index, "position": time.isFinite ? time : 0, "playing": wasPlaying || (player?.rate ?? 0) > 0]
    }
    override func viewWillDisappear(_ animated: Bool) { wasPlaying = (player?.rate ?? 0) > 0; super.viewWillDisappear(animated) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        loading?.cancel(); let time = player?.currentTime().seconds ?? 0
        service.releasePlayer(owner: owner)
        let reply = finished; finished = nil
        reply?(["index": args.index, "position": time.isFinite ? time : 0, "playing": wasPlaying])
    }
    deinit { loading?.cancel(); if let observer = endObserver { NotificationCenter.default.removeObserver(observer) } }
}

@MainActor private final class NativePhotoPager: UIPageViewController, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
    private let items: [NativeMediaItem]
    private let service: NativeMediaService
    private let retryLabel: String
    private let arabic: Bool
    private var index: Int
    var finished: ((Int) -> Void)?
    init(items: [NativeMediaItem], index: Int, service: NativeMediaService, retryLabel: String, arabic: Bool) {
        self.items = items; self.index = index; self.service = service; self.retryLabel = retryLabel; self.arabic = arabic
        super.init(transitionStyle: .scroll, navigationOrientation: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black; dataSource = self; delegate = self
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(close))
        navigationItem.rightBarButtonItem?.accessibilityLabel = arabic ? "إغلاق" : "Close"
        setViewControllers([page(index)], direction: .forward, animated: false); updateTitle()
    }
    private func page(_ index: Int) -> NativePhotoPage { NativePhotoPage(item: items[index], index: index, service: service, retryLabel: retryLabel) }
    private func updateTitle() {
        let number = NumberFormatter(); number.locale = Locale(identifier: arabic ? "ar" : "en")
        title = "\(number.string(from: NSNumber(value: index + 1)) ?? String(index + 1)) / \(number.string(from: NSNumber(value: items.count)) ?? String(items.count))"
    }
    @objc private func close() { dismiss(animated: true) }
    func pageViewController(_ pageViewController: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? {
        guard let page = viewController as? NativePhotoPage, page.index > 0 else { return nil }; return self.page(page.index - 1)
    }
    func pageViewController(_ pageViewController: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? {
        guard let page = viewController as? NativePhotoPage, page.index + 1 < items.count else { return nil }; return self.page(page.index + 1)
    }
    func pageViewController(_ pageViewController: UIPageViewController, didFinishAnimating finished: Bool, previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
        if completed, let page = viewControllers?.first as? NativePhotoPage { index = page.index; updateTitle() }
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard navigationController?.isBeingDismissed == true || navigationController?.presentingViewController == nil else { return }
        let reply = finished; finished = nil; reply?(index)
    }
}

@MainActor private final class NativePhotoPage: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    let index: Int
    private let item: NativeMediaItem
    private let service: NativeMediaService
    private let retryLabel: String
    private let scroll = UIScrollView()
    private let image = UIImageView()
    private let retry = UIButton(type: .system)
    private let activity = UIActivityIndicatorView(style: .large)
    private var loading: Task<Void, Never>?
    init(item: NativeMediaItem, index: Int, service: NativeMediaService, retryLabel: String) {
        self.item = item; self.index = index; self.service = service; self.retryLabel = retryLabel
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        scroll.delegate = self; scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 4
        scroll.translatesAutoresizingMaskIntoConstraints = false
        image.contentMode = .scaleAspectFit; image.isAccessibilityElement = true; image.accessibilityLabel = item.alt
        view.addSubview(scroll); scroll.addSubview(image)
        NSLayoutConstraint.activate([scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor), scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
        retry.setTitle(retryLabel, for: .normal); retry.translatesAutoresizingMaskIntoConstraints = false
        retry.addTarget(self, action: #selector(retryImage), for: .touchUpInside); retry.isHidden = true
        activity.translatesAutoresizingMaskIntoConstraints = false; activity.hidesWhenStopped = true
        view.addSubview(retry); view.addSubview(activity)
        NSLayoutConstraint.activate([retry.centerXAnchor.constraint(equalTo: view.centerXAnchor), retry.centerYAnchor.constraint(equalTo: view.centerYAnchor), retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44), activity.centerXAnchor.constraint(equalTo: view.centerXAnchor), activity.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:))); doubleTap.numberOfTapsRequired = 2; scroll.addGestureRecognizer(doubleTap)
        let dismiss = UIPanGestureRecognizer(target: self, action: #selector(dismissPhoto(_:)))
        dismiss.delegate = self; view.addGestureRecognizer(dismiss)
        load(fresh: false)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); if scroll.zoomScale == 1 { image.frame = scroll.bounds; scroll.contentSize = scroll.bounds.size } }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
    @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
        if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
        else { let point = recognizer.location(in: image); let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5); scroll.zoom(to: CGRect(x: point.x-size.width/2, y: point.y-size.height/2, width: size.width, height: size.height), animated: true) }
    }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: view)
        return scroll.zoomScale <= 1.01 && velocity.y > 0 && abs(velocity.y) > abs(velocity.x) * 1.25
    }
    @objc private func dismissPhoto(_ recognizer: UIPanGestureRecognizer) {
        guard recognizer.state == .ended, scroll.zoomScale <= 1.01 else { return }
        let distance = recognizer.translation(in: view).y
        if distance > 100 || distance > 40 && recognizer.velocity(in: view).y > 650 { dismiss(animated: true) }
    }
    @objc private func retryImage() { load(fresh: true) }
    private func load(fresh: Bool) {
        loading?.cancel(); retry.isHidden = true; activity.startAnimating(); image.accessibilityIdentifier = "native-photo-loading"
        loading = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                let source = fresh ? try await self.service.recover(url: self.item.url, freshSource: true).absoluteString : self.item.url
                let bytes = try await self.service.imageData(url: source, maxPixelDimension: 2048)
                try Task.checkCancellation()
                guard let image = UIImage(data: bytes) else { throw NativeMediaFailure.unavailable }
                self.image.image = image; self.image.accessibilityIdentifier = "native-photo-image"
            } catch { if !Task.isCancelled { self.retry.isHidden = false; self.image.accessibilityIdentifier = "native-photo-failed" } }
            self.activity.stopAnimating()
        }
    }
    override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); loading?.cancel() }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); if image.image == nil { load(fresh: false) } }
    deinit { loading?.cancel() }
}
