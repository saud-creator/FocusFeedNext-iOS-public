import AVFoundation
import Foundation
import ImageIO
import UIKit

enum NativeMediaFailure: Error, Equatable {
    case invalidHandle, staleOwnership, unavailable, network, stalled, http(Int), recoveryExhausted, tooLarge
    case brokerHTTP(NativeMediaHTTPFailure), interruptedBody(Int?), decoder
}

/// The broker validates account ownership and every upstream redirect. This service
/// accepts only broker URLs and never receives credentials or a raw CDN URL.
@MainActor final class NativeMediaService {
    private let validateBrokerURL: (URL) async throws -> Void
    private let repair: (URL, Bool) async throws -> URL
    private var ownership = MediaOwnership(accountEpoch: 0, brokerEpoch: 0)
    private var cache: [String: CachedImage] = [:]
    private var order: [String] = []
    private var cacheCost = 0
    private let cacheLimit = 32 * 1024 * 1024
    private var downloads: [UUID: BoundedBrokerImageDownload] = [:]
    private var imageDeadlines: [UUID: NativeActiveDeadline<Data>] = [:]
    private var recoveries: [String: Task<URL, Error>] = [:]
    private var recoveryDeadlines: [String: NativeActiveDeadline<URL>] = [:]
    private let recoveryDebouncer = NativeRecoveryDebouncer()
    private var budgets: [String: RecoveryAttemptBudget] = [:]
    private var recoveryEpoch: UInt64 = 1
    private var runtime = NativeRuntimeSnapshot()
    private var current: (owner: UUID, source: URL, player: AVPlayer)?
    private var statusObserver: NSKeyValueObservation?
    private var timeControlObserver: NSKeyValueObservation?
    private var rateObserver: NSKeyValueObservation?
    private var muteObserver: NSKeyValueObservation?
    private var audioActive = false
    private var audioObservers: [NSObjectProtocol] = []
    private var stallTimer: Timer?
    private var stallBudget = ActiveTimeBudget(limit: 20)
    private var lastProgress = 0.0
    private var lastPlaybackRate: Float = 1
    private var playerRecovery: Task<Void, Never>?
    private var playerRecoveryID: UUID?
    private var pauseRevision: UInt64 = 0
    private var failureHandlers: [UUID: (NativeMediaFailure) -> Void] = [:]
    var playerFailed: ((UUID, NativeMediaFailure) -> Void)?
    var recoveryOpportunity: (() -> Void)?
    var ownershipInvalidated: (() -> Void)?
    var diagnosticEvent: ((String, String, Int?) -> Void)?

