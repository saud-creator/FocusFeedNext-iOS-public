import Foundation

enum NativePreloadKind: CaseIterable, Hashable { case bookmarks, following }

struct NativeMaintenanceSettings: Equatable {
    var autoCheck = true
    var interval: TimeInterval = 300
    var bookmarks = true
    var following = true
    init(values: [String:String] = [:]) {
        autoCheck = values["monitoring.autoCheck"] != "false"
        let minutes = Int(values["monitoring.intervalMinutes"] ?? "5") ?? 5
        interval = Double(min(60,max(1,minutes))) * 60
        bookmarks = values["startup.preloadBookmarks"] != "false"
        following = values["startup.preloadFollowing"] != "false"
    }
    func enabled(_ kind: NativePreloadKind) -> Bool { kind == .bookmarks ? bookmarks : following }
}

/// All times are monotonic. Real successful reads postpone a redundant probe;
/// failures are checked again only at the configured interval, never in a loop.
struct NativeMaintenancePolicy {
    var settings = NativeMaintenanceSettings()
    var foreground = false
    var ready = false
    var busy = false
    private(set) var generation: UInt64 = 0
    private var lastEvidence: TimeInterval = 0
    private var lastProbe: TimeInterval = 0
    var eligible: Bool { foreground && ready && !busy }
    mutating func configure(generation: UInt64, now: TimeInterval) -> Bool {
        guard generation != self.generation else { return false }
        self.generation = generation; lastEvidence = now; lastProbe = now; return true
    }
    mutating func success(now: TimeInterval) { lastEvidence = now }
    mutating func beganProbe(now: TimeInterval) { lastProbe = now }
    func delay(now: TimeInterval) -> TimeInterval? {
        guard eligible && settings.autoCheck else { return nil }
        return max(0,max(lastEvidence,lastProbe) + settings.interval - now)
    }
}

enum NativeCursorError: Error { case repeatedCursor, noProgress }
struct NativeCursorProgress {
    private var anchor: String?
    private var power = 1
    private var length = 0
    private var stagnant = 0
    /// Brent's cycle detector retains one cursor and detects cycles of any
    /// length without an ever-growing cursor set or an item-count ceiling.
    /// Existing cached totals cannot establish whether this page made progress.
    mutating func accept(next: String?, pageItems: Int) throws -> Bool {
        guard let next, !next.isEmpty else { return true }
        guard next != anchor else { throw NativeCursorError.repeatedCursor }
        if anchor == nil { anchor = next }
        else {
            length += 1
            if length == power { anchor = next; power = power <= Int.max / 2 ? power * 2 : Int.max; length = 0 }
        }
        if pageItems == 0 { stagnant += 1 } else { stagnant = 0 }
        guard stagnant < 3 else { throw NativeCursorError.noProgress }
        return false
    }
}

