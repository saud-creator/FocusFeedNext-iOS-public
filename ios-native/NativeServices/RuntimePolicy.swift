import Foundation

struct NativeRuntimeSnapshot: Codable, Equatable {
    var foreground = true
    var active = true
    var online = false
    var pathRevision: UInt64 = 0
    var wifi = false
    var expensive = false
    var constrained = false
    var lowPower = false
    var thermal = "nominal"
    var reduceMotion = false
    var reduceTransparency = false
    var contentSizeScale = 1.0
    var memoryRevision: UInt64 = 0

    init() {}
    init(dictionary: [String: Any]) {
        foreground = dictionary["foreground"] as? Bool ?? true
        active = dictionary["active"] as? Bool ?? true
        online = dictionary["online"] as? Bool ?? false
        pathRevision = (dictionary["pathRevision"] as? NSNumber)?.uint64Value ?? 0
        wifi = dictionary["wifi"] as? Bool ?? false
        expensive = dictionary["expensive"] as? Bool ?? false
        constrained = dictionary["constrained"] as? Bool ?? false
        lowPower = dictionary["lowPower"] as? Bool ?? false
        thermal = dictionary["thermal"] as? String ?? "nominal"
        reduceMotion = dictionary["reduceMotion"] as? Bool ?? false
        reduceTransparency = dictionary["reduceTransparency"] as? Bool ?? false
        contentSizeScale = dictionary["contentSizeScale"] as? Double ?? 1
        memoryRevision = (dictionary["memoryRevision"] as? NSNumber)?.uint64Value ?? 0
    }
}

/// Monotonic active time: suspension and paused/offscreen media consume no budget.
struct ActiveTimeBudget {
    let limit: TimeInterval
    private(set) var elapsed: TimeInterval = 0
    private var lastTick: TimeInterval?
    init(limit: TimeInterval) { self.limit = max(0, limit) }
    mutating func update(now: TimeInterval, active: Bool) -> Bool {
        if let previous = lastTick { elapsed += max(0, now - previous) }
        lastTick = active ? now : nil
        return elapsed >= limit
    }
    mutating func progress(now: TimeInterval, active: Bool) {
        elapsed = 0; lastTick = active ? now : nil
    }
}

struct RecoveryAttemptBudget {
    private(set) var epoch: UInt64 = 0
    private(set) var attempts = 0
    private var lastAttempt: TimeInterval = -.infinity
    mutating func claim(epoch: UInt64, now: TimeInterval, manual: Bool, cooldown: TimeInterval = 10) -> Bool {
        if epoch != self.epoch { self.epoch = epoch; attempts = 0 }
        // Explicit Retry is a new bounded sequence; coalescing still prevents
        // duplicate concurrent work. Cooldown applies to automatic recovery.
        guard manual || now - lastAttempt >= cooldown, manual || attempts == 0 else { return false }
        attempts += 1; lastAttempt = now; return true
    }
}

struct MediaOwnership: Equatable, Hashable {
    let accountEpoch: UInt64
    let brokerEpoch: UInt64
}