    init(validateBrokerURL: @escaping (URL) async throws -> Void,
         repair: @escaping (URL, Bool) async throws -> URL) {
        self.validateBrokerURL = validateBrokerURL; self.repair = repair
        let center = NotificationCenter.default
        audioObservers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.pauseAll() }
        })
        audioObservers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            Task { @MainActor in self?.pauseAll() }
        })
        audioObservers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self = self, let owner = self.current?.owner else { return }
                self.audioActive = false
                self.pauseAll()
                self.playerFailed?(owner, .unavailable); self.failureHandlers[owner]?(.unavailable)
            }
        })
    }

    func imageData(url: String, maxPixelDimension: Int = 1600) async throws -> Data {
        do { return try await loadImage(url: url, maxPixelDimension: maxPixelDimension) }
        catch {
            recordFailure(error)
            throw error
        }
    }

    private func loadImage(url: String, maxPixelDimension: Int) async throws -> Data {
        let source = try Self.brokerURL(url)
        let captured = ownership
        try await validateBrokerURL(source)
        guard captured == ownership else { throw NativeMediaFailure.staleOwnership }
        // A single 4096-square decode would already exceed the cache budget.
        // Keep the existing full-screen photo ceiling and scale for display.
        let dimension = min(2048, max(64, maxPixelDimension))
        let key = "\(captured.accountEpoch):\(captured.brokerEpoch):\(dimension):\(source.absoluteString)"
        if let cached = cache[key] { touch(key); return cached.data }
        let id = UUID()
        let download = BoundedBrokerImageDownload(url: source, maximumBytes: 16 * 1024 * 1024)
        let deadline = NativeActiveDeadline<Data>(seconds: 35, active: runtime.foreground)
        downloads[id] = download
        imageDeadlines[id] = deadline
        defer { downloads.removeValue(forKey: id); imageDeadlines.removeValue(forKey: id) }
        let bytes = try await deadline.run {
            try await withTaskCancellationHandler(operation: {
                try Task.checkCancellation()
                return try await download.run()
            }, onCancel: { download.cancel() })
        }
        try Task.checkCancellation()
        let decoded = try await Task.detached(priority: .userInitiated) { try Self.downsample(bytes, maximum: dimension) }.value
        try Task.checkCancellation()
        guard captured == ownership else { throw NativeMediaFailure.staleOwnership }
        insert(decoded, key: key)
        return decoded.data
    }

    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer {
        let source = try Self.brokerURL(url)
        let captured = ownership
        try await validateBrokerURL(source)
        try Task.checkCancellation()
        guard captured == ownership else { throw NativeMediaFailure.staleOwnership }
        stopPlayer()
        let player = AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: source)))
        player.automaticallyWaitsToMinimizeStalling = true
        current = (owner, source, player)
        observe(player, owner: owner)
        return player
    }

    func releasePlayer(owner: UUID) { failureHandlers.removeValue(forKey: owner); if current?.owner == owner { stopPlayer() } }
    func setFailureHandler(owner: UUID, handler: @escaping (NativeMediaFailure) -> Void) { failureHandlers[owner] = handler }
    func pauseAll() { pauseRevision &+= 1; current?.player.pause(); deactivateAudio() }

    func updateRuntime(_ next: NativeRuntimeSnapshot) {
        let opportunity = (!runtime.foreground && next.foreground) ||
            (next.online && (!runtime.online || runtime.pathRevision != next.pathRevision))
        let memoryChanged = next.memoryRevision != runtime.memoryRevision
        runtime = next
        recoveryDeadlines.values.forEach { $0.setActive(next.foreground) }
        imageDeadlines.values.forEach { $0.setActive(next.foreground) }
        if !next.foreground {
            recoveryDebouncer.cancel()
            pauseAll()
            downloads.values.forEach { $0.cancel() }
            _ = stallBudget.update(now: ProcessInfo.processInfo.systemUptime, active: false)
        }
        if memoryChanged { clearImageCache() }
        armStallWatchdog()
        if opportunity {
            recoveryDebouncer.submit { [weak self] in
                guard let self = self, self.runtime.foreground else { return }
                self.recoveryEpoch &+= 1; self.recoveryOpportunity?()
            }
        }
    }

    /// Account/proxy changes are hard ownership boundaries, not automatic retries.
    func invalidate(accountEpoch: UInt64, brokerEpoch: UInt64) {
        let next = MediaOwnership(accountEpoch: accountEpoch, brokerEpoch: brokerEpoch)
        guard next != ownership else { return }
        ownership = next; recoveryEpoch &+= 1
        // Give the presenter a chance to capture its playhead before the
        // account/proxy boundary releases the old player item.
        ownershipInvalidated?()
        downloads.values.forEach { $0.cancel() }; downloads.removeAll()
        imageDeadlines.values.forEach { $0.cancel() }; imageDeadlines.removeAll()
        recoveries.values.forEach { $0.cancel() }; recoveries.removeAll(); budgets.removeAll()
        recoveryDeadlines.values.forEach { $0.cancel() }; recoveryDeadlines.removeAll(); recoveryDebouncer.cancel()
        stopPlayer(); clearImageCache()
        failureHandlers.removeAll()
    }

    func recover(url: String, freshSource: Bool = false, automatic: Bool = false) async throws -> URL {
        let source = try Self.brokerURL(url)
        let captured = ownership
        let key = "\(captured.accountEpoch):\(captured.brokerEpoch):\(source.absoluteString)"
        if let task = recoveries[key] { return try await task.value }
        var budget = budgets[key] ?? RecoveryAttemptBudget()
        guard budget.claim(epoch: recoveryEpoch, now: ProcessInfo.processInfo.systemUptime, manual: !automatic) else {
            diagnosticEvent?("failure", "recovery_exhausted", nil)
            throw NativeMediaFailure.recoveryExhausted
        }
        diagnosticEvent?("recovery", "media", nil)
        budgets[key] = budget
        // Bound bookkeeping independently of a long scrolling session.
        if budgets.count > 512 { budgets = [key: budget] }
        let deadline = NativeActiveDeadline<URL>(seconds: 30, active: runtime.foreground)
        recoveryDeadlines[key] = deadline
        let task = Task { @MainActor in
          try await deadline.run {
            try Task.checkCancellation()
            let result = try await self.repair(source, freshSource)
            _ = try Self.brokerURL(result.absoluteString)
            try await self.validateBrokerURL(result)
            try Task.checkCancellation()
            guard captured == self.ownership else { throw NativeMediaFailure.staleOwnership }
            return result
          }
        }
        recoveries[key] = task
        defer { recoveries.removeValue(forKey: key); recoveryDeadlines.removeValue(forKey: key) }
        let result = try await task.value
        // An unchanged registration must be fetched afresh after a transient failure.
        clearImageCache()
        return result
    }

    private func observe(_ player: AVPlayer, owner: UUID) {
        statusObserver = player.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in self?.recoverPlayer(owner: owner, failure: .unavailable) }
        }
        timeControlObserver = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor in self?.armStallWatchdog(); self?.updateAudio() }
        }
        rateObserver = player.observe(\.rate, options: [.initial, .new]) { [weak self] player, _ in
            Task { @MainActor in
                if player.rate > 0 { self?.lastPlaybackRate = player.rate }
                self?.updateAudio()
            }
        }
        muteObserver = player.observe(\.isMuted, options: [.initial, .new]) { [weak self] _, _ in Task { @MainActor in self?.updateAudio() } }
    }
    private func updateAudio() {
        guard runtime.foreground, let player = current?.player, !player.isMuted,
              player.rate > 0 || player.timeControlStatus == .waitingToPlayAtSpecifiedRate else { deactivateAudio(); return }
        guard !audioActive else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback)
            try session.setActive(true); audioActive = true
        } catch { current?.player.pause() }
    }
    private func deactivateAudio() {
        guard audioActive else { return }; audioActive = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func armStallWatchdog() {
        stallTimer?.invalidate(); stallTimer = nil
        let now = ProcessInfo.processInfo.systemUptime
        guard let active = current else { stallBudget.progress(now: now, active: false); return }
        guard runtime.foreground else { _ = stallBudget.update(now: now, active: false); return }
        guard active.player.timeControlStatus == .waitingToPlayAtSpecifiedRate else {
            if active.player.timeControlStatus == .playing { stallBudget.progress(now: now, active: false) }
            else { _ = stallBudget.update(now: now, active: false) }
            return
        }
        _ = stallBudget.update(now: now, active: true)
        // Playback-time observers stop firing during a stall; use an active-only clock.
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, let current = self.current, current.owner == active.owner else { return }
            let seconds = current.player.currentTime().seconds
            let now = ProcessInfo.processInfo.systemUptime
            if seconds.isFinite && abs(seconds - self.lastProgress) > 0.05 {
                self.stallBudget.progress(now: now, active: true); self.lastProgress = seconds
            } else if self.stallBudget.update(now: now, active: true) {
                self.stallTimer?.invalidate(); self.stallTimer = nil
                self.recoverPlayer(owner: current.owner, failure: .stalled)
            }
        }
        stallTimer = timer; RunLoop.main.add(timer, forMode: .common)
    }

    private func recoverPlayer(owner: UUID, failure: NativeMediaFailure) {
        guard playerRecovery == nil, let active = current, active.owner == owner, runtime.foreground else { return }
        let position = active.player.currentTime().seconds
        let speed = active.player.rate > 0 ? active.player.rate : lastPlaybackRate
        let muted = active.player.isMuted
        let intent = active.player.rate > 0 || active.player.timeControlStatus == .waitingToPlayAtSpecifiedRate
        let captured = ownership
        let pause = pauseRevision
        let recoveryID = UUID(); playerRecoveryID = recoveryID
        playerRecovery = Task { @MainActor in
            defer { if self.playerRecoveryID == recoveryID { self.playerRecovery = nil; self.playerRecoveryID = nil } }
            do {
                let repaired = try await self.recover(url: active.source.absoluteString, automatic: true)
                guard self.current?.owner == owner, self.ownership == captured else { return }
                try await self.validateBrokerURL(repaired)
                guard self.current?.owner == owner, self.ownership == captured else { return }
                let player = active.player
                self.statusObserver = nil; self.timeControlObserver = nil; self.rateObserver = nil; self.muteObserver = nil
                self.stallTimer?.invalidate(); self.stallTimer = nil
                self.current = (owner, repaired, player)
                player.replaceCurrentItem(with: AVPlayerItem(asset: AVURLAsset(url: repaired)))
                self.stallBudget = ActiveTimeBudget(limit: 20)
                self.observe(player, owner: owner)
                player.isMuted = muted
                if position.isFinite && position > 0 {
                    await player.seek(to: CMTime(seconds: position, preferredTimescale: 600))
                }
                guard self.current?.owner == owner, self.ownership == captured else { return }
                if intent && self.runtime.foreground && pause == self.pauseRevision { player.playImmediately(atRate: speed > 0 ? speed : 1) }
            } catch {
                guard self.current?.owner == owner else { return }
                self.current?.player.pause(); self.playerFailed?(owner, failure); self.failureHandlers[owner]?(failure)
            }
        }
    }

    private func stopPlayer() {
        playerRecovery?.cancel(); playerRecovery = nil; playerRecoveryID = nil
        statusObserver = nil; timeControlObserver = nil; rateObserver = nil; muteObserver = nil
        stallTimer?.invalidate(); stallTimer = nil
        current?.player.pause(); current?.player.replaceCurrentItem(with: nil); current = nil
        deactivateAudio()
        stallBudget = ActiveTimeBudget(limit: 20); lastProgress = 0; lastPlaybackRate = 1
    }

    nonisolated static func brokerURL(_ raw: String) throws -> URL {
        guard let url = URL(string: raw), url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw NativeMediaFailure.invalidHandle }
        let parts = url.path.split(separator: "/")
        guard parts.count == 3, parts[0] == "media", parts[1].count == 48, parts[2].count == 32,
              parts.dropFirst().allSatisfy({ $0.allSatisfy(\.isHexDigit) }) else { throw NativeMediaFailure.invalidHandle }
        return url
    }

    private struct CachedImage { let data: Data; let cost: Int }
    nonisolated private static func downsample(_ data: Data, maximum: Int) throws -> CachedImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximum, kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary), let encoded = UIImage(cgImage: image).pngData() else { throw NativeMediaFailure.decoder }
        return CachedImage(data: encoded, cost: image.bytesPerRow * image.height + encoded.count)
    }
    private func touch(_ key: String) { order.removeAll { $0 == key }; order.append(key) }
    private func insert(_ value: CachedImage, key: String) {
        guard value.cost <= cacheLimit else { return }
        if let previous = cache.removeValue(forKey: key) { cacheCost -= previous.cost }
        order.removeAll { $0 == key }
        while cacheCost + value.cost > cacheLimit, let oldest = order.first {
            order.removeFirst(); if let previous = cache.removeValue(forKey: oldest) { cacheCost -= previous.cost }
        }
        cache[key] = value; order.append(key); cacheCost += value.cost
    }
    private func clearImageCache() { cache.removeAll(); order.removeAll(); cacheCost = 0 }
    private func recordFailure(_ error: Error) {
        if error is CancellationError { return }
        let code: String
        var status: Int? = nil
        switch error {
        case NativeMediaFailure.brokerHTTP(let failure): code = failure.origin.rawValue; status = failure.status
        case NativeMediaFailure.interruptedBody(let responseStatus): code = "interrupted_body"; status = responseStatus
        case NativeMediaFailure.decoder: code = "decoder_failure"
        case NativeMediaFailure.invalidHandle: code = "invalid_handle"
        case NativeMediaFailure.staleOwnership: code = "stale_ownership"
        case NativeMediaFailure.tooLarge: code = "media_size_limit"
        case NativeMediaFailure.network: code = "network_failure"
        case NativeRecoveryError.timeout: code = "timeout"
        default: code = "unknown_media_failure"
        }
        diagnosticEvent?("failure", code, status)
    }
    func diagnosticSnapshot() -> [String: Any] {
        ["accountEpoch": ownership.accountEpoch, "brokerEpoch": ownership.brokerEpoch,
         "imageCacheCostBytes": cacheCost, "imageCacheBudgetBytes": cacheLimit,
         "decodedImages": cache.count, "imageRequests": downloads.count,
         "pendingRecoveries": recoveries.count, "activePlayers": current == nil ? 0 : 1,
         "recoveryEpoch": recoveryEpoch, "processMemory": NativeProcessMemory.snapshot()]
    }
    deinit { audioObservers.forEach(NotificationCenter.default.removeObserver) }
}

