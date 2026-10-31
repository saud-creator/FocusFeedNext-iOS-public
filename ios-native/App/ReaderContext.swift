import UIKit

extension Notification.Name {
    static let readerContextChanged = Notification.Name("ReaderContextChanged")
    static let readerContentChanged = Notification.Name("ReaderContentChanged")
    static let readerMediaRecoveryOpportunity = Notification.Name("ReaderMediaRecoveryOpportunity")
    static let readerFollowingChanged = Notification.Name("ReaderFollowingChanged")
}

@MainActor final class ReaderContext {
    let services: AppServices
    var session: SessionSnapshot?
    var capabilities: ProviderCapabilities?
    var runtime: ReaderRuntimeSnapshot?
    var preferences = ReaderPreferences()
    var recovery = ""
    private var playbackStates: [String: ReaderPlaybackState] = [:]
    lazy var timelines = TimelineRepository(context: self)
    private var eventsTask: Task<Void, Never>?
    init(services: AppServices) { self.services = services }
    func start() async throws {
        let entries = try await services.settings()
        preferences = ReaderPreferences(entries: entries)
        L10n.language = preferences.string("language")
        session = try await services.session()
        runtime = try? await services.call(.runtimeSnapshot)
        if session?.hasCredentials == true { capabilities = try? await services.call(.providerCapabilities) }
        eventsTask?.cancel()
        eventsTask = Task { [weak self] in
            guard let self else { return }
            for await event in services.events {
                if Task.isCancelled { return }
                switch event {
                case .session(let snapshot):
                    let generation = services.accountGeneration
                    let nextCapabilities: ProviderCapabilities? = snapshot.hasCredentials ? (try? await services.call(.providerCapabilities)) : nil
                    guard generation == services.accountGeneration else { continue }
                    session = snapshot; capabilities = nextCapabilities; changed()
                case .contentChanged: NotificationCenter.default.post(name: .readerContentChanged, object: self)
                case .mediaRecoveryOpportunity: NotificationCenter.default.post(name: .readerMediaRecoveryOpportunity, object: self)
                case .followingProgress: NotificationCenter.default.post(name: .readerFollowingChanged, object: self)
                case .recovery(let state): recovery = state; changed()
                case .runtimeChanged: runtime = try? await services.call(.runtimeSnapshot); changed()
                }
            }
        }
    }
    func accept(_ snapshot: SessionSnapshot) async {
        session = snapshot
        capabilities = try? await services.call(.providerCapabilities)
        changed()
    }
    func changed() { NotificationCenter.default.post(name: .readerContextChanged, object: self) }
    func isPaused(_ key: String) -> Bool { playbackStates[key]?.paused == true }
    func position(_ key: String) -> Double { playbackStates[key]?.position ?? 0 }
    func playbackState(_ key: String) -> ReaderPlaybackState? { playbackStates[key] }
    func rememberMedia(_ key: String, paused: Bool? = nil, position: Double? = nil, speed: Double? = nil, muted: Bool? = nil, loopPlayback: Bool? = nil, selectedHandle: String? = nil) {
        var state = playbackStates[key] ?? ReaderPlaybackState()
        if let paused { state.paused = paused }
        if let position, position.isFinite, position >= 0 { state.position = position }
        if let speed, speed.isFinite, (0.25...4).contains(speed) { state.speed = speed }
        if let muted { state.muted = muted }
        if let loopPlayback { state.loopPlayback = loopPlayback }
        if let selectedHandle, selectedHandle.hasPrefix("ffmedia:") { state.selectedHandle = selectedHandle }
        playbackStates[key] = state
        if playbackStates.count > 512 { playbackStates = [key: state] }
    }
    var allowsAutoplay: Bool {
        guard let runtime, runtime.foreground, !runtime.lowPower, !runtime.constrained, !runtime.reduceMotion, !["serious", "critical"].contains(runtime.thermal), preferences.string("performance.mode") != "battery" else { return false }
        return preferences.string("video.autoplay") == "any" || preferences.string("video.autoplay") == "wifi" && runtime.wifi && !runtime.expensive
    }
    func save(_ draft: ReaderPreferences, portable: Bool = false) async throws {
        try await services.saveSettings(draft.entries, portable: portable)
        preferences = draft; L10n.language = draft.string("language"); changed()
    }
    deinit { eventsTask?.cancel() }
}

