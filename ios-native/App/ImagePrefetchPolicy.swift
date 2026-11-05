import Foundation

/// Prefetch never receives all four picture slots; visible loads retain
/// capacity. Distance changes by mode, not unbounded concurrent work.
struct ImagePrefetchPolicy: Equatable {
    let capacity: Int
    let screensAhead: Int
    static let disabled = ImagePrefetchPolicy(capacity: 0, screensAhead: 0)
    static func effective(mode: String, runtime: ReaderRuntimeSnapshot?) -> ImagePrefetchPolicy {
        guard let runtime, runtime.foreground, runtime.wifi, !runtime.expensive,
              !runtime.constrained, !runtime.lowPower,
              !["serious", "critical"].contains(runtime.thermal), mode != "battery" else { return .disabled }
        switch mode {
        case "fast": return ImagePrefetchPolicy(capacity: 2, screensAhead: 2)
        case "ultra": return ImagePrefetchPolicy(capacity: 2, screensAhead: 3)
        default: return ImagePrefetchPolicy(capacity: 1, screensAhead: 1)
        }
    }
}
