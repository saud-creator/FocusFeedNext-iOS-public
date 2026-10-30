import UIKit

final class ProfileViewController: FeedViewController {
    private let username: String
    private let identity = UIStackView()
    private let profileNotice = NoticeView()
    private var detailsTask: Task<Void, Never>?
    private var author: Author?
    private var tab = 0
    private var mediaKind = 0
    init(context: ReaderContext, username: String) { self.username = username; super.init(context: context, route: .following, source: "user:\(username)") }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        title = "@\(username)"
        identity.axis = .vertical; identity.spacing = 12; identity.isLayoutMarginsRelativeArrangement = true; identity.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 16, leading: 12, bottom: 12, trailing: 12); profileHeader = identity
        super.viewDidLoad(); renderIdentity(); fetchDetails()
    }
    private func fetchDetails(refresh: Bool = false) {
        detailsTask?.cancel(); profileNotice.show(L10n.text("loading"), busy: true)
        detailsTask = Task { [weak self] in guard let self else { return }; do { author = try await context.services.profile(username, refresh: refresh); title = author?.label; renderIdentity(); profileNotice.show(nil) } catch { profileNotice.show(error.localizedDescription, retry: { [weak self] in self?.fetchDetails(refresh: true) }) } }
    }
    private func renderIdentity() {
        identity.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if let author {
            if let banner = author.bannerUrl { let image = RemoteImageView(); image.contentMode = .scaleAspectFill; image.clipsToBounds = true; image.heightAnchor.constraint(equalToConstant: 120).isActive = true; image.load(banner, services: context.services); identity.addArrangedSubview(image) }
            let avatar = RemoteImageView(); avatar.contentMode = .scaleAspectFit; avatar.heightAnchor.constraint(equalToConstant: 72).isActive = true; avatar.fallbackInitials(author.label); avatar.load(author.avatarUrl, services: context.services, maxPixel: 200); identity.addArrangedSubview(avatar)
            identity.addArrangedSubview(readerLabel("\(author.label)\(author.verified ? " ✓" : "")", style: .title2)); identity.addArrangedSubview(readerLabel("@\(author.username)", style: .subheadline, color: .secondaryLabel)); identity.addArrangedSubview(readerLabel(author.bio ?? L10n.text("bioUnavailable")))
            let stats = [(author.followersCount, "followers"), (author.followingCount, "followingCount"), (author.postsCount, "posts")].compactMap { value, key in value.map { "\($0.formatted(.number.locale(L10n.locale))) \(L10n.text(key))" } }.joined(separator: " · ")
            identity.addArrangedSubview(readerLabel(stats, style: .subheadline, color: .secondaryLabel))
            let metadata = [author.location, author.website, author.joinedAt.map { "\(L10n.text("joined")) \(ReaderDates.label($0, absolute: true))" }].compactMap { $0 }.joined(separator: " · ")
            if !metadata.isEmpty { identity.addArrangedSubview(readerLabel(metadata, style: .footnote, color: .secondaryLabel)) }
            identity.addArrangedSubview(readerButton(L10n.text("relationshipUnknown")) { [weak self] in self?.relationship() })
            identity.addArrangedSubview(readerButton(L10n.text("creatorSubscription")) { [weak self] in guard let self else { return }; Task { do { try await context.services.command(.creatorSubscription, ["username": .string(username)]) } catch { showError(error) } } })
        } else { identity.addArrangedSubview(readerLabel("@\(username)", style: .title2)) }
        identity.addArrangedSubview(profileNotice)
        identity.addArrangedSubview(readerButton(L10n.text("refreshDetails"), symbol: "arrow.clockwise") { [weak self] in self?.fetchDetails(refresh: true) })
        let tabs = UISegmentedControl(items: [L10n.text("posts"), L10n.text("originals"), L10n.text("media")]); tabs.selectedSegmentIndex = tab; tabs.addTarget(self, action: #selector(changeTab(_:)), for: .valueChanged); tabs.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; identity.addArrangedSubview(tabs)
        if tab == 2 { let kinds = UISegmentedControl(items: [L10n.text("all"), L10n.text("photos"), L10n.text("videos")]); kinds.selectedSegmentIndex = mediaKind; kinds.addTarget(self, action: #selector(changeMediaKind(_:)), for: .valueChanged); kinds.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; identity.addArrangedSubview(kinds); identity.addArrangedSubview(readerLabel(L10n.text("latestFirst"), style: .caption1, color: .secondaryLabel)) }
        collection?.collectionViewLayout.invalidateLayout()
    }
    @objc private func changeTab(_ sender: UISegmentedControl) { tab = sender.selectedSegmentIndex; updatePredicate(); renderIdentity(); apply() }
    @objc private func changeMediaKind(_ sender: UISegmentedControl) { mediaKind = sender.selectedSegmentIndex; updatePredicate(); apply() }
    private func updatePredicate() { filters.hideReposts = tab == 1; let kind = mediaKind; postPredicate = tab == 2 ? { post in !post.media.isEmpty && (kind == 0 || post.media.contains { kind == 1 ? $0.kind == "image" : ["video", "gif"].contains($0.kind) }) } : nil }
    private func relationship() {
        Task { do {
            let allowed: Bool = try await context.services.call(.unfollowAllowed)
            guard allowed else { showError(AppServiceError(code: "disabled", message: L10n.text("allowAccountActions"))); return }
            let relation: String = try await context.services.call(.relationship, ["username": .string(username)])
            let following = relation == "following"; guard relation == "following" || relation == "notFollowing", following ? context.capabilities?.unfollow == true : context.capabilities?.follow == true else { showError(AppServiceError(code: "unknown", message: L10n.text("relationshipUnknown"))); return }
            let run: () -> Void = { [weak self] in guard let self else { return }; Task { do { try await context.services.command(following ? .unfollow : .follow, ["username": .string(username), "confirmed": .bool(true)]); fetchDetails(refresh: true) } catch { showError(error) } } }
            if following { confirm(title: "\(L10n.text("unfollow")) @\(username)?", message: L10n.text("actionNoRetry"), action: L10n.text("unfollow"), destructive: true, perform: run) } else { run() }
        } catch { showError(error) } }
    }
    deinit { detailsTask?.cancel() }
}