struct ReaderPreferences {
    static let defaults: [String: String] = [
        "performance.mode":"balanced", "reading.size":"100", "appearance.haptics":"true", "video.autoplay":"wifi", "navigation.tabs":"[\"following\",\"focus\",\"bookmarks\",\"accounts\"]",
        "language":"system", "theme":"dark", "density":"comfortable", "appearance.radius":"12", "appearance.shadow":"soft", "appearance.accent":"", "appearance.background":"", "appearance.surface":"", "appearance.elevated":"", "appearance.border":"", "appearance.mediaBackground":"", "appearance.textContrast":"50", "appearance.timestampStyle":"relative", "appearance.collapseLongPosts":"true",
        "monitoring.autoCheck":"true", "monitoring.intervalMinutes":"5", "pages.openBehavior":"off", "startup.preloadBookmarks":"true", "startup.preloadFollowing":"true", "content.hideReposts":"false", "content.unreadOnly":"false", "content.readDelayMs":"1000", "content.autoRefreshMinutes":"0", "actions.advanced":"false", "actions.allowUnfollow":"true", "video.loop":"true", "video.clickToggle":"true", "video.gifAutoplay":"true", "video.offscreenCleanup":"true", "video.quality":"auto", "video.defaultSpeed":"1"
    ]
    var values: [String: String]
    init(entries: [[String]] = []) {
        values = Self.defaults
        for pair in entries where pair.count == 2 {
            if Self.defaults[pair[0]] != nil || pair[0].hasPrefix("pages.openBehavior.") { values[pair[0]] = pair[1] }
        }
    }
    var entries: [[String]] { values.keys.sorted().map { [$0, values[$0] ?? ""] } }
    func string(_ key: String) -> String { values[key] ?? Self.defaults[key] ?? "" }
    func bool(_ key: String) -> Bool { string(key) == "true" }
    func number(_ key: String) -> Double { Double(string(key)) ?? 0 }
    mutating func set(_ key: String, _ value: String) { values[key] = value }
    var tabs: [ReaderRoute] {
        guard let data = string("navigation.tabs").data(using: .utf8), let strings = try? JSONDecoder().decode([String].self, from: data) else { return [.following, .focus, .bookmarks, .accounts] }
        let routes = strings.compactMap(ReaderRoute.init(rawValue:)).filter { $0 != .settings }
        return routes.count == 4 && Set(routes).count == 4 ? routes : [.following, .focus, .bookmarks, .accounts]
    }
    mutating func setTabs(_ routes: [ReaderRoute]) { if let data = try? JSONEncoder().encode(routes.map(\.rawValue)), let value = String(data: data, encoding: .utf8) { set("navigation.tabs", value) } }
    var portableEntries: [[String]] { entries.filter { pair in !["actions.", "startup.", "window.", "updates."].contains { pair[0].hasPrefix($0) } } }
}

enum ReaderTheme {
    static func color(_ hex: String) -> UIColor? {
        let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard value.count == 6, let number = UInt32(value, radix: 16) else { return nil }
        return UIColor(red: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255, blue: CGFloat(number & 255) / 255, alpha: 1)
    }
    static func accent(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.accent")) ?? UIColor(red: 0.43, green: 0.45, blue: 0.95, alpha: 1) }
    static func apply(_ preferences: ReaderPreferences, to controller: UIViewController) {
        controller.overrideUserInterfaceStyle = preferences.string("theme") == "light" ? .light : ["dark", "oled"].contains(preferences.string("theme")) ? .dark : .unspecified
        controller.view.tintColor = accent(preferences)
        controller.view.semanticContentAttribute = L10n.arabic ? .forceRightToLeft : .forceLeftToRight
        controller.view.backgroundColor = color(preferences.string("appearance.background")) ?? (preferences.string("theme") == "oled" ? .black : .systemGroupedBackground)
    }
    static func font(_ style: UIFont.TextStyle, preferences: ReaderPreferences? = nil, weight: UIFont.Weight? = nil) -> UIFont {
        let preferred = UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        let scale = CGFloat((preferences?.number("reading.size") ?? 100) / 100)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: UIFont.systemFont(ofSize: preferred.pointSize * scale, weight: weight ?? .regular))
    }
}