/// One health timer and one page-at-a-time preload worker. No idle polling and
/// no independent reconnect/login loop. Foreground activity cancels its work;
/// committed cursor checkpoints belong to the adapter and resume afterward.
@MainActor final class NativeMaintenanceScheduler {
    private(set) var policy = NativeMaintenancePolicy()
    private let check: (UInt64) async throws -> Void
    private let page: (NativePreloadKind, UInt64) async throws -> Bool
    private let failed: (NativePreloadKind, Error) -> Void
    private let changed: () -> Void
    private let now: () -> TimeInterval
    private var timer: Task<Void,Never>?
    private var timerID: UUID?
    private var worker: Task<Void,Never>?
    private var workerID: UUID?
    private var completed = Set<NativePreloadKind>()
    private var manual = Set<NativePreloadKind>()
    private(set) var activePreload: NativePreloadKind?
    private var nextKind: NativePreloadKind = .bookmarks
    private var activeProbeID: UUID?
    private let startupDelay: TimeInterval
    init(check: @escaping (UInt64) async throws -> Void,
         page: @escaping (NativePreloadKind, UInt64) async throws -> Bool,
         failed: @escaping (NativePreloadKind, Error) -> Void,
         changed: @escaping () -> Void = {},
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }, startupDelay: TimeInterval = 2) {
        self.check = check; self.page = page; self.failed = failed; self.changed = changed; self.now = now; self.startupDelay = max(0,startupDelay)
    }
    func configure(settings: NativeMaintenanceSettings, generation: UInt64, foreground: Bool, ready: Bool, busy: Bool) {
        let changed = policy.configure(generation:generation,now:now())
        let settingsChanged = policy.settings != settings
        policy.settings = settings; policy.foreground = foreground; policy.ready = ready; policy.busy = busy
        if changed { completed.removeAll(); manual.removeAll(); nextKind = .bookmarks }
        if changed || settingsChanged || !policy.eligible { cancelOwnedWork() }
        if changed || settingsChanged { self.changed() }
        reconcile()
    }
    func recordSuccess() { policy.success(now:now()); if activeProbeID == nil { cancelTimer() }; reconcile() }
    func request(_ kind: NativePreloadKind) {
        completed.remove(kind); manual.insert(kind)
        changed()
        // Do not cancel a different feature's page just to change selection.
        reconcile()
    }
    func pending(_ kind: NativePreloadKind) -> Bool { policy.ready && !completed.contains(kind) && (manual.contains(kind) || policy.settings.enabled(kind)) }
    private func reconcile() {
        guard policy.eligible else { return }
        armTimer()
        guard worker == nil, NativePreloadKind.allCases.contains(where:pending) else { return }
        let id = UUID(); workerID = id
        let generation = policy.generation
        worker = Task { @MainActor in
            defer { if self.workerID == id { self.worker = nil; self.workerID = nil; self.activePreload = nil; self.changed() } }
            // Let initial viewport work claim provider capacity first.
            do { try await Task.sleep(nanoseconds:UInt64(self.startupDelay * 1_000_000_000)) } catch { return }
            while !Task.isCancelled, self.policy.eligible, self.policy.generation == generation, self.workerID == id {
                let order: [NativePreloadKind] = self.nextKind == .bookmarks ? [.bookmarks,.following] : [.following,.bookmarks]
                guard let kind = order.first(where:self.pending) else { return }
                self.activePreload = kind
                do {
                    let complete = try await self.page(kind,generation)
                    try Task.checkCancellation()
                    guard self.workerID == id, generation == self.policy.generation else { return }
                    if complete { self.completed.insert(kind); self.manual.remove(kind) }
                } catch is CancellationError { return }
                catch {
                    guard self.workerID == id, generation == self.policy.generation else { return }
                    self.completed.insert(kind); self.manual.remove(kind); self.failed(kind,error)
                }
                self.activePreload = nil; self.nextKind = kind == .bookmarks ? .following : .bookmarks
                self.changed()
                await Task.yield()
            }
        }
    }
    private func armTimer() {
        guard timer == nil, let delay = policy.delay(now:now()) else { return }
        let id = UUID(); timerID = id; let generation = policy.generation
        timer = Task { @MainActor in
            defer {
                if self.timerID == id { self.timer = nil; self.timerID = nil; self.reconcile() }
            }
            do { try await Task.sleep(nanoseconds:UInt64(max(0.001,delay) * 1_000_000_000)) } catch { return }
            guard !Task.isCancelled, self.policy.eligible, self.policy.generation == generation else { return }
            // Fresh user traffic may have postponed this timer.
            guard self.policy.delay(now:self.now()) == 0 else { return }
            self.policy.beganProbe(now:self.now())
            self.activeProbeID = id
            defer { if self.activeProbeID == id { self.activeProbeID = nil } }
            do { try await self.check(generation) } catch { /* Adapter publishes a truthful settled status. */ }
        }
    }
    private func cancelTimer() { timer?.cancel(); timer = nil; timerID = nil }
    private func cancelOwnedWork() {
        cancelTimer(); worker?.cancel(); worker = nil; workerID = nil; activePreload = nil
    }
    func stop() { policy.ready = false; cancelOwnedWork() }
}