/// Header and incremental body limits apply before allocating the complete image.
private final class BoundedBrokerImageDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let url: URL
    private let maximumBytes: Int
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var data = Data()
    private var cancelled = false
    private var responseStatus: Int?
    init(url: URL, maximumBytes: Int) { self.url = url; self.maximumBytes = maximumBytes }
    func run() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if cancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
            self.continuation = continuation
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = 35; config.timeoutIntervalForResource = 35
            config.httpMaximumConnectionsPerHost = 4
            let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
            self.session = session
            let task = session.dataTask(with: url); self.task = task
            lock.unlock(); task.resume()
        }
    }
    func cancel() { lock.lock(); cancelled = true; lock.unlock(); finish(.failure(CancellationError())) }
    private func finish(_ result: Result<Data, Error>) {
        lock.lock(); let continuation = self.continuation; self.continuation = nil
        let session = self.session; self.session = nil; self.task = nil
        lock.unlock()
        session?.invalidateAndCancel(); continuation?.resume(with: result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let failure = NativeMediaHTTPFailure(status:http?.statusCode ?? 0,
                brokerOrigin:http?.value(forHTTPHeaderField:"x-focusfeed-failure-origin"),
                trustedResponse:response.url == url)
            completionHandler(.cancel); finish(.failure(NativeMediaFailure.brokerHTTP(failure))); return
        }
        lock.lock(); responseStatus = http.statusCode; lock.unlock()
        guard response.expectedContentLength <= Int64(maximumBytes) else { completionHandler(.cancel); finish(.failure(NativeMediaFailure.tooLarge)); return }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let exceeds = self.data.count > maximumBytes - data.count
        if !exceeds { self.data.append(data) }
        lock.unlock()
        if exceeds { finish(.failure(NativeMediaFailure.tooLarge)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let result = data; let status = responseStatus; let wasCancelled = cancelled; lock.unlock()
        if let error {
            if wasCancelled || (error as NSError).code == NSURLErrorCancelled { finish(.failure(CancellationError())) }
            else if let status { finish(.failure(NativeMediaFailure.interruptedBody(status))) }
            else { finish(.failure(NativeMediaFailure.network)) }
        } else { finish(.success(result)) }
    }
}
