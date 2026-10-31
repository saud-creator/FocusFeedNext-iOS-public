import UIKit

final class ArticleViewController: ReaderScreen {
    private let post: Post
    private let body = UIStackView()
    private let notice = NoticeView()
    init(context: ReaderContext, post: Post) { self.post = post; super.init(context: context) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        super.viewDidLoad(); title = L10n.text("article")
        let scroll = UIScrollView(); view.addSubview(scroll); scroll.pin(to: view, safe: true); body.axis = .vertical; body.spacing = 18; body.translatesAutoresizingMaskIntoConstraints = false; scroll.addSubview(body)
        NSLayoutConstraint.activate([body.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20), body.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20), body.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20), body.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24), body.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40)])
        body.addArrangedSubview(notice); load()
    }
    private func load() {
        notice.show(L10n.text("loading"), busy: true)
        work = Task { [weak self] in guard let self else { return }; do {
            let content: PostContent = try await context.services.call(.postContent, ["postId": .string(post.id)])
            guard let article = content.article else { notice.show(L10n.text("articleUnavailable"), retry: { [weak self] in self?.load() }); return }
            body.arrangedSubviews.filter { $0 !== self.notice }.forEach { $0.removeFromSuperview() }; body.addArrangedSubview(readerLabel(article.title, style: .largeTitle)); body.addArrangedSubview(readerLabel(post.author.label, style: .subheadline, color: .secondaryLabel))
            var number = 0
            for block in article.blocks {
                if block.kind != "number" { number = 0 }
                if block.kind == "image" {
                    let item = PostMedia(kind: "image", url: block.text, previewUrl: nil, width: nil, height: nil, alt: nil, durationMs: nil, variants: [])
                    let tile = PhotoTile(item: item, services: context.services); tile.open = { [weak self, weak tile] in guard let self, let tile else { return }; let selected = tile.displayItem; Task { [self] in do { _ = try await self.context.services.presentMedia(MediaPresentation(items: [selected], index: 0), from: self) } catch { self.showError(error) } } }; body.addArrangedSubview(tile); continue
                }
                let style: UIFont.TextStyle = block.kind == "heading1" ? .title1 : block.kind == "heading2" ? .title2 : block.kind == "heading3" ? .title3 : .body
                if block.kind == "number" { number += 1 }
                let prefix = block.kind == "bullet" ? "• " : block.kind == "number" ? "\(number). " : block.kind == "quote" ? "❝ " : ""
                let label = readerLabel(prefix + block.text, style: style); label.font = block.kind == "code" ? UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .regular)) : ReaderTheme.font(style, preferences: context.preferences); if style != .body { label.accessibilityTraits.insert(.header) }; body.addArrangedSubview(label)
            }
            notice.show(nil)
        } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.load() }) } }
    }
}

final class CommentsViewController: FeedViewController {
    private let post: Post
    private var comments: [Post] = []
    private var cursor: String?
    private var cursors: Set<String> = []
    private var pages = 0
    private var fetching = false
    private var exhausted = false
    override func postDidHide(_ id: String) {comments.removeAll {$0.id == id};commentIDs.removeAll {$0 == id}}
    private var commentIDs: [String] = []
    private var needsRehydration = false
    private var hydrationRevision: UInt64 = 0
    init(context: ReaderContext, post: Post) { self.post = post; super.init(context: context, route: .bookmarks) }
    required init?(coder: NSCoder) { fatalError("Use context") }
    override func viewDidLoad() {
        automaticallyLoads = false; includesReplies = true; title = L10n.text("comments"); super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "arrow.up.right.square"), style: .plain, target: self, action: #selector(openOriginal)); navigationItem.rightBarButtonItem?.accessibilityLabel = L10n.text("originalPost"); fetch()
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); context.timelines.releaseHydratedPosts()
        if needsRehydration { needsRehydration = false; rehydrateComments() }
    }
    override func releaseHydratedContent() {
        if !comments.isEmpty { commentIDs = comments.map(\.id) }
        comments = []; hydrationRevision &+= 1; fetching = false; needsRehydration = !commentIDs.isEmpty
        super.releaseHydratedContent()
    }
    override func trimHydratedForMemoryPressure() { /* This view is already bounded to at most five provider pages. */ }
    private func rehydrateComments() {
        hydrationRevision &+= 1; let revision = hydrationRevision; let ids = commentIDs; let pageCount = max(1, min(5, pages)); fetching = true
        work = Task { [weak self] in
            guard let self else { return }; defer { if hydrationRevision == revision { fetching = false } }
            do {
                var restored: [Post] = []; var read = Set<String>(); var missing = false
                for start in stride(from:0, to:ids.count, by:80) {
                    let response: CachedPostsResponse = try await context.services.call(.cachedPosts, ["postIds": try .encoded(Array(ids.dropFirst(start).prefix(80)))])
                    restored += response.posts; read.formUnion(response.readIds); missing = missing || !response.missingPostIds.isEmpty
                }
                // Only if core bodies were evicted, replay this already visited
                // bounded comment traversal. Never replay an account mutation.
                if missing {
                    restored = []; var next: String?; var seen = Set<String>()
                    for _ in 0..<pageCount {
                        let response: CommentResponse = try await context.services.call(.bookmarkReplies, ["postId": .string(post.id), "cursor": next.map(JSONValue.string) ?? .null])
                        let known = Set(restored.map(\.id)); restored += response.posts.filter { !known.contains($0.id) }
                        guard let cursor = response.cursor, seen.insert(cursor).inserted else { next = nil; break }; next = cursor
                    }
                    cursor = next; cursors = seen
                }
                try Task.checkCancellation(); guard revision == hydrationRevision else { return }
                comments = restored; commentIDs = comments.map(\.id); replacePosts(comments, readIDs:Array(read)); restoreSessionAnchor()
            } catch { if !(error is CancellationError), revision == hydrationRevision { notice.show(error.localizedDescription, retry:{ [weak self] in self?.rehydrateComments() }) } }
        }
    }
    private func fetch() {
        guard !fetching, !exhausted else { return }; fetching = true; notice.show(comments.isEmpty ? L10n.text("loading") : nil, busy: true)
        work = Task { [weak self] in guard let self else { return }; defer { fetching = false; refreshControl.endRefreshing() }
            do {
                let response: CommentResponse = try await context.services.call(.bookmarkReplies, ["postId": .string(post.id), "cursor": cursor.map(JSONValue.string) ?? .null])
                let known = Set(comments.map(\.id)); comments += response.posts.filter { !known.contains($0.id) }; pages += 1
                commentIDs = comments.map(\.id)
                exhausted = response.cursor == nil || pages >= 5 || response.cursor.map { self.cursors.contains($0) } == true
                if let next = response.cursor { cursors.insert(next) }; cursor = response.cursor
                replacePosts(comments); status.text = exhausted && response.cursor != nil ? L10n.text("commentsLimit") : nil
                if comments.isEmpty { notice.show(L10n.text("commentsEmpty")) }
            } catch { notice.show(error.localizedDescription, retry: { [weak self] in self?.fetch() }) }
        }
    }
    override func refreshTapped() { cursor = nil; cursors = []; pages = 0; comments = []; commentIDs = []; exhausted = false; fetch() }
    override func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) { super.collectionView(collectionView, willDisplay: cell, forItemAt: indexPath); if indexPath.item >= posts.count - 4 { fetch() } }
    @objc private func openOriginal() { if let url = post.canonicalURL { postCellOpenURL(url) } }
}
