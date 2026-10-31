import UIKit
import AVFoundation

@MainActor protocol PostCellDelegate: AnyObject {
    func postCellOpenProfile(_ username: String)
    func postCellSetRead(_ post: Post, read: Bool)
    func postCellActions(_ post: Post, source: UIView)
    func postCellOpenArticle(_ post: Post)
    func postCellComments(_ post: Post)
    func postCellOpenURL(_ url: URL)
    func postCellPresentMedia(_ request: MediaPresentation)
}

final class PostCell: UICollectionViewCell, UITextViewDelegate {
    static let reuseID = "PostCell"
    private let stack = UIStackView()
    private let avatar = RemoteImageView()
    private let authorButton = UIButton(type: .system)
    private let metadata = readerLabel(style: .caption1, color: .secondaryLabel)
    private let attribution = readerLabel(style: .caption1, color: .secondaryLabel)
    private let textView = UITextView()
    private let expand = UIButton(type: .system)
    private let mediaStack = UIStackView()
    private let quote = UIStackView()
    private let footer = UIStackView()
    private let readLabel = readerLabel(style: .caption1, color: .secondaryLabel)
    private var current: Post?
    private var context: ReaderContext?
    private var expanded = false
    private var bookmark = false
    private var highlightText = ""
    private var videos: [InlinePlayerView] = []
    private var dwell: Task<Void, Never>?
    weak var delegate: PostCellDelegate?
    var markRead: (() -> Void)?
    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .secondarySystemGroupedBackground; contentView.layer.cornerRadius = 18
        stack.axis = .vertical; stack.spacing = 12; contentView.addSubview(stack); stack.pin(to: contentView, inset: 4)
        stack.addArrangedSubview(attribution)
        let header = UIStackView(); header.axis = .horizontal; header.spacing = 10; header.alignment = .top
        avatar.contentMode = .scaleAspectFill; avatar.clipsToBounds = true; avatar.layer.cornerRadius = 22; avatar.translatesAutoresizingMaskIntoConstraints = false; NSLayoutConstraint.activate([avatar.widthAnchor.constraint(equalToConstant: 44), avatar.heightAnchor.constraint(equalToConstant: 44)])
        avatar.isAccessibilityElement = false
        authorButton.contentHorizontalAlignment = .leading; authorButton.titleLabel?.numberOfLines = 0; authorButton.titleLabel?.adjustsFontForContentSizeCategory = true; authorButton.titleLabel?.font = .preferredFont(forTextStyle: .headline); authorButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        authorButton.addTarget(self, action: #selector(openAuthor), for: .touchUpInside)
        header.addArrangedSubview(avatar)
        let identity = UIStackView(arrangedSubviews: [authorButton, metadata]); identity.axis = .vertical; identity.spacing = 1; header.addArrangedSubview(identity)
        let more = readerButton("", symbol: "ellipsis") { [weak self] in guard let self, let post = current else { return }; delegate?.postCellActions(post, source: self) }; more.accessibilityLabel = L10n.text("more"); more.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; header.addArrangedSubview(more)
        stack.addArrangedSubview(header)
        textView.isEditable = false; textView.isScrollEnabled = false; textView.backgroundColor = .clear; textView.textContainerInset = .zero; textView.textContainer.lineFragmentPadding = 0; textView.delegate = self; textView.adjustsFontForContentSizeCategory = true; textView.setContentCompressionResistancePriority(.required, for: .vertical); textView.dataDetectorTypes = []
        stack.addArrangedSubview(textView)
        expand.contentHorizontalAlignment = .leading; expand.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; expand.addTarget(self, action: #selector(toggleExpand), for: .touchUpInside); stack.addArrangedSubview(expand)
        mediaStack.axis = .vertical; mediaStack.spacing = 8; stack.addArrangedSubview(mediaStack)
        quote.axis = .vertical; quote.spacing = 8; quote.isLayoutMarginsRelativeArrangement = true; quote.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12); quote.backgroundColor = .tertiarySystemGroupedBackground; quote.layer.cornerRadius = 12; stack.addArrangedSubview(quote)
        footer.axis = .horizontal; footer.spacing = 8; footer.alignment = .center; footer.addArrangedSubview(readLabel); stack.addArrangedSubview(footer)
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    override func prepareForReuse() { super.prepareForReuse(); releaseContent() }
    func releaseContent() {
        stop(); current = nil; avatar.cancel(); delegate = nil; markRead = nil; expanded = false
        textView.attributedText = nil; authorButton.setTitle(nil, for:.normal); metadata.text = nil; attribution.text = nil
        mediaStack.arrangedSubviews.forEach { $0.removeFromSuperview() }; quote.arrangedSubviews.forEach { $0.removeFromSuperview() }; videos = []
        footer.arrangedSubviews.filter { $0 !== readLabel }.forEach { $0.removeFromSuperview() }
    }
    var representedPostID: String? { current?.id }
    func configure(_ post: Post, read: Bool, bookmark: Bool, context: ReaderContext, delegate: PostCellDelegate) {
        stop(); let same = current?.id == post.id; current = post; self.context = context; self.delegate = delegate; self.bookmark = bookmark; if !same { expanded = false }; highlightText = ""
        accessibilityIdentifier = "post.\(post.id)"
        contentView.layer.cornerRadius = CGFloat(context.preferences.number("appearance.radius")) + 6
        contentView.backgroundColor = ReaderTheme.color(context.preferences.string("appearance.surface")) ?? .secondarySystemGroupedBackground
        attribution.isHidden = !post.isRepost; attribution.text = post.repostedBy.map { "\(L10n.text("reposted")) \($0.label)" }
        authorButton.setTitle("\(post.author.label)\(post.author.verified ? " ✓" : "")\n@\(post.author.username)", for: .normal)
        authorButton.accessibilityLabel = "\(post.author.label), @\(post.author.username)"
        metadata.text = ReaderDates.label(post.createdAt, absolute: context.preferences.string("appearance.timestampStyle") == "absolute")
        avatar.backgroundColor = .tertiarySystemFill; avatar.fallbackInitials(post.author.label); avatar.load(post.author.avatarUrl, services: context.services, maxPixel: 120)
        readLabel.text = L10n.text(read ? "read" : "unread")
        renderText()
        mediaStack.arrangedSubviews.forEach { $0.removeFromSuperview() }; videos.removeAll()
        for (index, item) in post.media.enumerated() {
            if item.kind == "image" {
                let tile = PhotoTile(item: item, services: context.services)
                tile.open = { [weak self, weak tile] in guard let tile else { return }; var items = post.media; items[index] = tile.displayItem; self?.delegate?.postCellPresentMedia(MediaPresentation(items: items, index: index)) }; mediaStack.addArrangedSubview(tile)
            } else {
                let playbackKey = "\(context.services.accountGeneration):\(post.id):\(index)"
                let player = InlinePlayerView(item: item, context: context, playbackKey: playbackKey)
                player.fullscreen = { [weak self, weak player] in
                    guard let player else { return }; let request = player.mediaPresentation()
                    player.stop(); self?.delegate?.postCellPresentMedia(request)
                }; mediaStack.addArrangedSubview(player); videos.append(player)
            }
        }
        quote.arrangedSubviews.forEach { $0.removeFromSuperview() }; quote.isHidden = post.quoted == nil
        if let quoted = post.quoted {
            quote.addArrangedSubview(readerButton("\(quoted.author.label) · @\(quoted.author.username)") { [weak self] in self?.delegate?.postCellOpenProfile(quoted.author.username) })
            quote.addArrangedSubview(readerLabel(quoted.text))
            for item in quoted.media {
                if item.kind == "image" { let tile = PhotoTile(item: item, services: context.services); tile.open = { [weak self, weak tile] in guard let tile else { return }; let index = quoted.media.firstIndex(of: item) ?? 0; var items = quoted.media; items[index] = tile.displayItem; self?.delegate?.postCellPresentMedia(MediaPresentation(items: items, index: index)) }; quote.addArrangedSubview(tile) }
                else { let key = "\(context.services.accountGeneration):\(quoted.id):\(quoted.media.firstIndex(of: item) ?? 0)"; let player = InlinePlayerView(item: item, context: context, playbackKey: key); player.fullscreen = { [weak self, weak player] in guard let player else { return }; let request = player.mediaPresentation(); player.stop(); self?.delegate?.postCellPresentMedia(request) }; quote.addArrangedSubview(player); videos.append(player) }
            }
        }
        footer.arrangedSubviews.filter { $0 !== readLabel }.forEach { $0.removeFromSuperview() }
        let actions = UIStackView(); actions.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal; actions.spacing = 8; actions.distribution = .fillEqually
        actions.addArrangedSubview(readerButton(L10n.text(read ? "markUnread" : "markRead"), symbol: read ? "circle" : "checkmark.circle") { [weak self] in self?.delegate?.postCellSetRead(post, read: !read) })
        actions.addArrangedSubview(readerButton(L10n.text("copyLink"), symbol: "link") { if let url = post.canonicalURL { ReaderClipboard.copyURL(url) } }); footer.addArrangedSubview(actions)
        if post.isArticle { footer.addArrangedSubview(readerButton(L10n.text("readArticle"), symbol: "doc.text") { [weak self] in self?.delegate?.postCellOpenArticle(post) }) }
        if bookmark { footer.addArrangedSubview(readerButton(L10n.text("comments"), symbol: "text.bubble") { [weak self] in self?.delegate?.postCellComments(post) }) }
        footer.axis = .vertical; footer.alignment = .fill
    }
    private func renderText() {
        guard let post = current, let context else { return }
        let collapse = context.preferences.bool("appearance.collapseLongPosts") && post.text.count > 420
        var text = ReaderPostText.display(post.text, collapsed: collapse && !expanded, limit: 420)
        if let canonical = post.canonicalURL { text = text.replacingOccurrences(of: canonical.absoluteString, with: "") }
        let paragraph = NSMutableParagraphStyle(); paragraph.baseWritingDirection = .natural; paragraph.lineSpacing = 3
        let attributed = NSMutableAttributedString(string: text, attributes: [.font: ReaderTheme.font(.body, preferences: context.preferences), .foregroundColor: UIColor.label, .paragraphStyle: paragraph])
        let full = NSRange(text.startIndex..., in: text)
        for (pattern, mention) in [("https?://[^\\s]+", false), ("(?<![A-Za-z0-9_])@[A-Za-z0-9_]{1,15}", true)] {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for match in regex.matches(in: text, range: full) {
                let value = (text as NSString).substring(with: match.range)
                if let url = URL(string: mention ? "ffn-profile://\(value.dropFirst())" : value) { attributed.addAttribute(.link, value: url, range: match.range) }
            }
        }
        textView.attributedText = attributed; textView.linkTextAttributes = [.foregroundColor: ReaderTheme.accent(context.preferences), .underlineStyle: NSUnderlineStyle.single.rawValue]
        if !highlightText.isEmpty, let value = textView.attributedText {
            let highlighted = NSMutableAttributedString(attributedString: value); let haystack = text as NSString; var search = NSRange(location: 0, length: haystack.length)
            while search.length > 0 { let match = haystack.range(of: highlightText, options: [.caseInsensitive, .diacriticInsensitive], range: search); if match.location == NSNotFound { break }; highlighted.addAttribute(.backgroundColor, value: UIColor.systemYellow.withAlphaComponent(0.28), range: match); let next = NSMaxRange(match); search = NSRange(location: next, length: haystack.length - next) }
            textView.attributedText = highlighted
        }
        expand.isHidden = !collapse; expand.setTitle(L10n.text(expanded ? "showLess" : "showMore"), for: .normal)
    }
    func highlight(_ value: String) { highlightText = value; renderText() }
    @objc private func openAuthor() { if let username = current?.author.username { delegate?.postCellOpenProfile(username) } }
    @objc private func toggleExpand() {
        expanded.toggle(); renderText()
        var parent = superview
        while parent != nil { if let collection = parent as? UICollectionView { collection.performBatchUpdates(nil); break }; parent = parent?.superview }
    }
    func textView(_ textView: UITextView, shouldInteractWith URL: URL, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
        if URL.scheme == "ffn-profile", let handle = URL.host { delegate?.postCellOpenProfile(handle) }
        else if ["https", "http"].contains(URL.scheme?.lowercased() ?? ""), URL.user == nil, URL.password == nil { delegate?.postCellOpenURL(URL) }
        return false
    }
    func visible(read: Bool) {
        guard let context else { return }
        if !read, context.preferences.number("content.readDelayMs") > 0 {
            dwell?.cancel(); dwell = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(context.preferences.number("content.readDelayMs") * 1_000_000))
                guard !Task.isCancelled, context.runtime?.foreground != false, let self, let window = window else { return }
                let rect = convert(bounds, to: window); let available = window.safeAreaLayoutGuide.layoutFrame
                let ratio = rect.intersection(available).height / max(1, min(rect.height, available.height))
                if ratio >= 0.6 { markRead?() }
            }
        }
        if context.allowsAutoplay { videos.first?.play(automatically: true) }
    }
    func stop() { dwell?.cancel(); dwell = nil; videos.forEach { $0.stop() } }
    func recoverFailedMedia() {
        guard context?.runtime?.foreground != false else { return }
        avatar.recoverIfNeeded()
        for case let tile as PhotoTile in mediaStack.arrangedSubviews + quote.arrangedSubviews { tile.recoverIfNeeded() }
        videos.forEach { $0.resumeIfInterrupted() }
    }
}

