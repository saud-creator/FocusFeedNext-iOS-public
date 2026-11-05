import Foundation

/// Set only by the trusted loopback broker. HTTP status alone never identifies
/// whether capacity was exhausted locally or a provider rejected the request.
enum NativeMediaFailureOrigin: String, Equatable {
    case registration
    case localQueue = "local_queue"
    case upstreamHTTP = "upstream_http"
    case upstreamNetwork = "upstream_network"
    case unknown = "unknown_media_failure"
}

struct NativeMediaHTTPFailure: Equatable {
    let status: Int
    let origin: NativeMediaFailureOrigin

    init(status: Int, brokerOrigin: String?, trustedResponse: Bool) {
        self.status = status
        origin = trustedResponse ? brokerOrigin.flatMap(NativeMediaFailureOrigin.init(rawValue:)) ?? .unknown : .unknown
    }
}
