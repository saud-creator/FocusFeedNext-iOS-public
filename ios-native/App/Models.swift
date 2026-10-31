import Foundation

enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    static func encoded<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}

struct Author: Codable, Hashable {
    var id: String
    var username: String
    var displayName: String
    var avatarUrl: String?
    var bannerUrl: String?
    var verified: Bool
    var bio: String?
    var followersCount: Int?
    var followingCount: Int?
    var location: String?
    var website: String?
    var joinedAt: String?
    var postsCount: Int?
    var label: String { displayName.isEmpty ? username : displayName }
}
struct MediaVariant: Codable, Hashable { var label: String; var url: String; var bitrate: Int?; var width: Int? = nil; var height: Int? = nil }
struct PostMedia: Codable, Hashable {
    var kind: String
    var url: String
    var previewUrl: String?
    var width: Int?
    var height: Int?
    var alt: String?
    var durationMs: Int?
    var variants: [MediaVariant]
}
struct PostMetrics: Codable, Hashable {
    var replies: Int; var reposts: Int; var likes: Int; var quotes: Int; var views: Int; var bookmarks: Int
}
struct QuotedPost: Codable, Hashable {
    var id: String; var author: Author; var text: String; var createdAt: String?; var media: [PostMedia]; var url: String?
}
struct Post: Codable, Hashable, Identifiable {
    var id: String
    var text: String
    var author: Author
    var createdAt: String
    var lang: String?
    var isRepost: Bool
    var repostedBy: Author?
    var isPromoted: Bool
    var quoted: QuotedPost?
    var metrics: PostMetrics
    var media: [PostMedia]
    var url: String?
    var isArticle: Bool
    var articleTitle: String?
    var inReplyTo: String?
    var provider: String
    var canonicalURL: URL? {
        guard id.range(of: "^[0-9]{1,25}$", options: .regularExpression) != nil,
              author.username.range(of: "^[A-Za-z0-9_]{1,15}$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://x.com/\(author.username)/status/\(id)")
    }
}
struct FeedFilters: Codable, Equatable {
    var hidePromoted = true
    var hideReposts = false
    var hideRead = false
    var unreadOnly = false
    var imagesOnly = false
    var videosOnly = false
    var textOnly = false
    var maxAgeHours = 0
    var mutedWords: [String] = []
    var languages: [String] = []
    static var originals: FeedFilters { var v = FeedFilters(); v.hideReposts = true; return v }
    static var focus: FeedFilters { var v = originals; v.unreadOnly = true; return v }
    func accepts(_ post: Post, read: Bool, includeReplies: Bool = false) -> Bool {
        if post.isPromoted || (!includeReplies && post.inReplyTo != nil) { return false }
        if hideReposts && post.isRepost || (hideRead || unreadOnly) && read { return false }
        let kinds = post.media.map(\.kind)
        if imagesOnly && !kinds.contains("image") { return false }
        if videosOnly && !kinds.contains(where: { $0 == "video" || $0 == "gif" }) { return false }
        if textOnly && !kinds.isEmpty { return false }
        if maxAgeHours > 0, let date = ReaderDates.parse(post.createdAt), Date().timeIntervalSince(date) > Double(maxAgeHours * 3600) { return false }
        if !languages.isEmpty, let language = post.lang, !languages.contains(language) { return false }
        return !mutedWords.contains { post.text.localizedCaseInsensitiveContains($0) }
    }
}
struct FeedResponse: Codable {
    var posts: [Post]; var fromCache: Bool; var provider: String; var lastSync: String?; var readIds: [String]; var totalCached: Int; var nextCursor: String?
    var nextOffset: Int? = nil
    var missingPostIds: [String]? = nil
}
struct SearchResponse: Codable { var posts: [Post]; var readIds: [String]; var nextOffset: Int? }
struct CachedPostsResponse: Codable { var posts: [Post]; var readIds: [String]; var missingPostIds: [String] }
struct CommentResponse: Codable { var posts: [Post]; var cursor: String? }
struct ArticleBlock: Codable { var kind: String; var text: String }
struct Article: Codable { var title: String; var blocks: [ArticleBlock] }
struct PostContent: Codable { var post: Post; var article: Article? }
struct ReaderList: Codable, Hashable, Identifiable { var id: String; var name: String; var color: String; var memberCount: Int }
struct GroupCandidate: Codable { var author: Author; var following: Bool; var member: Bool }
struct AccountFailure: Codable { var username: String; var code: String; var message: String }
struct GroupFeedResponse: Codable {
    var posts: [Post]; var fromCache: Bool; var provider: String; var lastSync: String?; var readIds: [String]; var totalCached: Int; var nextCursor: String?
    var failures: [AccountFailure]; var nextOffset: Int?; var memberCount: Int; var loadedAccounts: Int
    var nextMemberOffset: Int? = nil
    var feed: FeedResponse { FeedResponse(posts: posts, fromCache: fromCache, provider: provider, lastSync: lastSync, readIds: readIds, totalCached: totalCached, nextCursor: nextCursor, nextOffset: nextOffset) }
}
struct FollowingSnapshot: Codable { var accounts: [Author]; var complete: Bool; var syncing: Bool; var state: String?; var lastError: String?; var lastProgressAt: String? }
struct SessionSnapshot: Codable {
    var state: String; var reason: String; var checking: Bool; var account: Author?; var checkedAt: String?; var lastSuccessAt: String?; var latencyMs: Double?; var hasCredentials: Bool; var detail: String?
}
struct ProviderCapabilities: Codable {
    var feedCursor: Bool; var listCursor: Bool; var followingCursor: Bool; var userPostsCursor: Bool; var promotedFlag: Bool; var unfollow: Bool; var follow: Bool; var unbookmark: Bool; var mute: Bool; var block: Bool
}
struct FilterPreset: Codable, Identifiable { var id: String; var name: String; var filters: FeedFilters }
struct ResumeState: Codable { var enabled: Bool; var route: String; var postID: String?; var offset: Double; var accountID: String? }
struct ReaderRuntimeSnapshot: Codable {
    var foreground: Bool; var wifi: Bool; var expensive: Bool; var constrained: Bool; var lowPower: Bool; var thermal: String; var reduceMotion: Bool; var reduceTransparency: Bool; var contentSizeScale: Double; var memoryRevision: Int
}
struct MediaPresentation { var items: [PostMedia]; var index: Int; var position: Double = 0; var playing = true; var speed: Double = 1; var muted = false; var loopPlayback = true; var playbackKey: String? = nil }
struct MediaPresentationResult { var index: Int; var position: Double; var playing: Bool; var speed: Double = 1; var muted = false; var loopPlayback = true; var selectedHandle: String? = nil }
struct ReaderPlaybackState {
    var paused = false
    var position: Double = 0
    var speed: Double?
    var muted: Bool?
    var loopPlayback: Bool?
    var selectedHandle: String?
}
struct AppServiceError: LocalizedError {
    var code: String; var message: String; var retryable: Bool = false
    var errorDescription: String? { message }
}
enum AppEvent {
    case session(SessionSnapshot)
    case contentChanged
    case mediaRecoveryOpportunity
    case followingProgress
    case recovery(String)
    case runtimeChanged
}
enum ReaderRoute: String, Codable, CaseIterable {
    case following, focus, bookmarks, accounts, originals, groups, search, settings
    var symbol: String {
        switch self { case .following: return "square.stack"; case .focus: return "scope"; case .bookmarks: return "bookmark"; case .accounts: return "person.2"; case .originals: return "pencil.line"; case .groups: return "books.vertical"; case .search: return "magnifyingglass"; case .settings: return "gearshape" }
    }
    var title: String { L10n.text(rawValue) }
}
enum ReaderDates {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func label(_ value: String, absolute: Bool = false) -> String {
        guard let date = parse(value) else { return value }
        if absolute { return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(L10n.locale)) }
        let f = RelativeDateTimeFormatter(); f.locale = L10n.locale; f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}