enum ReaderPostText {
    /// Swift Character boundaries preserve composed emoji. Move the boundary
    /// before any URL or mention that would otherwise be cut in half.
    static func display(_ text: String, collapsed: Bool, limit: Int) -> String {
        guard collapsed, text.count > limit else { return text }
        var boundary = text.index(text.startIndex, offsetBy: max(0, limit))
        let range = NSRange(text.startIndex..., in: text)
        if let regex = try? NSRegularExpression(pattern: "https?://[^\\s]+|(?<![A-Za-z0-9_])@[A-Za-z0-9_]{1,15}") {
            for match in regex.matches(in: text, range: range) {
                guard let matched = Range(match.range, in: text) else { continue }
                if matched.lowerBound < boundary && matched.upperBound > boundary { boundary = matched.lowerBound; break }
            }
        }
        return String(text[..<boundary]) + "…"
    }
}

final class PhotoTile: UIControl {
    private let image = RemoteImageView()
    private let state = readerLabel(L10n.text("loading"), style: .caption1, color: .secondaryLabel)
    private var failed = false
    private var currentHandle: String
    private var repair: Task<Void, Never>?
    private var repairID = UUID()
    let item: PostMedia
    let services: AppServices
    var open: (() -> Void)?
    var displayItem: PostMedia { var value = item; value.url = currentHandle; return value }
    init(item: PostMedia, services: AppServices) {
        self.item = item; self.services = services; currentHandle = item.url; super.init(frame: .zero)
        backgroundColor = .tertiarySystemFill; layer.cornerRadius = 12; clipsToBounds = true
        image.contentMode = .scaleAspectFit; image.translatesAutoresizingMaskIntoConstraints = false; addSubview(image)
        NSLayoutConstraint.activate([image.leadingAnchor.constraint(equalTo: leadingAnchor), image.trailingAnchor.constraint(equalTo: trailingAnchor), image.topAnchor.constraint(equalTo: topAnchor), image.bottomAnchor.constraint(equalTo: bottomAnchor)])
        let ratio = CGFloat(item.height ?? 300) / max(1, CGFloat(item.width ?? 500)); let height = heightAnchor.constraint(equalTo: widthAnchor, multiplier: min(1.3, max(0.35, ratio))); height.priority = .defaultHigh; height.isActive = true; heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        state.textAlignment = .center; state.translatesAutoresizingMaskIntoConstraints = false; addSubview(state); NSLayoutConstraint.activate([state.centerXAnchor.constraint(equalTo: centerXAnchor), state.centerYAnchor.constraint(equalTo: centerYAnchor), state.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 12), state.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12)])
        image.failure = { [weak self] in self?.showFailure() }
        image.loaded = { [weak self] in self?.state.isHidden = true; self?.accessibilityValue = nil }
        isAccessibilityElement = true; accessibilityTraits = .button; accessibilityLabel = item.alt?.isEmpty == false ? item.alt : L10n.text("openPhoto")
        addTarget(self, action: #selector(tapped), for: .touchUpInside); load()
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    private func load() { failed = false; state.isHidden = false; state.text = L10n.text("loading"); accessibilityValue = L10n.text("loading"); guard !currentHandle.isEmpty else { showFailure(); return }; image.load(currentHandle, services: services) }
    private func showFailure() { failed = true; state.text = "\(L10n.text("photoFailed")) · \(L10n.text("retry"))"; state.isHidden = false; accessibilityValue = L10n.text("photoFailed") + ", " + L10n.text("retry") }
    @objc private func tapped() {
        guard repair == nil else { return }
        if failed { retryManually() } else { open?() }
    }
    private func retryManually() {
        guard repair == nil, !currentHandle.isEmpty else { return }
        let id = UUID(); repairID = id
        let handle = currentHandle; let services = services; let generation = services.accountGeneration
        isEnabled = false; state.text = L10n.text("loading"); accessibilityValue = L10n.text("loading")
        repair = Task { [weak self] in
            defer { if let self, repairID == id { repair = nil; isEnabled = true } }
            do {
                let renewed = try await services.recoverMediaHandle(handle)
                try Task.checkCancellation()
                guard let self, repairID == id, currentHandle == handle, generation == services.accountGeneration else { return }
                currentHandle = renewed; load()
            } catch {
                guard let self, repairID == id else { return }
                showFailure()
            }
        }
    }
    func recoverIfNeeded() { if repair == nil, image.needsRecovery { load() } }
    deinit { repair?.cancel() }
}

