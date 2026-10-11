import Foundation

/// Bounded, persistent diagnostics with no arbitrary text, URLs or account data.
final class ConnectionJournal {
    private let defaults: UserDefaults
    private let key = "ffn.connection-journal.v1"
    private var events: [[String: Any]] = []
    private(set) var attempt = 0
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        events = (defaults.array(forKey: key) as? [[String: Any]] ?? []).suffix(80).map(Self.safe)
        attempt = events.compactMap { $0["attempt"] as? Int }.max() ?? 0
    }
    func begin() { attempt += 1; record("start", stage: "login") }
    func record(_ event: String, stage: String, code: String? = nil, status: Int? = nil, detail: [String: Any] = [:]) {
        var row = detail
        row["event"] = event; row["stage"] = stage; row["attempt"] = attempt
        row["time"] = Date().timeIntervalSince1970
        if let code = code { row["code"] = code }
        if let status = status { row["status"] = status }
        events.append(Self.safe(row)); events = Array(events.suffix(80))
        defaults.set(events, forKey: key)
    }
    func snapshot() -> [[String: Any]] { events.map(Self.safe) }
    static func safe(_ row: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, values) in [
            "event": ["start","stage","navigation","cookies","request","response","fallback","failure","recovery","cancelled","committed","connected","background","resume"],
            "stage": ["login","cookies","transport","transport_navigation","transport_origin","transport_process","transport_script","bootstrap","identity","provider","storage","bridge","queue","connected"],
            "code": ["missing_cookies","transport_initialization","transaction_bootstrap","authentication_expired","provider_rejection","rate_limited","account_challenge","timeout","cancelled","background_paused","session_storage","network_failure","unsupported_response","bridge_failure"],
            "nativeErrorDomain": ["url","webkit","other"],
            "engine": ["native","webkit"], "page": ["login","home","challenge","other"]
        ] {
            if let value = row[key] as? String, values.contains(value) { result[key] = value }
        }
        for key in ["attempt","endpoint","nativeErrorCode","status"] {
            if let value = row[key] as? Int, (-100000...100000).contains(value), key != "status" || (100...599).contains(value) { result[key] = value }
        }
        for key in ["active","hasToken","hasCsrf","hasIdentity"] { if let value = row[key] as? Bool { result[key] = value } }
        for key in ["time","elapsedMs"] { if let value = row[key] as? Double, value.isFinite, value >= 0, value <= (key == "time" ? 4102444800 : 75000) { result[key] = value } }
        return result
    }
}
