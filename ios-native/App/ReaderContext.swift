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
    private var memoryRevision: Int = 0
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
                case .runtimeChanged:
                    runtime = try? await services.call(.runtimeSnapshot)
                    if let revision = runtime?.memoryRevision, revision != memoryRevision { memoryRevision = revision; timelines.trimForMemoryPressure() }
                    changed()
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
    var defaultFollowingFilters: FeedFilters {
        var filters = FeedFilters()
        filters.hideReposts = bool("content.hideReposts")
        filters.unreadOnly = bool("content.unreadOnly")
        return filters
    }
    func openBehavior(for page: String) -> ReaderPageOpenBehavior {
        let own = values["pages.openBehavior.\(page)"] ?? ""
        return ReaderPageOpenBehavior(rawValue: own) ?? ReaderPageOpenBehavior(rawValue: string("pages.openBehavior")) ?? .off
    }
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
enum ReaderPageOpenBehavior: String { case off, refresh, reset }

@MainActor enum ReaderTheme {
    static private(set) var currentPreferences = ReaderPreferences()
    static func color(_ hex: String) -> UIColor? {
        var value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if value.count == 3 { value = value.map { String(repeating: String($0), count: 2) }.joined() }
        guard value.count == 6, let number = UInt32(value, radix: 16) else { return nil }
        return UIColor(red: CGFloat((number >> 16) & 255) / 255, green: CGFloat((number >> 8) & 255) / 255, blue: CGFloat(number & 255) / 255, alpha: 1)
    }
    static func accent(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.accent")) ?? UIColor(red: 0.43, green: 0.45, blue: 0.95, alpha: 1) }
    static func background(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.background")) ?? (preferences.string("theme") == "oled" ? .black : .systemGroupedBackground) }
    static func surface(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.surface")) ?? .secondarySystemGroupedBackground }
    static func elevated(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.elevated")) ?? .tertiarySystemGroupedBackground }
    static func border(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.border")) ?? .separator }
    static func mediaBackground(_ preferences: ReaderPreferences) -> UIColor { color(preferences.string("appearance.mediaBackground")) ?? .black }
    static func spacing(_ preferences: ReaderPreferences) -> CGFloat { preferences.string("density") == "compact" ? 8 : 12 }
    static func text(_ preferences: ReaderPreferences, secondary: Bool = false, on background: UIColor? = nil) -> UIColor {
        let bed = background ?? surface(preferences)
        let contrast = min(100, max(0, preferences.number("appearance.textContrast"))) / 100
        return UIColor { traits in
            let resolved = bed.resolvedColor(with: traits)
            let white = contrastRatio(.white, resolved, traits: traits)
            let black = contrastRatio(.black, resolved, traits: traits)
            let foreground: UIColor = white > black ? .white : .black
            let strength = CGFloat(secondary ? 0.62 + contrast * 0.25 : 0.82 + contrast * 0.18)
            return mix(resolved, foreground, fraction: strength)
        }
    }
    private static func mix(_ a: UIColor, _ b: UIColor, fraction: CGFloat) -> UIColor {
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa); b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return UIColor(red: ar + (br-ar)*fraction, green: ag + (bg-ag)*fraction, blue: ab + (bb-ab)*fraction, alpha: 1)
    }
    static func contrastRatio(_ a: UIColor, _ b: UIColor, traits: UITraitCollection = .current) -> Double {
        func luminance(_ color: UIColor) -> Double {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, alpha: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &alpha)
            func linear(_ channel: CGFloat) -> Double { let value = Double(channel); return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
            return 0.2126*linear(r) + 0.7152*linear(g) + 0.0722*linear(b)
        }
        let first = luminance(a), second = luminance(b)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }
    static func styleCard(_ view: UIView, preferences: ReaderPreferences) {
        view.backgroundColor = surface(preferences)
        view.layer.cornerRadius = CGFloat(preferences.number("appearance.radius")) + 6
        view.layer.borderWidth = 1 / max(1, view.traitCollection.displayScale)
        view.layer.borderColor = border(preferences).resolvedColor(with: view.traitCollection).cgColor
        let intensity = preferences.string("appearance.shadow")
        view.layer.shadowColor = UIColor.black.cgColor
        view.layer.shadowOpacity = intensity == "none" ? 0 : intensity == "strong" ? 0.22 : 0.09
        view.layer.shadowRadius = intensity == "strong" ? 10 : 4
        view.layer.shadowOffset = CGSize(width: 0, height: intensity == "strong" ? 4 : 2)
        view.layer.shadowPath = UIBezierPath(roundedRect: view.bounds, cornerRadius: view.layer.cornerRadius).cgPath
    }
    static func apply(_ preferences: ReaderPreferences, to controller: UIViewController) {
        currentPreferences = preferences
        controller.overrideUserInterfaceStyle = preferences.string("theme") == "light" ? .light : ["dark", "oled"].contains(preferences.string("theme")) ? .dark : .unspecified
        controller.view.tintColor = accent(preferences)
        controller.view.semanticContentAttribute = L10n.arabic ? .forceRightToLeft : .forceLeftToRight
        controller.view.backgroundColor = background(preferences)
        func visit(_ view: UIView) {
            if let label = view as? ReaderLabel { label.updateAppearance(preferences) }
            if let table = view as? UITableView { table.backgroundColor = background(preferences); table.separatorColor = border(preferences) }
            if let cell = view as? ReaderTableCell { cell.updateAppearance(preferences) }
            if let segment = view as? UISegmentedControl { segment.backgroundColor = elevated(preferences) }
            view.subviews.forEach(visit)
        }
        visit(controller.view)
    }
    static func font(_ style: UIFont.TextStyle, preferences: ReaderPreferences? = nil, weight: UIFont.Weight? = nil) -> UIFont {
        let preferred = UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        let scale = CGFloat((preferences?.number("reading.size") ?? 100) / 100)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: UIFont.systemFont(ofSize: preferred.pointSize * scale, weight: weight ?? .regular))
    }
}