final class InlinePlayerView: UIView {
    private let item: PostMedia
    private let context: ReaderContext
    private let playbackKey: String
    private let owner = UUID()
    private let poster = RemoteImageView()
    private let playerLayer = AVPlayerLayer()
    private var player: AVPlayer?
    private var task: Task<Void, Never>?
    private var taskID = UUID()
    private let notice = readerLabel(style: .caption1, color: .white)
    private var button: UIButton!
    private var selectedURL: String
    private var savedPosition = 0.0
    private var selectedSpeed: Float
    private var selectedMuted: Bool?
    private var selectedLoop: Bool
    private var manuallyPaused = false
    private var endObserver: NSObjectProtocol?
    private var itemObserver: NSKeyValueObservation?
    private var statusObserver: NSKeyValueObservation?
    private var failed = false
    private var wantsPlayback = false
    var fullscreen: (() -> Void)?
    var position: Double { let v = player?.currentTime().seconds ?? savedPosition; return v.isFinite ? v : savedPosition }
    var isPlaying: Bool { (player?.rate ?? 0) > 0 }
    init(item: PostMedia, context: ReaderContext, playbackKey: String) {
        self.item = item; self.context = context; self.playbackKey = playbackKey; selectedURL = context.playbackState(playbackKey)?.selectedHandle ?? Self.initialURL(item, context: context); selectedSpeed = Float(context.playbackState(playbackKey)?.speed ?? context.preferences.number("video.defaultSpeed")); selectedMuted = context.playbackState(playbackKey)?.muted; selectedLoop = context.playbackState(playbackKey)?.loopPlayback ?? context.preferences.bool("video.loop"); savedPosition = context.position(playbackKey); manuallyPaused = context.isPaused(playbackKey); super.init(frame: .zero)
        backgroundColor = .black; layer.cornerRadius = 12; clipsToBounds = true
        heightAnchor.constraint(equalTo: widthAnchor, multiplier: min(1.3, max(0.5, CGFloat(item.height ?? 9) / CGFloat(max(1, item.width ?? 16))))).isActive = true
        poster.contentMode = .scaleAspectFit; addSubview(poster); poster.pin(to: self); poster.load(item.previewUrl, services: context.services)
        playerLayer.videoGravity = .resizeAspect; layer.addSublayer(playerLayer)
        button = readerButton(L10n.text("playVideo"), symbol: "play.fill") { [weak self] in self?.togglePlayback() }; button.tintColor = .white
        let full = readerButton("", symbol: "arrow.up.left.and.arrow.down.right") { [weak self] in self?.fullscreen?() }; full.tintColor = .white; full.accessibilityLabel = L10n.text("fullscreen")
        let settings = UIButton(type: .system); settings.setImage(UIImage(systemName: "slider.horizontal.3"), for: .normal); settings.tintColor = .white; settings.accessibilityLabel = L10n.text("mediaOptions"); settings.showsMenuAsPrimaryAction = true
        let speeds = [0.5, 0.75, 1, 1.25, 1.5, 2.0].map { speed in UIAction(title: "\(speed)×") { [weak self] _ in guard let self else { return }; selectedSpeed = Float(speed); if isPlaying { player?.rate = selectedSpeed } } }
        let qualities = item.variants.map { variant in UIAction(title: variant.label) { [weak self] _ in guard let self else { return }; let playing = isPlaying; selectedURL = variant.url; stop(); play(startPlaying: playing) } }
        settings.menu = UIMenu(children: [UIMenu(title: L10n.text("speed"), children: speeds), UIMenu(title: L10n.text("quality"), children: qualities)])
        let controls = UIStackView(arrangedSubviews: [button, settings, full]); controls.spacing = 12; controls.backgroundColor = UIColor.black.withAlphaComponent(0.55); controls.translatesAutoresizingMaskIntoConstraints = false; addSubview(controls)
        NSLayoutConstraint.activate([controls.leadingAnchor.constraint(equalTo: leadingAnchor), controls.trailingAnchor.constraint(equalTo: trailingAnchor), controls.bottomAnchor.constraint(equalTo: bottomAnchor), controls.heightAnchor.constraint(greaterThanOrEqualToConstant: 44), settings.widthAnchor.constraint(greaterThanOrEqualToConstant: 44), full.widthAnchor.constraint(greaterThanOrEqualToConstant: 44)])
        notice.translatesAutoresizingMaskIntoConstraints = false; notice.numberOfLines = 0; addSubview(notice); NSLayoutConstraint.activate([notice.topAnchor.constraint(equalTo: topAnchor, constant: 8), notice.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), notice.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12)])
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    private static func initialURL(_ item: PostMedia, context: ReaderContext) -> String {
        guard !item.variants.isEmpty else { return item.url }
        let preferred = context.preferences.string("video.quality")
        if preferred == "best" { return item.variants.first?.url ?? item.url }
        let saving = context.runtime?.lowPower == true || ["serious", "critical"].contains(context.runtime?.thermal ?? "") || context.preferences.string("performance.mode") == "battery"
        let target = Int(preferred) ?? (saving ? 360 : context.runtime?.expensive == true || context.runtime?.wifi == false ? 480 : 720)
        func resolution(_ variant: MediaVariant) -> Int? { if let width = variant.width, let height = variant.height { return min(width, height) }; return Int(variant.label.filter(\.isNumber)) }
        let candidates = item.variants.compactMap { variant in resolution(variant).map { (variant, $0) } }
        if let selected = candidates.filter({ $0.1 <= target }).max(by: { $0.1 < $1.1 }) { return selected.0.url }
        return candidates.min(by: { $0.1 < $1.1 })?.0.url ?? item.variants.last?.url ?? item.url
    }
    override func layoutSubviews() { super.layoutSubviews(); playerLayer.frame = bounds }
    func mediaPresentation() -> MediaPresentation {
        if player == nil { restorePlaybackState() }
        var selected = item; selected.url = selectedURL
        let rate = player?.rate ?? 0
        return MediaPresentation(items: [selected], index: 0, position: position,
                                 playing: isPlaying || player?.timeControlStatus == .waitingToPlayAtSpecifiedRate,
                                 speed: Double(rate > 0 ? rate : selectedSpeed),
                                 muted: player?.isMuted ?? selectedMuted ?? false, loopPlayback: selectedLoop, playbackKey: playbackKey)
    }
    private func restorePlaybackState() {
        guard let state = context.playbackState(playbackKey) else { return }
        savedPosition = state.position; manuallyPaused = state.paused
        if let speed = state.speed { selectedSpeed = Float(speed) }
        if let muted = state.muted { selectedMuted = muted }
        if let loop = state.loopPlayback { selectedLoop = loop }
        if let handle = state.selectedHandle { selectedURL = handle }
    }
    private func rememberPlaybackState() {
        if let player { selectedMuted = player.isMuted; if player.rate > 0 { selectedSpeed = player.rate } }
        context.rememberMedia(playbackKey, position: position, speed: Double(selectedSpeed), muted: selectedMuted, loopPlayback: selectedLoop, selectedHandle: selectedURL)
    }
    private func togglePlayback() {
        if !failed, player?.currentItem?.status != .failed, isPlaying {
            manuallyPaused = true; wantsPlayback = false; context.rememberMedia(playbackKey, paused: true); player?.pause(); button.setTitle(L10n.text("playVideo"), for: .normal)
        } else { manuallyPaused = false; context.rememberMedia(playbackKey, paused: false); play() }
    }
    func play(automatically: Bool = false, startPlaying: Bool = true) {
        if player == nil { restorePlaybackState() }
        guard !automatically || (!manuallyPaused && (item.kind != "gif" || context.preferences.bool("video.gifAutoplay"))) else { return }
        let needsRepair = failed || player?.currentItem?.status == .failed
        guard !automatically || !needsRepair else { return }
        if !needsRepair, let player, player.currentItem != nil { if startPlaying { player.playImmediately(atRate: selectedSpeed) }; return }
        guard task == nil else { return }
        wantsPlayback = startPlaying
        if needsRepair { stop() }
        notice.text = L10n.text("loading"); button.isEnabled = false
        let id = UUID(); taskID = id
        task = Task { [weak self] in
            guard let self else { return }
            defer { if taskID == id { task = nil; button.isEnabled = true } }
            do {
                if needsRepair { selectedURL = try await context.services.recoverMediaHandle(selectedURL); try Task.checkCancellation() }
                let next = try await context.services.makePlayer(url: selectedURL, owner: owner); try Task.checkCancellation(); player = next; playerLayer.player = next; notice.text = nil; next.isMuted = selectedMuted ?? automatically
                failed = false; observe(next)
                if savedPosition > 0 { await next.seek(to: CMTime(seconds: savedPosition, preferredTimescale: 600)) }
                try Task.checkCancellation()
                if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
                endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: next.currentItem, queue: .main) { [weak self] _ in
                    Task { @MainActor in guard let self, !manuallyPaused, selectedLoop else { return }; player?.seek(to: .zero); player?.playImmediately(atRate: selectedSpeed) }
                }
                if startPlaying { next.playImmediately(atRate: selectedSpeed) }; button.setTitle(L10n.text(startPlaying ? "pause" : "playVideo"), for: .normal)
            }
            catch { if !(error is CancellationError), taskID == id { failed = true; notice.text = error.localizedDescription; button.setTitle(L10n.text("retry"), for: .normal); button.accessibilityLabel = L10n.text("retry") } }
        }
    }
    func resumeIfInterrupted() {
        guard !failed, task == nil, player == nil || player?.currentItem == nil,
              !manuallyPaused, !context.isPaused(playbackKey), context.runtime?.foreground != false,
              wantsPlayback || context.allowsAutoplay else { return }
        play(automatically: true)
    }
    private func observe(_ observed: AVPlayer) {
        itemObserver?.invalidate(); statusObserver?.invalidate()
        itemObserver = observed.observe(\.currentItem, options: [.initial, .new]) { [weak self, weak observed] _, _ in
            Task { @MainActor in guard let self, let observed, player === observed else { return }; observeStatus(observed.currentItem, player: observed) }
        }
    }
    private func observeStatus(_ item: AVPlayerItem?, player observed: AVPlayer) {
        statusObserver?.invalidate(); statusObserver = nil
        guard let item else { return }
        statusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak observed] item, _ in
            Task { @MainActor in
                guard let self, let observed, player === observed, observed.currentItem === item else { return }
                switch item.status {
                case .failed: failed = true; notice.text = L10n.text("videoFailed"); button.setTitle(L10n.text("retry"), for: .normal); button.accessibilityLabel = L10n.text("retry"); button.isEnabled = true
                case .readyToPlay: failed = false; notice.text = nil; button.setTitle(L10n.text(isPlaying ? "pause" : "playVideo"), for: .normal); button.accessibilityLabel = L10n.text(isPlaying ? "pause" : "playVideo")
                default: notice.text = L10n.text("loading")
                }
            }
        }
    }
    func stop() { if player?.currentItem?.status == .failed { failed = true }; if player != nil || task != nil { rememberPlaybackState(); savedPosition = position }; taskID = UUID(); task?.cancel(); task = nil; itemObserver?.invalidate(); itemObserver = nil; statusObserver?.invalidate(); statusObserver = nil; player?.pause(); playerLayer.player = nil; player = nil; if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }; button.isEnabled = true; context.services.releasePlayer(owner: owner) }
    deinit { task?.cancel(); itemObserver?.invalidate(); statusObserver?.invalidate(); if let endObserver { NotificationCenter.default.removeObserver(endObserver) } }
}
