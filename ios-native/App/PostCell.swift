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
    private let actions = UIStackView()
    private lazy var readAction = makeAction(#selector(toggleRead))
    private lazy var copyAction = makeAction(#selector(copyLink))
    private lazy var moreAction = makeAction(#selector(openActions))
    private var articleAction: UIButton?
    private var commentsAction: UIButton?
    private let readLabel = readerLabel(style: .caption1, color: .secondaryLabel)
    private var current: Post?
    private var context: ReaderContext?
    private var expanded = false
    private var isRead = false
    private var highlightText = ""
    private var videos: [InlinePlayerView] = []
    private var dwell: Task<Void, Never>?
    private var shadowBounds = CGRect.null
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
        stack.addArrangedSubview(header)
        textView.isEditable = false; textView.isScrollEnabled = false; textView.backgroundColor = .clear; textView.textContainerInset = .zero; textView.textContainer.lineFragmentPadding = 0; textView.delegate = self; textView.adjustsFontForContentSizeCategory = true; textView.setContentCompressionResistancePriority(.required, for: .vertical); textView.dataDetectorTypes = []
        stack.addArrangedSubview(textView)
        expand.contentHorizontalAlignment = .leading; expand.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; expand.addTarget(self, action: #selector(toggleExpand), for: .touchUpInside); stack.addArrangedSubview(expand)
        mediaStack.axis = .vertical; mediaStack.spacing = 8; stack.addArrangedSubview(mediaStack)
        quote.axis = .vertical; quote.spacing = 8; quote.isLayoutMarginsRelativeArrangement = true; quote.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12); quote.backgroundColor = .tertiarySystemGroupedBackground; quote.layer.cornerRadius = 12; stack.addArrangedSubview(quote)
        actions.axis = .horizontal
        actions.spacing = 8
        actions.distribution = .fillEqually
        [readAction, copyAction, moreAction].forEach { actions.addArrangedSubview($0) }
        footer.axis = .vertical
        footer.spacing = 8
        footer.addArrangedSubview(readLabel)
        footer.addArrangedSubview(actions)
        stack.addArrangedSubview(footer)
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    override func prepareForReuse() { super.prepareForReuse(); releaseContent() }
    func releaseContent() {
        stop(); current = nil; avatar.cancel(); delegate = nil; markRead = nil; expanded = false
        textView.attributedText = nil; authorButton.setTitle(nil, for:.normal); metadata.text = nil; attribution.text = nil
        mediaStack.arrangedSubviews.forEach { $0.removeFromSuperview() }; quote.arrangedSubviews.forEach { $0.removeFromSuperview() }; videos = []
        articleAction?.isHidden = true
        commentsAction?.isHidden = true
    }
    var representedPostID: String? { current?.id }
    func configure(_ post: Post, read: Bool, bookmark: Bool, highlight: String = "", context: ReaderContext, delegate: PostCellDelegate) {
        stop(); let same = current?.id == post.id; current = post; self.context = context; self.delegate = delegate; isRead = read; if !same { expanded = false }; highlightText = highlight
        accessibilityIdentifier = "post.\(post.id)"
        updateAppearance(context.preferences)
        attribution.isHidden = !post.isRepost; attribution.text = post.repostedBy.map { "\(L10n.text("reposted")) \($0.label)" }
        authorButton.setTitle("\(post.author.label)\(post.author.verified ? " ✓" : "")\n@\(post.author.username)", for: .normal)
        authorButton.accessibilityLabel = "\(post.author.label), @\(post.author.username)"
        metadata.text = ReaderDates.label(post.createdAt, absolute: context.preferences.string("appearance.timestampStyle") == "absolute")
        avatar.backgroundColor = .tertiarySystemFill; avatar.fallbackInitials(post.author.label); avatar.load(post.author.avatarUrl, services: context.services, maxPixel: 120)
        readLabel.text = L10n.text(read ? "read" : "unread")
        mediaStack.arrangedSubviews.forEach { $0.removeFromSuperview() }; videos.removeAll()
        mediaStack.isHidden = post.media.isEmpty
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
        actions.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
        readAction.setTitle(L10n.text(read ? "markUnread" : "markRead"), for: .normal)
        copyAction.setTitle(L10n.text("copyLink"), for: .normal)
        copyAction.isEnabled = post.canonicalURL != nil
        moreAction.setTitle(L10n.text("more"), for: .normal)
        if post.isArticle, articleAction == nil {
            let button = makeAction(#selector(openArticle))
            footer.insertArrangedSubview(button, at: 2)
            articleAction = button
        }
        articleAction?.setTitle(L10n.text("readArticle"), for: .normal)
        articleAction?.isHidden = !post.isArticle
        if bookmark, commentsAction == nil {
            let button = makeAction(#selector(openComments))
            footer.addArrangedSubview(button)
            commentsAction = button
        }
        commentsAction?.setTitle(L10n.text("comments"), for: .normal)
        commentsAction?.isHidden = !bookmark
    }
    private func makeAction(_ action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.titleLabel?.numberOfLines = 0
        button.titleLabel?.textAlignment = .center
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }
    @objc private func toggleRead() {
        if let post = current { delegate?.postCellSetRead(post, read: !isRead) }
    }
    @objc private func copyLink() {
        if let url = current?.canonicalURL { ReaderClipboard.copyURL(url) }
    }
    @objc private func openActions() {
        if let post = current { delegate?.postCellActions(post, source: moreAction) }
    }
    @objc private func openArticle() {
        if let post = current { delegate?.postCellOpenArticle(post) }
    }
    @objc private func openComments() {
        if let post = current { delegate?.postCellComments(post) }
    }
    private func renderText() {
        guard let post = current, let context else { return }
        let authoredText = ReaderPostText.removingSelfPermalink(from: post.text, canonicalURL: post.canonicalURL)
        let collapse = context.preferences.bool("appearance.collapseLongPosts") && authoredText.count > 420
        let text = ReaderPostText.display(authoredText, collapsed: collapse && !expanded, limit: 420)
        let paragraph = NSMutableParagraphStyle(); paragraph.baseWritingDirection = .natural; paragraph.lineSpacing = context.preferences.string("density") == "compact" ? 1 : 3
        let attributed = NSMutableAttributedString(string: text, attributes: [.font: ReaderTheme.font(.body, preferences: context.preferences), .foregroundColor: ReaderTheme.text(context.preferences), .paragraphStyle: paragraph])
        let full = NSRange(text.startIndex..., in: text)
        let haystack = text as NSString
        for match in ReaderPostText.tokenMatcher?.matches(in: text, range: full) ?? [] {
            let value = haystack.substring(with: match.range)
            if let url = URL(string: value.hasPrefix("@") ? "ffn-profile://\(value.dropFirst())" : value) {
                attributed.addAttribute(.link, value: url, range: match.range)
            }
        }
        if !highlightText.isEmpty {
            var search = full
            while search.length > 0 {
                let match = haystack.range(of: highlightText, options: [.caseInsensitive, .diacriticInsensitive], range: search)
                if match.location == NSNotFound || match.length == 0 { break }
                attributed.addAttribute(.backgroundColor, value: UIColor.systemYellow.withAlphaComponent(0.28), range: match)
                let next = NSMaxRange(match)
                search = NSRange(location: next, length: haystack.length - next)
            }
        }
        textView.attributedText = attributed
        textView.linkTextAttributes = [.foregroundColor: ReaderTheme.accent(context.preferences), .underlineStyle: NSUnderlineStyle.single.rawValue]
        expand.isHidden = !collapse; expand.setTitle(L10n.text(expanded ? "showLess" : "showMore"), for: .normal)
    }
    func updateAppearance(_ preferences: ReaderPreferences) {
        ReaderTheme.styleCard(contentView, preferences: preferences)
        shadowBounds = contentView.bounds
        stack.spacing = ReaderTheme.spacing(preferences)
        contentView.directionalLayoutMargins = NSDirectionalEdgeInsets(top: preferences.string("density") == "compact" ? 8 : 12, leading: 12, bottom: preferences.string("density") == "compact" ? 8 : 12, trailing: 12)
        if current?.quoted != nil {
            quote.backgroundColor = ReaderTheme.elevated(preferences)
            quote.layer.borderWidth = 1 / max(1, traitCollection.displayScale)
            quote.layer.borderColor = ReaderTheme.border(preferences).resolvedColor(with: traitCollection).cgColor
        }
        authorButton.setTitleColor(ReaderTheme.text(preferences), for: .normal)
        authorButton.titleLabel?.font = ReaderTheme.font(.headline, preferences: preferences, weight: .semibold)
        metadata.textColor = ReaderTheme.text(preferences, secondary: true); readLabel.textColor = ReaderTheme.text(preferences, secondary: true)
        // DeviceRuntime already observes Reduce Transparency and publishes a
        // context appearance update for visible cells; keep one scene observer.
        videos.forEach { $0.updateAccessibilityAppearance() }
        renderText()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard contentView.bounds != shadowBounds else { return }
        shadowBounds = contentView.bounds
        ReaderTheme.updateCardShadowPath(contentView)
    }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection),
              let context else { return }
        updateAppearance(context.preferences)
    }
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
    static let tokenMatcher = try? NSRegularExpression(pattern: "https?://[^\\s]+|(?<![A-Za-z0-9_])@[A-Za-z0-9_]{1,15}")
    private static let permalinkMatcher = try? NSRegularExpression(pattern: "https?://[^\\s]+", options: [.caseInsensitive])
    /// Hide only a complete token identifying this exact post. Whitespace is
    /// authored content: removing a permalink must not collapse paragraphs.
    static func removingSelfPermalink(from text: String, canonicalURL: URL?) -> String {
        guard text.range(of: "://") != nil, let canonicalURL, let ownIdentity = postIdentity(canonicalURL),
              let matcher = permalinkMatcher else { return text }
        let result = NSMutableString(string: text)
        let punctuation = CharacterSet(charactersIn: ".,!?;:)}]")
        for match in matcher.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            let token = (text as NSString).substring(with: match.range)
            var candidate = token
            while let scalar = candidate.unicodeScalars.last, punctuation.contains(scalar) { candidate.removeLast() }
            guard let url = URL(string: candidate), postIdentity(url) == ownIdentity else { continue }
            result.deleteCharacters(in: NSRange(location: match.range.location, length: (candidate as NSString).length))
        }
        return result as String
    }
    private static func postIdentity(_ url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.user == nil, components.password == nil else { return nil }
        var host = components.host?.lowercased() ?? ""
        if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
        guard ["x.com", "twitter.com"].contains(host),
              components.percentEncodedPath.range(of: "^/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}/?$", options: .regularExpression) != nil else { return nil }
        let path = components.percentEncodedPath.split(separator: "/")
        return "\(path[0].lowercased())/\(path[2])"
    }
    /// Swift Character boundaries preserve composed emoji. Move the boundary
    /// before any URL or mention that would otherwise be cut in half.
    static func display(_ text: String, collapsed: Bool, limit: Int) -> String {
        guard collapsed, text.count > limit else { return text }
        var boundary = text.index(text.startIndex, offsetBy: max(0, limit))
        let range = NSRange(text.startIndex..., in: text)
        if let regex = tokenMatcher {
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
    private let stateLabel = readerLabel(L10n.text("loading"), style: .caption1, color: .secondaryLabel)
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
        backgroundColor = ReaderTheme.mediaBackground(ReaderTheme.currentPreferences); layer.cornerRadius = 12; clipsToBounds = true
        image.contentMode = .scaleAspectFit
        addSubview(image)
        let ratio = CGFloat(item.height ?? 300) / max(1, CGFloat(item.width ?? 500)); let height = heightAnchor.constraint(equalTo: widthAnchor, multiplier: min(1.3, max(0.35, ratio))); height.priority = .defaultHigh; height.isActive = true; heightAnchor.constraint(greaterThanOrEqualToConstant: 120).isActive = true
        stateLabel.textAlignment = .center
        if let label = stateLabel as? ReaderLabel {
            label.backgroundOverride = backgroundColor
            label.updateAppearance(ReaderTheme.currentPreferences)
        }
        addSubview(stateLabel)
        image.failure = { [weak self] in self?.showFailure() }
        image.loaded = { [weak self] in self?.stateLabel.isHidden = true; self?.accessibilityValue = nil }
        isAccessibilityElement = true; accessibilityTraits = .button; accessibilityLabel = item.alt?.isEmpty == false ? item.alt : L10n.text("openPhoto")
        addTarget(self, action: #selector(tapped), for: .touchUpInside); load()
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        stateLabel.frame = bounds.insetBy(dx: min(12, bounds.width / 2), dy: 0)
    }
    private func load() { failed = false; stateLabel.isHidden = false; stateLabel.text = L10n.text("loading"); accessibilityValue = L10n.text("loading"); guard !currentHandle.isEmpty else { showFailure(); return }; image.load(currentHandle, services: services) }
    private func showFailure() { failed = true; stateLabel.text = "\(L10n.text("photoFailed")) · \(L10n.text("retry"))"; stateLabel.isHidden = false; accessibilityValue = L10n.text("photoFailed") + ", " + L10n.text("retry") }
    @objc private func tapped() {
        guard repair == nil else { return }
        if failed { retryManually() } else { open?() }
    }
    private func retryManually() {
        guard repair == nil, !currentHandle.isEmpty else { return }
        let id = UUID(); repairID = id
        let handle = currentHandle; let services = services; let generation = services.accountGeneration
        isEnabled = false; stateLabel.text = L10n.text("loading"); accessibilityValue = L10n.text("loading")
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

final class InlinePlayerView: UIView, UIGestureRecognizerDelegate {
    private let item: PostMedia
    private let context: ReaderContext
    private let playbackKey: String
    private let owner = UUID()
    private let poster = RemoteImageView()
    private let playerLayer = AVPlayerLayer()
    private var player: AVPlayer?
    private var task: Task<Void, Never>?
    private var taskID = UUID()
    private var positionRestored = true
    private let notice = readerLabel(style: .caption1, color: .white)
    private let controls = UIStackView()
    private var button: UIButton!
    private var selectedURL: String
    private var savedPosition = 0.0
    private var selectedSpeed: Float
    private var selectedMuted: Bool?
    private var selectedLoop: Bool
    private var manuallyPaused = false
    private var endObserver: NSObjectProtocol?
    private(set) weak var loopingItem: AVPlayerItem?
    private var itemObserver: NSKeyValueObservation?
    private var statusObserver: NSKeyValueObservation?
    private var failed = false
    private var preparationFailed = false
    private var wantsPlayback = false
    var fullscreen: (() -> Void)?
    var position: Double { if !positionRestored { return savedPosition }; let v = player?.currentTime().seconds ?? savedPosition; return v.isFinite ? v : savedPosition }
    var isPlaying: Bool { (player?.rate ?? 0) > 0 }
    init(item: PostMedia, context: ReaderContext, playbackKey: String) {
        self.item = item; self.context = context; self.playbackKey = playbackKey; selectedURL = context.playbackState(playbackKey)?.selectedHandle ?? Self.initialURL(item, context: context); selectedSpeed = Float(context.playbackState(playbackKey)?.speed ?? context.preferences.number("video.defaultSpeed")); selectedMuted = context.playbackState(playbackKey)?.muted; selectedLoop = context.playbackState(playbackKey)?.loopPlayback ?? context.preferences.bool("video.loop"); savedPosition = context.position(playbackKey); manuallyPaused = context.isPaused(playbackKey); super.init(frame: .zero)
        backgroundColor = ReaderTheme.mediaBackground(context.preferences); layer.cornerRadius = 12; clipsToBounds = true
        heightAnchor.constraint(equalTo: widthAnchor, multiplier: min(1.3, max(0.5, CGFloat(item.height ?? 9) / CGFloat(max(1, item.width ?? 16))))).isActive = true
        poster.contentMode = .scaleAspectFit; addSubview(poster); poster.pin(to: self); poster.load(item.previewUrl, services: context.services)
        playerLayer.videoGravity = .resizeAspect; layer.addSublayer(playerLayer)
        button = readerButton(L10n.text("playVideo"), symbol: "play.fill") { [weak self] in self?.togglePlayback() }; button.tintColor = .white
        let full = readerButton("", symbol: "arrow.up.left.and.arrow.down.right") { [weak self] in self?.fullscreen?() }; full.tintColor = .white; full.accessibilityLabel = L10n.text("fullscreen")
        let settings = UIButton(type: .system); settings.setImage(UIImage(systemName: "slider.horizontal.3"), for: .normal); settings.tintColor = .white; settings.accessibilityLabel = L10n.text("mediaOptions"); settings.showsMenuAsPrimaryAction = true
        let speeds = [0.5, 0.75, 1, 1.25, 1.5, 2.0].map { speed in UIAction(title: "\(speed)×") { [weak self] _ in guard let self else { return }; selectedSpeed = Float(speed); if isPlaying { player?.rate = selectedSpeed } } }
        let qualities = item.variants.map { variant in UIAction(title: variant.label) { [weak self] _ in guard let self else { return }; let playing = isPlaying; selectedURL = variant.url; stop(); play(startPlaying: playing) } }
        settings.menu = UIMenu(children: [UIMenu(title: L10n.text("speed"), children: speeds), UIMenu(title: L10n.text("quality"), children: qualities)])
        controls.addArrangedSubview(button); controls.addArrangedSubview(settings); controls.addArrangedSubview(full)
        controls.spacing = 12; controls.translatesAutoresizingMaskIntoConstraints = false; addSubview(controls)
        NSLayoutConstraint.activate([controls.leadingAnchor.constraint(equalTo: leadingAnchor), controls.trailingAnchor.constraint(equalTo: trailingAnchor), controls.bottomAnchor.constraint(equalTo: bottomAnchor), controls.heightAnchor.constraint(greaterThanOrEqualToConstant: 44), settings.widthAnchor.constraint(greaterThanOrEqualToConstant: 44), full.widthAnchor.constraint(greaterThanOrEqualToConstant: 44)])
        notice.translatesAutoresizingMaskIntoConstraints = false; notice.numberOfLines = 0; addSubview(notice); NSLayoutConstraint.activate([notice.topAnchor.constraint(equalTo: topAnchor, constant: 8), notice.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), notice.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12)])
        updateAccessibilityAppearance()
        let tap = UITapGestureRecognizer(target: self, action: #selector(toggleFromSurface)); tap.delegate = self; tap.cancelsTouchesInView = false; addGestureRecognizer(tap)
    }
    required init?(coder: NSCoder) { fatalError("Use init") }
    func updateAccessibilityAppearance() {
        let background = ReaderTheme.mediaOverlay(reduceTransparency: context.runtime?.reduceTransparency ?? UIAccessibility.isReduceTransparencyEnabled, contrast: traitCollection.accessibilityContrast)
        controls.backgroundColor = background; notice.backgroundColor = background
    }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.accessibilityContrast != traitCollection.accessibilityContrast { updateAccessibilityAppearance() }
    }
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
        let playingOrPreparing = isPlaying || player?.timeControlStatus == .waitingToPlayAtSpecifiedRate
            || (task != nil && wantsPlayback)
        if !failed, player?.currentItem?.status != .failed, playingOrPreparing {
            manuallyPaused = true
            wantsPlayback = false
            context.rememberMedia(playbackKey, paused: true)
            if task != nil { stop() }
            else if let player { context.services.pausePlayer(player: player, owner: owner) }
            button.setTitle(L10n.text("playVideo"), for: .normal)
        } else { manuallyPaused = false; context.rememberMedia(playbackKey, paused: false); play() }
    }
    @objc func toggleFromSurface() { if context.preferences.bool("video.clickToggle") { togglePlayback() } }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let view = target, view !== self { if view is UIControl { return false }; target = view.superview }
        return context.preferences.bool("video.clickToggle")
    }
    func play(automatically: Bool = false, startPlaying: Bool = true) {
        if player == nil { restorePlaybackState() }
        guard !automatically || (!manuallyPaused && (item.kind != "gif" || context.preferences.bool("video.gifAutoplay"))) else { return }
        let needsRepair = failed || player?.currentItem?.status == .failed
        guard !automatically || !needsRepair else { return }
        guard task == nil else { return }
        wantsPlayback = startPlaying
        if !needsRepair, let player, player.currentItem != nil { if startPlaying { player.playImmediately(atRate: selectedSpeed) }; return }
        if needsRepair { stop() }
        preparationFailed = false
        notice.text = L10n.text("loading"); button.isEnabled = false
        let id = UUID(); taskID = id
        let generation = context.services.accountGeneration
        task = Task { [weak self] in
            guard let self else { return }
            defer {
                if taskID == id { task = nil; button.isEnabled = true }
            }
            do {
                if needsRepair {
                    let renewed = try await context.services.recoverMediaHandle(selectedURL)
                    try Task.checkCancellation(); guard taskID == id, generation == context.services.accountGeneration else { return }
                    selectedURL = renewed
                }
                let next = try await context.services.makePlayer(url: selectedURL, owner: owner)
                try Task.checkCancellation(); guard taskID == id, generation == context.services.accountGeneration else { return }
                positionRestored = savedPosition <= 0
                player = next; playerLayer.player = next; notice.text = nil; next.isMuted = selectedMuted ?? automatically
                failed = false; observe(next)
                if savedPosition > 0 {
                    try await context.services.seekPlayer(player:next,owner:owner,position:savedPosition)
                }
                try Task.checkCancellation()
                guard taskID == id, player === next, generation == context.services.accountGeneration else { return }
                positionRestored = true
                bindEndObserver(next.currentItem, player: next)
                if startPlaying { next.playImmediately(atRate: selectedSpeed) }; button.setTitle(L10n.text(startPlaying ? "pause" : "playVideo"), for: .normal)
            }
            catch { if !(error is CancellationError), taskID == id, generation == context.services.accountGeneration { preparationFailed = true; failed = true; notice.text = error.localizedDescription; button.setTitle(L10n.text("retry"), for: .normal); button.accessibilityLabel = L10n.text("retry") } }
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
            Task { @MainActor [weak self, weak observed] in
                guard let self, let observed, self.player === observed else { return }
                self.observeStatus(observed.currentItem, player: observed)
                self.bindEndObserver(observed.currentItem, player: observed)
            }
        }
    }
    private func bindEndObserver(_ item: AVPlayerItem?, player: AVPlayer) {
        if let item, loopingItem === item, endObserver != nil { return }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }
        loopingItem = nil
        guard let item, positionRestored, !preparationFailed else { return }
        loopingItem = item
        let generation = context.services.accountGeneration
        let loadID = taskID
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self, weak player, weak item] _ in
            Task { @MainActor [weak self, weak player, weak item] in
                guard let self, let player, let item,
                      self.canLoop(player:player, item:item, generation:generation, loadID:loadID) else { return }
                do {
                    try await self.context.services.seekPlayer(player:player, owner:self.owner, position:0)
                    guard self.canLoop(player:player, item:item, generation:generation, loadID:loadID) else { return }
                    player.playImmediately(atRate:self.selectedSpeed)
                } catch {
                    guard !(error is CancellationError),
                          self.canLoop(player:player, item:item, generation:generation, loadID:loadID) else { return }
                    self.preparationFailed = true
                    self.failed = true
                    self.notice.text = L10n.text("videoFailed")
                    self.button.setTitle(L10n.text("retry"), for: .normal)
                    self.button.accessibilityLabel = L10n.text("retry")
                }
            }
        }
    }
    private func canLoop(player: AVPlayer, item: AVPlayerItem, generation: UInt64, loadID: UUID) -> Bool {
        self.player === player && player.currentItem === item && taskID == loadID
            && context.services.accountGeneration == generation && wantsPlayback && !manuallyPaused
            && selectedLoop && !failed && context.runtime?.foreground != false
    }
    private func observeStatus(_ item: AVPlayerItem?, player observed: AVPlayer) {
        statusObserver?.invalidate(); statusObserver = nil
        guard let item else { return }
        statusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self, weak observed] item, _ in
            Task { @MainActor [weak self, weak observed, weak item] in
                guard let self, let observed, let item, self.player === observed, observed.currentItem === item else { return }
                switch item.status {
                case .failed: self.failed = true; self.notice.text = L10n.text("videoFailed"); self.button.setTitle(L10n.text("retry"), for: .normal); self.button.accessibilityLabel = L10n.text("retry"); self.button.isEnabled = true
                case .readyToPlay:
                    guard !self.preparationFailed else { return }
                    self.failed = false; self.notice.text = nil; self.button.setTitle(L10n.text(self.isPlaying ? "pause" : "playVideo"), for: .normal); self.button.accessibilityLabel = L10n.text(self.isPlaying ? "pause" : "playVideo")
                default: self.notice.text = L10n.text("loading")
                }
            }
        }
    }
    func stop() { if player?.currentItem?.status == .failed { failed = true }; if player != nil || task != nil { rememberPlaybackState(); savedPosition = position }; taskID = UUID(); task?.cancel(); task = nil; positionRestored = true; itemObserver?.invalidate(); itemObserver = nil; statusObserver?.invalidate(); statusObserver = nil; player?.pause(); playerLayer.player = nil; player = nil; loopingItem = nil; if let endObserver { NotificationCenter.default.removeObserver(endObserver); self.endObserver = nil }; button.isEnabled = true; context.services.releasePlayer(owner: owner) }
    deinit { task?.cancel(); itemObserver?.invalidate(); statusObserver?.invalidate(); if let endObserver { NotificationCenter.default.removeObserver(endObserver) } }
}
