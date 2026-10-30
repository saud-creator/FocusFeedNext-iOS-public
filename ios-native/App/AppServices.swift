import UIKit
import AVFoundation

/// Closed operation set. Core/provider adapters reject unknown commands before dispatch.
enum AppOperation: String, Codable {
    case runtimeSnapshot = "runtime_snapshot"
    case sessionStatus = "session_status", checkSession = "check_session", disconnect = "disconnect_x_account"
    case cachedFeed = "get_cached_feed", refreshFeed = "refresh_feed", loadFeedPage = "load_feed_page"
    case providerCapabilities = "provider_capabilities", userProfile = "get_user_profile"
    case readIDs = "get_read_ids", setRead = "set_read", hidePost = "hide_post"
    case postContent = "refresh_post_content", bookmarkReplies = "get_bookmark_replies"
    case searchCachedPosts = "search_cached_posts", followingSnapshot = "get_following_snapshot", startFollowingSync = "start_following_sync"
    case pinnedAccounts = "get_pinned_accounts", pinAccount = "pin_account"
    case groups = "get_groups", createGroup = "create_group", updateGroup = "update_group", deleteGroup = "delete_group"
    case groupCandidates = "get_group_candidates", groupMembers = "get_group_members", setGroupMember = "set_group_member"
    case groupFeed = "get_group_feed", refreshGroupFeed = "refresh_group_feed"
    case settings = "get_settings", setSetting = "set_setting", setPreferencesBatch = "set_preferences_batch"
    case mutedWords = "get_muted_words", setMutedWord = "set_muted_word", unfollowAllowed = "unfollow_allowed"
    case relationship = "get_account_relationship", follow = "follow_account", unfollow = "unfollow_account", removeBookmark = "remove_bookmark"
    case diagnosticsReport = "diagnostics_report", connectionMetrics = "get_connection_metrics", clearCache = "clear_cache"
    case openExternal = "open_external_url", creatorSubscription = "open_creator_subscription"
    case filterPresets = "get_filter_presets", setFilterPresets = "set_filter_presets"
    case resumeState = "get_resume_state", setResumeState = "set_resume_state"
}
struct AppRequest: Codable {
    let requestID: UUID
    let accountGeneration: UInt64
    let sourceRevision: UInt64
    let deadlineMillis: UInt64
    let priority: UInt8
    let operation: AppOperation
    let args: [String: JSONValue]
    init(requestID: UUID, accountGeneration: UInt64, operation: AppOperation, args: [String: JSONValue], sourceRevision: UInt64 = 0, deadlineMillis: UInt64? = nil, priority: UInt8 = 1) {
        self.requestID = requestID; self.accountGeneration = accountGeneration; self.sourceRevision = sourceRevision; self.deadlineMillis = deadlineMillis ?? UInt64(Date().timeIntervalSince1970 * 1000) + 30_000; self.priority = priority; self.operation = operation; self.args = args
    }
}

@MainActor protocol AppServices: AnyObject {
    var accountGeneration: UInt64 { get }
    var events: AsyncStream<AppEvent> { get }
    func perform(_ request: AppRequest) async throws -> Data
    func cancel(requestID: UUID)
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot
    func mediaURL(for handle: String) async throws -> URL
    func imageData(url: String, maxPixelDimension: Int) async throws -> Data
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer
    func releasePlayer(owner: UUID)
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult
    func recoverMedia() async throws
}

extension AppServices {
    func call<T: Decodable>(_ operation: AppOperation, _ args: [String: JSONValue] = [:], as type: T.Type = T.self) async throws -> T {
        let request = AppRequest(requestID: UUID(), accountGeneration: accountGeneration, operation: operation, args: args)
        let data = try await withTaskCancellationHandler(operation: { try await perform(request) }, onCancel: { Task { @MainActor in self.cancel(requestID: request.requestID) } })
        guard request.accountGeneration == accountGeneration || [.sessionStatus, .checkSession, .disconnect, .clearCache].contains(operation) else { throw CancellationError() }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func command(_ operation: AppOperation, _ args: [String: JSONValue] = [:]) async throws {
        let request = AppRequest(requestID: UUID(), accountGeneration: accountGeneration, operation: operation, args: args)
        _ = try await withTaskCancellationHandler(operation: { try await perform(request) }, onCancel: { Task { @MainActor in self.cancel(requestID: request.requestID) } })
        guard request.accountGeneration == accountGeneration || [.disconnect, .clearCache].contains(operation) else { throw CancellationError() }
    }
    func session() async throws -> SessionSnapshot { try await call(.sessionStatus) }
    func feed(_ source: String, filters: FeedFilters, cursor: String? = nil, cached: Bool = false, offset: Int = 0) async throws -> FeedResponse {
        var args: [String: JSONValue] = ["feed": .string(source), "filters": try .encoded(filters), "max": .number(30), "limit": .number(80), "offset": .number(Double(offset))]
        if let cursor { args["cursor"] = .string(cursor) }
        return try await call(cached ? .cachedFeed : cursor == nil ? .refreshFeed : .loadFeedPage, args)
    }
    func profile(_ username: String, refresh: Bool = false) async throws -> Author { try await call(.userProfile, ["username": .string(username), "refresh": .bool(refresh)]) }
    func setRead(_ id: String, read: Bool) async throws { try await command(.setRead, ["postId": .string(id), "read": .bool(read)]) }
    func hide(_ id: String) async throws { try await command(.hidePost, ["postId": .string(id), "hidden": .bool(true)]) }
    func settings() async throws -> [[String]] { try await call(.settings) }
    func saveSettings(_ entries: [[String]], portable: Bool = false) async throws { try await command(.setPreferencesBatch, ["entries": try .encoded(entries), "portable": .bool(portable)]) }
    func presets() async throws -> [FilterPreset] { try await call(.filterPresets) }
    func savePresets(_ presets: [FilterPreset]) async throws { try await command(.setFilterPresets, ["presets": try .encoded(presets)]) }
    func resumeState() async throws -> ResumeState? { try await call(.resumeState) }
    func saveResumeState(_ state: ResumeState) async throws { try await command(.setResumeState, ["state": try .encoded(state)]) }
}
