import UIKit
import AVKit

/// Sole trusted adapter between native screens, provider execution and Rust.
/// Credentials and internal broker URLs are never included in content events.
@MainActor final class NativeApplicationServices: AppServices {
    private let core: CoreRepository
    private weak var window: UIWindow?
    private(set) var accountGeneration: UInt64 = 0
    let events: AsyncStream<AppEvent>
    private let continuation: AsyncStream<AppEvent>.Continuation
    private var credentials: NativeSessionCandidate?
    private var currentAccount: Author?
    private var transportGeneration: UInt64 = 1
    private var providerSequence: UInt64 = 0
    private var sourceRevision: UInt64 = 0
    private var sourceRevisions: [String: UInt64] = [:]
    private var ownedProviderIDs: [UUID: Set<String>] = [:]
    private var cancelled = Set<UUID>()
    private var requestContexts: [UUID: AppRequest] = [:]
    private var profileJobs: [String: Task<Data, Error>] = [:]
    private var feedJobs: [String: Task<Data, Error>] = [:]
    private var followingJob: Task<Void, Never>?
    private var followingComplete = false
    private var followingError: String?
    private var groupRefreshPending: [String: Set<String>] = [:]
    private var brokerEpoch: UInt64 = 1
    private struct MediaLocator {
        enum Owner { case post(String), author(String), article(String) }
        let owner: Owner
        let path: [String]
    }
    private var handleOwners: [String: MediaLocator] = [:]
    private var resolvedHandles: [String: String] = [:]
    private var resolvedHandleOrder: [String] = []
    private var recoveryTask: Task<Void, Never>?
    private var restoring: Task<SessionSnapshot, Error>?
    private var sessionRevision: UInt64 = 0
    private var sessionCommitTail: Task<Void, Never>?
    private var restoringRevision: UInt64?
    private var checkedAt: String?
    private var lastSuccessAt: String?
    private var recoveryEpoch: UInt64 = 1
    private var imageAttempts: [String: (epoch: UInt64, time: TimeInterval)] = [:]
    private lazy var host: NativeHostService = {
        let service = NativeHostService(presentingController: { [weak self] in self?.presenter }, transportHost: { [weak self] in self?.window?.rootViewController?.view })
        service.runtimeChanged = { [weak self] snapshot in self?.runtimeChanged(snapshot) }
        service.mediaService = media
        service.validateBrokerURL = { [weak self] url in guard let self else { throw CancellationError() }; _ = try await self.run(.validateMediaUrl, ["url": url.absoluteString]) }
        return service
    }()
    private lazy var media: NativeMediaService = {
        let value = NativeMediaService(validateBrokerURL: { [weak self] url in guard let self else { throw CancellationError() }; _ = try await self.run(.validateMediaUrl, ["url": url.absoluteString]) }, repair: { [weak self] url, fresh in guard let self else { throw CancellationError() }; return try await self.repair(url, fresh: fresh) })
        value.recoveryOpportunity = { [weak self] in self?.scheduleRecovery() }
        return value
    }()
    private var presenter: UIViewController? {
        var current = window?.rootViewController
        while let next = current?.presentedViewController { current = next }
        return current
    }
    private init(core: CoreRepository, window: UIWindow) {
        self.core = core; self.window = window
        var captured: AsyncStream<AppEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { captured = $0 }
        continuation = captured
    }
    static func open(window: UIWindow) async throws -> NativeApplicationServices {
        let core = try await CoreRepository.open()
        return NativeApplicationServices(core: core, window: window)
    }
    private static func encoded(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .sortedKeys]) }
    private func run(_ operation: NativeOperation, _ args: [String: Any] = [:], owner: UUID? = nil, generation: UInt64? = nil, revision: UInt64? = nil) async throws -> Data {
        let id = owner ?? UUID(); guard !cancelled.contains(id) else { throw CancellationError() }
        let epoch = generation ?? accountGeneration
        let data = try Self.encoded(args)
        let context = requestContexts[id]
        let source = args["feed"] as? String ?? ""
        let sourceEpoch = revision ?? sourceRevisions[source] ?? context?.sourceRevision ?? 0
        let repository = core
        let result: Data
        do {
            result = try await withTaskCancellationHandler(operation: {
                try await repository.execute(operation, args:data, generation:epoch, revision:sourceEpoch, id:id.uuidString, deadline:context?.deadlineMillis ?? UInt64(Date().timeIntervalSince1970 * 1000) + 30_000, priority:context?.priority ?? 1)
            }, onCancel: { repository.cancel(id.uuidString) })
        } catch let error as NativeError {
            switch error {
            case .Operation(let code, _):
                if ["cancelled","stale_request"].contains(code) {throw CancellationError()}
                let key = code.contains("storage") || code.contains("database") ? "storagePreserved" : code.contains("rate") ? "rateLimited" : code.contains("auth") ? "signInRequired" : "loadFailed"
                throw AppServiceError(code:code,message:L10n.text(key))
            }
        }
        guard !cancelled.contains(id), epoch == accountGeneration || generation != nil else { throw CancellationError() }
        indexHandles(result)
        return result
    }
    private func object(_ data: Data) throws -> [String: Any] { try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:] }
    private func indexHandles(_ data: Data) {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return }
        func visit(_ value: Any, owner: MediaLocator.Owner?, path: [String]) {
            if let dictionary = value as? [String: Any] {
                if let post=dictionary["post"] as? [String:Any],let id=post["id"] as? String {
                    visit(post,owner:nil,path:[])
                    if let article=dictionary["article"] {visit(article,owner:.article(id),path:["article"])}
                    return
                }
                var nextOwner = owner; var nextPath = path
                if owner == nil, dictionary["text"] != nil, let id = dictionary["id"] as? String {
                    nextOwner = .post(id); nextPath = []
                } else if let username = dictionary["username"] as? String, dictionary["displayName"] != nil {
                    nextOwner = .author(username); nextPath = []
                }
                for (key,value) in dictionary { visit(value, owner: nextOwner, path: nextPath + [key]) }
            } else if let array = value as? [Any] {
                for (index,value) in array.enumerated() { visit(value, owner: owner, path: path + [String(index)]) }
            } else if let string = value as? String, string.hasPrefix("ffmedia:"), let owner {
                handleOwners[string] = MediaLocator(owner: owner, path: path)
            }
        }
        visit(root, owner: nil, path: [])
        // Retain descriptors for roughly two registry lifetimes, enough to repair
        // evicted viewport handles without retaining provider bodies in Swift.
        if handleOwners.count > 8192 {
            let live = Set(resolvedHandles.values)
            handleOwners = handleOwners.filter { live.contains($0.key) }
        }
    }
    func cancel(requestID: UUID) {
        cancelled.insert(requestID); core.cancel(requestID.uuidString)
        ownedProviderIDs.removeValue(forKey: requestID)?.forEach { host.cancelRequest(id: $0) }
        if cancelled.count > 1024 { cancelled = [requestID] }
    }
    func pause() { media.pauseAll() }
    private func snapshot(state: String = "connected", detail: String? = nil) -> SessionSnapshot {
        SessionSnapshot(state: credentials == nil ? "disconnected" : state, reason: credentials == nil ? "missing_credentials" : "connected", checking: false, account: currentAccount, checkedAt: checkedAt, lastSuccessAt: lastSuccessAt, latencyMs: nil, hasCredentials: credentials != nil, detail: detail)
    }
    private func provider(_ operation: String, variables: [String: Any] = [:], owner: UUID? = nil, candidate: NativeSessionCandidate? = nil, authentication: Bool = false) async throws -> Any {
        guard let session = candidate ?? credentials else { throw AppServiceError(code: "not_authenticated", message: L10n.text("signIn")) }
        let epoch = accountGeneration; let requestOwner = owner ?? UUID()
        providerSequence &+= 1; let id = String(providerSequence)
        ownedProviderIDs[requestOwner, default: []].insert(id)
        defer { ownedProviderIDs[requestOwner]?.remove(id); if ownedProviderIDs[requestOwner]?.isEmpty == true { ownedProviderIDs.removeValue(forKey: requestOwner) } }
        let values = try JSONDecoder().decode([String: NativeJSONValue].self, from: Self.encoded(variables))
        let write = ["Follow", "Unfollow", "DeleteBookmark"].contains(operation)
        let context = requestContexts[requestOwner]
        let deadline = context?.deadlineMillis ?? UInt64(Date().timeIntervalSince1970 * 1000) + (write || authentication ? 75_000 : 30_000)
        let request = NativeProviderRequest(operation: operation, variables: values, authToken: session.authToken, ct0: session.ct0, context: NativeRequestContext(id: id, generation: transportGeneration, priority: write || authentication ? 0 : Int(context?.priority ?? 1), deadline: deadline, authentication: authentication))
        let response: NativeProviderResponse
        do { response = try await host.request(request) }
        catch let error as NativeServiceError {
            throw AppServiceError(code:error.code,message:ConnectionFault.loginMessage(error.code,arabic:L10n.arabic),retryable:error.retryable)
        }
        guard !cancelled.contains(requestOwner), epoch == accountGeneration else { throw CancellationError() }
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response.body), options: [.fragmentsAllowed])
        if response.status == 429 { throw AppServiceError(code: "rate_limited", message: L10n.text("rateLimited")) }
        if response.status == 401 { throw AppServiceError(code: "authentication_expired", message: L10n.text("signInRequired")) }
        if let errors = (body as? [String: Any])?["errors"] as? [[String: Any]], !errors.isEmpty {
            let code = errors.first?["code"] as? Int
            throw AppServiceError(code: code == 326 ? "account_challenge" : code == 88 ? "rate_limited" : "provider_rejection", message: L10n.text("accountAttention"))
        }
        guard (200..<300).contains(response.status) else { throw AppServiceError(code: "provider_rejection", message: L10n.text("loadFailed"), retryable: response.status >= 500) }
        return body
    }
    private func validateIdentity(_ body: Any) async throws -> Author { try JSONDecoder().decode(Author.self, from: await run(.parseIdentity, ["body": body])) }
    private func sessionCommit<T>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let previous = sessionCommitTail
        let task = Task { @MainActor () throws -> T in
            if let previous { await previous.value }
            return try await operation()
        }
        sessionCommitTail = Task { @MainActor in _ = try? await task.value }
        return try await task.value
    }
    private func acceptIdentity(_ body: Any, candidate: NativeSessionCandidate, revision: UInt64, migrateSaved: Bool = false) async throws -> SessionSnapshot {
        let verified = try await validateIdentity(body)
        return try await sessionCommit { [self] in
        guard revision == sessionRevision else { throw CancellationError() }
        if migrateSaved {
            try await host.migrateSavedCandidate(candidate)
            guard revision == sessionRevision else { throw CancellationError() }
        }
        let identityChanged = currentAccount?.id != verified.id
        let generation = identityChanged ? accountGeneration + 1 : accountGeneration
        if identityChanged {
            followingJob?.cancel(); followingJob = nil; followingComplete = false; followingError = nil
            profileJobs.values.forEach { $0.cancel() }; profileJobs.removeAll()
            feedJobs.values.forEach { $0.cancel() }; feedJobs.removeAll()
            recoveryTask?.cancel(); recoveryTask = nil
            handleOwners.removeAll(); resolvedHandles.removeAll(); resolvedHandleOrder.removeAll(); imageAttempts.removeAll()
            sourceRevisions.removeAll()
            groupRefreshPending.removeAll()
            await host.cancelReads()
        }
        let result = try await run(.setAccount, ["body": body], generation: generation)
        let value = try object(result)
        // Keep the bridge generation coherent even when a newer transition was
        // requested during the core call. The queued transition can then clean
        // up the committed core state before publishing its own result.
        accountGeneration = generation; transportGeneration &+= 1
        media.invalidate(accountEpoch: generation, brokerEpoch: brokerEpoch)
        guard revision == sessionRevision else { throw CancellationError() }
        currentAccount = try JSONDecoder().decode(Author.self, from: Self.encoded(value["account"] ?? [:]))
        credentials = candidate
        checkedAt = ISO8601DateFormatter().string(from:Date()); lastSuccessAt = checkedAt
        let next = snapshot(); continuation.yield(.session(next)); return next
        }
    }
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot {
        sessionRevision &+= 1
        restoring?.cancel(); restoring = nil; restoringRevision = nil
        let revision = sessionRevision
        if let pending = sessionCommitTail { await pending.value }
        guard revision == sessionRevision else { throw CancellationError() }
        let previous = credentials
        var finalized = false
        var verifiedCandidate: NativeSessionCandidate?
        do {
            let candidate = try await host.beginLogin()
            guard revision == sessionRevision else { throw CancellationError() }
            let before = try await provider("Me", candidate: candidate, authentication: true)
            let expected = try await validateIdentity(before)
            let committed = try await host.commitCandidate()
            let after = try await provider("Me", candidate: committed, authentication: true)
            let actual = try await validateIdentity(after)
            guard revision == sessionRevision else { throw CancellationError() }
            guard expected.id == actual.id else { throw AppServiceError(code: "identity_mismatch", message: L10n.text("accountAttention")) }
            // Finish the same verified transaction after activation, without
            // restarting login or publishing a partially committed identity.
            while true {
                do { try await host.finalizeLogin(); break }
                catch let error as NativeServiceError where error.code == "background_paused" {
                    _ = try await host.checkedCall(command:"waitForLoginActive")
                }
            }
            verifiedCandidate = committed; finalized = true
            return try await acceptIdentity(after,candidate:committed,revision:revision)
        } catch {
            guard revision == sessionRevision else { throw CancellationError() }
            if finalized { credentials = verifiedCandidate; currentAccount = nil }
            else { credentials = previous; try? await host.rollbackLogin() }
            if let native=error as? NativeServiceError {
                throw AppServiceError(code:native.code,message:ConnectionFault.loginMessage(native.code,arabic:L10n.arabic),retryable:native.retryable)
            }
            throw error
        }
    }
    private func restoreSession(force: Bool = false) async throws -> SessionSnapshot {
        if credentials != nil, currentAccount != nil, !force { return snapshot() }
        if let restoring { return try await restoring.value }
        let revision = sessionRevision
        let task = Task { @MainActor () throws -> SessionSnapshot in
            guard let candidate = try await self.host.loadSavedCandidate() else { return self.snapshot() }
            try Task.checkCancellation(); guard revision == self.sessionRevision else { throw CancellationError() }
            let body = try await self.provider("Me", candidate: candidate)
            _ = try await self.validateIdentity(body)
            try Task.checkCancellation(); guard revision == self.sessionRevision else { throw CancellationError() }
            return try await self.acceptIdentity(body,candidate:candidate,revision:revision,migrateSaved:true)
        }
        restoring = task; restoringRevision = revision
        defer { if restoringRevision == revision { restoring = nil; restoringRevision = nil } }
        return try await task.value
    }
    func perform(_ request: AppRequest) async throws -> Data {
        guard request.accountGeneration == accountGeneration, !cancelled.contains(request.requestID) else { throw CancellationError() }
        requestContexts[request.requestID] = request
        defer { requestContexts.removeValue(forKey:request.requestID) }
        let args = try object(JSONEncoder().encode(request.args)); let owner = request.requestID
        switch request.operation {
        case .sessionStatus: return try JSONEncoder().encode(try await restoreSession())
        case .checkSession: return try JSONEncoder().encode(try await restoreSession(force: true))
        case .disconnect:
            sessionRevision &+= 1; restoring?.cancel(); restoring = nil; restoringRevision = nil
            let revision = sessionRevision
            return try await sessionCommit { [self] in
            guard revision == sessionRevision else { throw CancellationError() }
            followingJob?.cancel(); followingJob = nil; recoveryTask?.cancel(); profileJobs.values.forEach { $0.cancel() }; feedJobs.values.forEach { $0.cancel() }
            // Core refuses disconnect while an account write still owns its slot.
            _ = try await run(.clearSession, ["disconnect":true])
            accountGeneration &+= 1; transportGeneration &+= 1; currentAccount = nil
            media.invalidate(accountEpoch: accountGeneration, brokerEpoch: brokerEpoch)
            await host.cancelReads(); try await host.logout(); credentials = nil
            handleOwners.removeAll(); resolvedHandles.removeAll(); resolvedHandleOrder.removeAll(); followingComplete = false
            sourceRevisions.removeAll()
            groupRefreshPending.removeAll()
            media.invalidate(accountEpoch: accountGeneration, brokerEpoch: brokerEpoch)
            let result = snapshot(); continuation.yield(.session(result)); return try JSONEncoder().encode(result)
            }
        case .runtimeSnapshot: return try JSONEncoder().encode(host.currentRuntime)
        case .providerCapabilities:
            return try Self.encoded(["feedCursor":true,"listCursor":true,"followingCursor":true,"userPostsCursor":true,"promotedFlag":true,"unfollow":true,"follow":true,"unbookmark":true,"mute":false,"block":false])
        case .settings:
            let values = try object(await run(.getPreferences)); return try Self.encoded(values.keys.sorted().map { [$0,values[$0] as? String ?? ""] })
        case .setSetting:
            return try await run(.setPreferences, ["preferences": [args["key"] as? String ?? "": args["value"] as? String ?? ""]], owner: owner)
        case .setPreferencesBatch:
            let entries = args["entries"] as? [[String]] ?? []; var preferences: [String:String] = [:]
            for pair in entries { guard pair.count == 2, preferences[pair[0]] == nil else { throw AppServiceError(code: "invalid_preferences", message: L10n.text("importFailed")) }; preferences[pair[0]] = pair[1] }
            return try await run(.setPreferences, ["preferences":preferences,"portable":args["portable"] as? Bool ?? false], owner: owner)
        case .cachedFeed: return try await cachedFeed(args, owner: owner)
        case .cachedPosts:
            guard let ids=args["postIds"] as? [String],ids.count <= 80,
                  ids.allSatisfy({$0.range(of:"^[0-9]{1,25}$",options:.regularExpression) != nil}),
                  Set(ids).count == ids.count else {
                throw AppServiceError(code:"invalid_request",message:L10n.text("loadFailed"))
            }
            var posts:[[String:Any]]=[];var missing:[String]=[]
            for id in ids {
                try Task.checkCancellation()
                let row=try object(await run(.getPost,["postId":id],owner:owner))
                if row["id"] as? String == id {posts.append(row)}else{missing.append(id)}
            }
            let read=try JSONDecoder().decode([String].self,from:await run(.getReadIds,owner:owner))
            let retained=Set(posts.compactMap {$0["id"] as? String})
            return try Self.encoded(["posts":posts,"missingPostIds":missing,"readIds":read.filter {retained.contains($0)}])
        case .refreshFeed, .loadFeedPage: return try await liveFeed(args, owner: owner)
        case .userProfile: return try await profile(args["username"] as? String ?? "", owner: owner, refresh: args["refresh"] as? Bool ?? false)
        case .setRead: let result = try await run(.markRead,args,owner:owner);continuation.yield(.contentChanged);return result
        case .hidePost: let result = try await run(.setHidden,args,owner:owner);continuation.yield(.contentChanged);return result
        case .readIDs: return try await run(.getReadIds,args,owner:owner)
        case .postContent:
            let id = try required(args,"postId"); let body = try await provider("TweetResultByRestId",variables:["tweetId":id,"withCommunity":false,"includePromotedContent":false,"withVoice":false],owner:owner)
            return try await run(.parsePostContent,["postId":id,"body":body],owner:owner)
        case .bookmarkReplies:
            let id = try required(args,"postId"); var variables:[String:Any] = ["focalTweetId":id,"count":20,"referrer":"tweet","with_rux_injections":false,"includePromotedContent":false,"rankingMode":"Relevance","withCommunity":true,"withQuickPromoteEligibilityTweetFields":true,"withBirdwatchNotes":true,"withVoice":true]
            if let cursor=args["cursor"] as? String {variables["cursor"]=cursor}
            let body=try await provider("TweetDetail",variables:variables,owner:owner)
            return try await run(.parseReplies,["postId":id,"body":body,"first":args["cursor"] == nil],owner:owner)
        case .searchCachedPosts:
            let rows=try await run(.search,args,owner:owner);let posts=try JSONDecoder().decode([Post].self,from:rows)
            let next: Any = posts.count >= 60 ? (args["offset"] as? Int ?? 0) + posts.count : NSNull()
            let read=try JSONDecoder().decode([String].self,from:await run(.getReadIds,owner:owner))
            let pageIDs=Set(posts.map(\.id))
            return try Self.encoded(["posts":try JSONSerialization.jsonObject(with:rows),"readIds":read.filter {pageIDs.contains($0)},"nextOffset":next])
        case .followingSnapshot: return try await followingSnapshot()
        case .startFollowingSync: startFollowing();return try Self.encoded(true)
        case .pinnedAccounts: return try await run(.getPinnedAccounts,owner:owner)
        case .pinAccount:
            return try await run(.pinAccount,args,owner:owner)
        case .groups: return try await lists()
        case .createGroup,.updateGroup:
            let id=args["id"] as? String ?? args["groupId"] as? String ?? UUID().uuidString
            _=try await run(.upsertList,["id":id,"name":args["name"] as? String ?? "","color":args["color"] as? String ?? "#6366f1"],owner:owner)
            return try Self.encoded(["id":id,"name":args["name"] as? String ?? "","color":args["color"] as? String ?? "#6366f1","memberCount":0])
        case .deleteGroup: return try await run(.deleteList,["id":args["groupId"] ?? args["id"] ?? ""],owner:owner)
        case .groupMembers: return try Self.encoded(try await members(args))
        case .setGroupMember:
            return try await run(.setListMember,["listId":args["groupId"] ?? "","authorId":try required(args,"authorId"),"member":args["member"] as? Bool ?? true],owner:owner)
        case .groupCandidates: return try await run(.getGroupCandidates,args,owner:owner)
        case .groupFeed,.refreshGroupFeed: return try await groupFeed(args,refresh:request.operation == .refreshGroupFeed,owner:owner)
        case .filterPresets: return try await run(.getFilterPresets,owner:owner)
        case .setFilterPresets: return try await run(.setFilterPresets,args,owner:owner)
        case .resumeState:
            guard currentAccount != nil else { return Data("null".utf8) };return try await run(.getResumeState,args,owner:owner)
        case .setResumeState: return try await run(.setResumeState,args,owner:owner)
        case .mutedWords: return try await run(.getMutedWords,owner:owner)
        case .setMutedWord: return try await run(.setMutedWord,args,owner:owner)
        case .unfollowAllowed:
            let settings=try object(await run(.getPreferences));return try Self.encoded(settings["actions.allowUnfollow"] as? String != "false")
        case .relationship: return try Self.encoded(try await relationship(try required(args,"username"),owner:owner))
        case .follow,.unfollow,.removeBookmark: return try await mutate(request.operation,args:args,owner:owner)
        case .diagnosticsReport:
            let coreData=try object(await run(.diagnostics))
            let connection=try object(await host.checkedCall(command:"connectionDiagnostics"))
            let report:[String:Any] = ["version":"0.10.0","reader":"UIKit","core":coreData,"media":media.diagnosticSnapshot(),"connection":connection,"provider":"ios-direct","physicalAcceptance":"requires device test"]
            return try Self.encoded(String(data:Self.encoded(report),encoding:.utf8) ?? "")
        case .connectionMetrics: return try await host.checkedCall(command:"connectionMetrics")
        case .clearCache:
            // Session reset preserves durable data and credentials, then restores verified identity.
            sessionRevision &+= 1; restoring?.cancel(); restoring = nil; restoringRevision = nil
            let revision = sessionRevision
            try await sessionCommit { [self] in
                guard revision == sessionRevision else { throw CancellationError() }
                await host.cancelReads()
                _=try await run(.clearSession);accountGeneration &+= 1;currentAccount=nil;followingComplete=false
                media.invalidate(accountEpoch:accountGeneration,brokerEpoch:brokerEpoch)
                handleOwners.removeAll();resolvedHandles.removeAll();resolvedHandleOrder.removeAll();imageAttempts.removeAll()
                sourceRevisions.removeAll()
                groupRefreshPending.removeAll()
            }
            guard revision == sessionRevision else { throw CancellationError() }
            _=try await restoreSession(force:true);return Data("null".utf8)
        case .openExternal:
            return try await host.checkedCall(command:"openExternal",argumentsJSON:String(data:Self.encoded(args),encoding:.utf8)!)
        case .creatorSubscription:
            return try await host.checkedCall(command:"openProfile",argumentsJSON:String(data:Self.encoded(["username":try required(args,"username")]),encoding:.utf8)!)
        }
    }
    private func required(_ args:[String:Any],_ key:String)throws->String { guard let value=args[key] as? String,!value.isEmpty,value.count<=4096 else{throw AppServiceError(code:"invalid_request",message:L10n.text("loadFailed"))};return value }
    private func baseFeed(_ input:String)->String { ["focus","originals"].contains(input) ? "following" : input }
    private func cachedFeed(_ args:[String:Any],owner:UUID)async throws->Data {
        var input=args;input["feed"]=baseFeed(args["feed"] as? String ?? "following")
        let initial=try await run(.getFeed,input,owner:owner)
        let missing=try object(initial)["missingPostIds"] as? [String] ?? []
        guard !missing.isEmpty else{return initial}
        // Restore only the requested bounded viewport window. Detail ingestion
        // preserves the source cursor, complete bookmark index and read state.
        for id in missing.prefix(80) {
            try Task.checkCancellation()
            let body=try await provider("TweetResultByRestId",variables:["tweetId":id,"withCommunity":false,"includePromotedContent":false,"withVoice":false],owner:owner)
            _=try await run(.parsePostContent,["postId":id,"body":body],owner:owner)
        }
        return try await run(.getFeed,input,owner:owner)
    }
    private func profile(_ username:String,owner:UUID,refresh:Bool=false)async throws->Data {
        guard username.range(of:"^[A-Za-z0-9_]{1,15}$",options:.regularExpression) != nil else{throw AppServiceError(code:"invalid_handle",message:L10n.text("loadFailed"))}
        let key=username.lowercased()
        if !refresh {let cached=try await run(.getProfile,["username":username],owner:owner);if cached != Data("null".utf8){return cached}}
        if let job=profileJobs[key]{return try await job.value}
        let task=Task { @MainActor in let body=try await self.provider("UserByScreenName",variables:["screen_name":username,"withSafetyModeUserFields":true],owner:owner);return try await self.run(.ingestProfile,["body":body],owner:owner) }
        profileJobs[key]=task;defer{profileJobs.removeValue(forKey:key)};return try await task.value
    }
    private func liveFeed(_ args:[String:Any],owner:UUID)async throws->Data {
        let requested=args["feed"] as? String ?? "following";let feed=baseFeed(requested);let cursor=args["cursor"] as? String
        let key=feed+":"+(cursor ?? "first")
        if let job=feedJobs[key]{_ = try await job.value;return try await cachedFeed(args,owner:owner)}
        if cursor == nil {sourceRevision &+= 1;sourceRevisions[feed]=sourceRevision}
        let revision=sourceRevisions[feed] ?? 0
        let task=Task { @MainActor () throws -> Data in
            var variables:[String:Any] = ["count":30,"includePromotedContent":false,"withQuickPromoteEligibilityTweetFields":true,"withVoice":true,"withV2Timeline":true]
            if let cursor{variables["cursor"]=cursor}
            let operation:String
            if feed=="bookmarks"{operation="Bookmarks"}else if feed.hasPrefix("user-id:"){
                let id=String(feed.dropFirst(8))
                guard id.range(of:"^[0-9]{1,25}$",options:.regularExpression) != nil else {
                    throw AppServiceError(code:"invalid_request",message:L10n.text("loadFailed"))
                }
                variables["userId"]=id;operation="UserTweets"
            }else if feed.hasPrefix("user:"){
                let username=String(feed.dropFirst(5));let author=try JSONDecoder().decode(Author.self,from:await self.profile(username,owner:owner));variables["userId"]=author.id;operation="UserTweets"
            }else{operation="HomeLatestTimeline"}
            let body=try await self.provider(operation,variables:variables,owner:owner)
            guard self.sourceRevisions[feed] == revision else {throw CancellationError()}
            return try await self.run(.ingestFeed,["feed":feed,"body":body,"append":cursor != nil,"filters":args["filters"] ?? [:]],owner:owner,revision:revision)
        }
        feedJobs[key]=task;defer{feedJobs.removeValue(forKey:key)};return try await task.value
    }
    private func allFollowing()async throws->[[String:Any]] {
        var result:[[String:Any]]=[];var offset=0
        while true {let response=try object(await run(.getFollowing,["offset":offset,"limit":80]));let page=response["accounts"] as? [[String:Any]] ?? [];result+=page;offset+=page.count;if page.isEmpty || offset >= (response["total"] as? Int ?? offset){break}}
        return result
    }
    private func followingSnapshot()async throws->Data {try Self.encoded(["accounts":try await allFollowing(),"complete":followingComplete,"syncing":followingJob != nil,"state":followingJob != nil ? "loading" : followingError == nil ? "idle" : "failed","lastError":followingError.map { $0 as Any } ?? NSNull(),"lastProgressAt":NSNull()])}
    private func startFollowing() {
        guard followingJob==nil,currentAccount != nil else{return};followingError=nil
        followingJob=Task { @MainActor in
            defer{self.followingJob=nil;self.continuation.yield(.followingProgress)}
            do{
                guard let account=self.currentAccount else{return};let generation=self.accountGeneration;var cursor:String?;var seen=Set<String>();var offset=0
                repeat{
                    try Task.checkCancellation();guard generation==self.accountGeneration else{throw CancellationError()};var variables:[String:Any]=["userId":account.id,"count":60,"includePromotedContent":false];if let cursor{variables["cursor"]=cursor}
                    let body=try await self.provider("Following",variables:variables);let next=self.findBottomCursor(body)
                    guard generation==self.accountGeneration else{throw CancellationError()}
                    let response=try self.object(await self.run(.ingestFollowing,["body":body,"offset":offset,"syncId":String(self.accountGeneration),"complete":next==nil]))
                    offset += (response["accounts"] as? [Any])?.count ?? 0;self.continuation.yield(.followingProgress)
                    guard let next,!next.isEmpty,seen.insert(next).inserted else{self.followingComplete=true;break};cursor=next
                }while true
            }catch is CancellationError{}catch{self.followingError=error.localizedDescription}
        }
    }
    private func findBottomCursor(_ value:Any)->String? {
        if let object=value as? [String:Any]{if object["cursorType"] as? String == "Bottom"{return object["value"] as? String};for value in object.values{if let found=findBottomCursor(value){return found}}}
        if let array=value as? [Any]{for value in array{if let found=findBottomCursor(value){return found}}};return nil
    }
    private func rawLists()async throws->[[String:Any]] {try JSONSerialization.jsonObject(with:await run(.getLists)) as? [[String:Any]] ?? []}
    private func lists()async throws->Data {try Self.encoded(try await rawLists().map{["id":$0["id"] ?? "","name":$0["name"] ?? "","color":$0["color"] ?? "#6366f1","memberCount":($0["memberIds"] as? [String])?.count ?? 0]})}
    private func members(_ args:[String:Any])async throws->[String] {let id=args["groupId"] as? String ?? "";return try await rawLists().first{$0["id"] as? String==id}?["memberIds"] as? [String] ?? []}
    private func groupFeed(_ args:[String:Any],refresh:Bool,owner:UUID)async throws->Data {
        let id=try required(args,"groupId")
        let memberOffset=max(0,args["memberOffset"] as? Int ?? 0)
        let input:[String:Any]=["groupId":id,"filters":args["filters"] ?? [:],"offset":args["offset"] as? Int ?? 0,"limit":80,"memberPageOffset":memberOffset,"memberPageLimit":4]
        var response=try object(await run(.getGroupFeed,input,owner:owner))
        var failures:[[String:Any]]=[]
        if refresh {
            let pages=response["memberPages"] as? [[String:Any]] ?? []
            let restart=args["restart"] as? Bool ?? false
            if restart {groupRefreshPending[id]=Set(try await members(["groupId":id]))}
            for page in pages {
                try Task.checkCancellation()
                let authorID=page["authorId"] as? String ?? ""
                let first=groupRefreshPending[id]?.contains(authorID) == true
                guard let source=page["source"] as? String,first || page["exhausted"] as? Bool != true else{continue}
                var request:[String:Any]=["feed":source]
                if !first,let cursor=page["cursor"] as? String {request["cursor"]=cursor}
                do{_=try await liveFeed(request,owner:owner);groupRefreshPending[id]?.remove(authorID)}
                catch is CancellationError {throw CancellationError()}
                catch{failures.append(["username":page["username"] as? String ?? page["authorId"] as? String ?? "","code":"load_failed","message":error.localizedDescription])}
            }
            response=try object(await run(.getGroupFeed,input,owner:owner))
        }
        // Evicted bodies retain their ordered navigation slots. Rehydrate only
        // this bounded requested page, then read the same window again.
        let missing=response["missingPostIds"] as? [String] ?? []
        for post in missing.prefix(80) {
            try Task.checkCancellation()
            do {
                let body=try await provider("TweetResultByRestId",variables:["tweetId":post,"withCommunity":false,"includePromotedContent":false,"withVoice":false],owner:owner)
                _=try await run(.parsePostContent,["postId":post,"body":body],owner:owner)
            }catch is CancellationError {throw CancellationError()}
            catch{failures.append(["username":"","code":"load_failed","message":error.localizedDescription])}
        }
        if !missing.isEmpty {response=try object(await run(.getGroupFeed,input,owner:owner))}
        let hasMore=(response["providerHasMore"] as? Bool ?? false) || groupRefreshPending[id]?.isEmpty == false
        let nextMember: Int? = hasMore ? (refresh ? response["nextMemberPageOffset"] as? Int ?? 0 : memberOffset) : nil
        response["failures"]=failures
        response["nextMemberOffset"]=nextMember.map{$0 as Any} ?? NSNull();response["fromCache"] = !refresh
        return try Self.encoded(response)
    }
    private func relationship(_ username:String,owner:UUID)async throws->String {
        let body=try await provider("UserByScreenName",variables:["screen_name":username,"withSafetyModeUserFields":true],owner:owner)
        let raw=(body as? [String:Any])?["data"] as? [String:Any];let user=(raw?["user"] as? [String:Any])?["result"] as? [String:Any] ?? [:]
        let legacy=user["legacy"] as? [String:Any] ?? [:]
        let perspective=user["relationship_perspectives"] as? [String:Any] ?? [:]
        if perspective["follow_request_sent"] as? Bool == true || legacy["follow_request_sent"] as? Bool == true{return "pending"}
        if perspective["following"] as? Bool == true || legacy["following"] as? Bool == true || user["following"] as? Bool == true{return "following"}
        if perspective["following"] as? Bool == false || legacy["following"] as? Bool == false || user["following"] as? Bool == false{return "notFollowing"};return "unknown"
    }
    private func mutate(_ operation:AppOperation,args:[String:Any],owner:UUID)async throws->Data {
        let action=operation == .follow ? "follow" : operation == .unfollow ? "unfollow" : "unbookmark"
        let command=operation == .follow ? "Follow" : operation == .unfollow ? "Unfollow" : "DeleteBookmark"
        let variables:[String:Any]=operation == .removeBookmark ? ["tweet_id":try required(args,"postId")] : ["screen_name":try required(args,"username")]
        var input=args;input["operation"]=action
        let prepared=try object(await run(.prepareAction,input,owner:owner));let token=prepared["token"] as? String ?? ""
        do {
            try Task.checkCancellation()
            _=try await run(.beginAction,["token":token],owner:owner)
            _=try await provider(command,variables:variables,owner:owner)
            _=try await run(.finishAction,["token":token,"outcome":"succeeded"])
            continuation.yield(.contentChanged);continuation.yield(.followingProgress);return Data("null".utf8)
        }catch{
            // Cancellation belongs to the UI request, not to the mandatory
            // settlement of a dispatched mutation. An unstructured task does
            // not inherit its cancelled state and never replays the write.
            let settlement=Task { @MainActor [self] in
                _=try await run(.finishAction,["token":token,"outcome":"uncertain"])
            }
            _=try? await settlement.value
            if error is CancellationError {throw error}
            throw AppServiceError(code:"uncertain_action",message:L10n.text("uncertainAction"))
        }
    }
    func mediaURL(for handle:String)async throws->URL {
        let resolved: Data
        do { resolved = try await run(.getMediaUrl,["handle":handle]) }
        catch {
            guard let locator=handleOwners[handle] else { throw error }
            let replacement=try await renew(locator:locator,fresh:false)
            resolved=try await run(.getMediaUrl,["handle":replacement])
        }
        let data=try object(resolved);guard let string=data["url"] as? String,let url=URL(string:string)else{throw AppServiceError(code:"expired_media",message:L10n.text("loadFailed"))}
        if resolvedHandles[string] == nil {resolvedHandleOrder.append(string)}
        resolvedHandles[string]=handle
        if resolvedHandleOrder.count > 8192 {
            for old in resolvedHandleOrder.prefix(1024) {resolvedHandles.removeValue(forKey:old)}
            resolvedHandleOrder.removeFirst(1024)
        }
        return url
    }
    func imageData(url:String,maxPixelDimension:Int)async throws->Data {
        let source = try await mediaURL(for:url)
        do { return try await media.imageData(url:source.absoluteString,maxPixelDimension:maxPixelDimension) }
        catch is CancellationError { throw CancellationError() }
        catch {
            if let native=error as? NativeMediaFailure,case .brokerHTTP(let failure)=native,
               failure.origin == .upstreamHTTP,[401,429,451].contains(failure.status) {
                throw AppServiceError(code:failure.status == 429 ? "rate_limited" : "media_unavailable",
                    message:L10n.text(failure.status == 429 ? "rateLimited" : "loadFailed"))
            }
            guard host.currentRuntime.foreground else { throw error }
            let now = ProcessInfo.processInfo.systemUptime
            if let previous = imageAttempts[url], previous.epoch == recoveryEpoch || now - previous.time < 10 { throw error }
            imageAttempts[url] = (recoveryEpoch, now)
            if imageAttempts.count > 512 { imageAttempts = [url:(recoveryEpoch,now)] }
            let repaired = try await media.recover(url:source.absoluteString,automatic:true)
            return try await media.imageData(url:repaired.absoluteString,maxPixelDimension:maxPixelDimension)
        }
    }
    func prefetchImageData(url:String,maxPixelDimension:Int)async throws->Data {
        // Speculation can warm a registration and the image cache, but cannot
        // spend a recovery sequence or refresh provider metadata on failure.
        try Task.checkCancellation()
        let source=try await mediaURL(for:url)
        return try await media.imageData(url:source.absoluteString,maxPixelDimension:maxPixelDimension,priority:URLSessionTask.lowPriority)
    }
    func makePlayer(url:String,owner:UUID)async throws->AVPlayer {
        do {return try await media.makePlayer(url:mediaURL(for:url).absoluteString,owner:owner)}
        catch is CancellationError {throw CancellationError()}
        catch let error as AppServiceError {throw error}
        catch {throw AppServiceError(code:"media_unavailable",message:L10n.text("loadFailed"),retryable:true)}
    }
    func releasePlayer(owner:UUID){media.releasePlayer(owner:owner)}
    func recoverMediaHandle(_ handle:String)async throws->String {
        let source=try await mediaURL(for:handle)
        let repaired=try await media.recover(url:source.absoluteString,freshSource:true,automatic:false)
        guard let replacement=resolvedHandles[repaired.absoluteString] else {
            throw AppServiceError(code:"expired_media",message:L10n.text("loadFailed"))
        }
        return replacement
    }
    func presentMedia(_ request:MediaPresentation,from:UIViewController)async throws->MediaPresentationResult {
        var items:[[String:Any]]=[]
        for item in request.items {
            var value=try object(JSONEncoder().encode(item));value["url"]=try await mediaURL(for:item.url).absoluteString
            if let preview=item.previewUrl{value["previewUrl"]=try await mediaURL(for:preview).absoluteString}
            var variants: [[String:Any]] = []
            for variant in item.variants {
                var resolved = try object(JSONEncoder().encode(variant))
                resolved["url"] = try await mediaURL(for:variant.url).absoluteString
                variants.append(resolved)
            }
            value["variants"] = variants
            items.append(value)
        }
        let args:[String:Any]=["items":items,"index":request.index,"position":request.position,"playing":request.playing,"speed":request.speed,"muted":request.muted,"loop":request.loopPlayback,"locale":L10n.arabic ? "ar" : "en","retryLabel":L10n.text("retry"),"revision":accountGeneration]
        let data=try await host.checkedCall(command:"presentMedia",argumentsJSON:String(data:Self.encoded(args),encoding:.utf8)!)
        let value=try object(data)
        // The presenter returns its private source only to this trusted adapter.
        // Screens receive the opaque handle, never an internal transport URL.
        let selectedHandle=(value["source"] as? String).flatMap { resolvedHandles[$0] }
        return MediaPresentationResult(index:value["index"] as? Int ?? request.index,
            position:value["position"] as? Double ?? request.position,playing:value["playing"] as? Bool ?? false,
            speed:value["speed"] as? Double ?? request.speed,muted:value["muted"] as? Bool ?? request.muted,
            loopPlayback:value["loop"] as? Bool ?? request.loopPlayback,selectedHandle:selectedHandle)
    }
    private func repair(_ url:URL,fresh:Bool)async throws->URL {
        guard let handle=resolvedHandles[url.absoluteString],let locator=handleOwners[handle]else{throw AppServiceError(code:"expired_media",message:L10n.text("retry"))}
        do {_=try await run(.validateMediaUrl,["url":url.absoluteString])}
        catch is CancellationError {throw CancellationError()}
        catch {
            // A known private URL from a previous broker generation is only a
            // locator. Renew locally before probing; never request its old port.
            let next=try await renew(locator:locator,fresh:false)
            return try await mediaURL(for:next)
        }
        let probe = try object(await run(.probeMedia,["url":url.absoluteString]))
        let kind = probe["kind"] as? String ?? "unknown"
        let status = probe["httpStatus"] as? Int
        if kind == "upstream_http", [401,429,451].contains(status ?? 0) {
            throw AppServiceError(code:status == 429 ? "rate_limited" : "media_unavailable",message:L10n.text(status == 429 ? "rateLimited" : "loadFailed"))
        }
        if kind == "local_listener" {
            let restarted = try object(await run(.restartMedia))
            brokerEpoch = (restarted["epoch"] as? NSNumber)?.uint64Value ?? brokerEpoch + 1
            media.invalidate(accountEpoch:accountGeneration,brokerEpoch:brokerEpoch)
        }
        let next = try await renew(locator:locator,fresh:fresh || kind == "upstream_http" && [403,410].contains(status ?? 0))
        return try await mediaURL(for:next)
    }
    private func renew(locator:MediaLocator,fresh:Bool) async throws -> String {
        let updated: Data
        switch locator.owner {
        case .post(let post):
            if fresh {
                let body=try await provider("TweetResultByRestId",variables:["tweetId":post,"withCommunity":false,"includePromotedContent":false,"withVoice":false])
                updated=try await run(.parsePostContent,["postId":post,"body":body])
            } else { updated=try await run(.recoverMedia,["postId":post]) }
        case .author(let username): updated=try await run(.getProfile,["username":username])
        case .article(let post):
            let body=try await provider("TweetResultByRestId",variables:["tweetId":post,"withCommunity":false,"includePromotedContent":false,"withVoice":false])
            updated=try await run(.parsePostContent,["postId":post,"body":body])
        }
        let object = try self.object(updated)
        let isArticle: Bool
        if case .article = locator.owner {isArticle=true}else{isArticle=false}
        var value: Any = isArticle ? object : object["post"] as? [String:Any] ?? object
        for segment in locator.path {
            if let dictionary=value as? [String:Any],let next=dictionary[segment] { value=next }
            else if let array=value as? [Any],let index=Int(segment),array.indices.contains(index) { value=array[index] }
            else { throw AppServiceError(code:"expired_media",message:L10n.text("retry")) }
        }
        guard let next=value as? String,next.hasPrefix("ffmedia:") else{throw AppServiceError(code:"expired_media",message:L10n.text("retry"))}
        return next
    }
    func recoverMedia()async throws {
        continuation.yield(.recovery("reconnecting"))
        let health=try object(await run(.mediaHealth))
        if health["available"] as? Bool != true {let next=try object(await run(.restartMedia));brokerEpoch=(next["epoch"] as? NSNumber)?.uint64Value ?? brokerEpoch+1;media.invalidate(accountEpoch:accountGeneration,brokerEpoch:brokerEpoch)}
        host.recoverVisibleMedia()
        // A healthy local listener is not proof that a CDN asset decoded.
        // Visible cells own their loading/ready/error state after reconfiguration.
        continuation.yield(.mediaRecoveryOpportunity);continuation.yield(.recovery(""))
    }
    private func runtimeChanged(_ snapshot:NativeRuntimeSnapshot){continuation.yield(.runtimeChanged);if !snapshot.foreground{transportGeneration &+= 1}}
    private func scheduleRecovery() {
        // NativeMediaService has already debounced the shared foreground/path
        // opportunity for 750 ms. Do not add another delay in the adapter.
        recoveryTask?.cancel()
        recoveryTask=Task { [weak self] in
            guard !Task.isCancelled,let self,self.host.currentRuntime.foreground else{return}
            self.recoveryEpoch &+= 1
            do{try await self.recoverMedia()}
            catch is CancellationError{}
            catch{self.continuation.yield(.recovery("needsAttention"))}
        }
    }
}
