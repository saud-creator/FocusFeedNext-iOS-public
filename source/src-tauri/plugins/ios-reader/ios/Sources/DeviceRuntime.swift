import Foundation
import UIKit
import Network

/// OS notifications and path changes only; no polling or active speed tests.
final class DeviceRuntime {
    private let monitor = NWPathMonitor()
    private var observers: [NSObjectProtocol] = []
    private var wifi = false
    private var expensive = false
    private var constrained = false
    private var memoryRevision = 0
    var changed: (([String: Any]) -> Void)?
    init() {
        _ = ProcessInfo.processInfo.thermalState
        let notifications: [Notification.Name] = [UIApplication.didBecomeActiveNotification,
            UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
            .NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification,
            UIAccessibility.reduceMotionStatusDidChangeNotification,
            UIAccessibility.reduceTransparencyStatusDidChangeNotification,
            UIContentSizeCategory.didChangeNotification, UIApplication.didReceiveMemoryWarningNotification]
        for name in notifications {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self = self else { return }
                if note.name == UIApplication.didReceiveMemoryWarningNotification { self.memoryRevision += 1 }
                self.changed?(self.snapshot())
            })
        }
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.wifi = path.usesInterfaceType(.wifi)
                self.expensive = path.isExpensive
                self.constrained = path.isConstrained
                self.changed?(self.snapshot())
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.focusfeed.next.network-path"))
    }
    func snapshot() -> [String: Any] {
        let thermal: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "serious"
        }
        return ["foreground": UIApplication.shared.applicationState != .background,
            "active": UIApplication.shared.applicationState == .active,
            "wifi": wifi, "expensive": expensive, "constrained": constrained,
            "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "thermal": thermal, "reduceMotion": UIAccessibility.isReduceMotionEnabled,
            "reduceTransparency": UIAccessibility.isReduceTransparencyEnabled,
            "contentSizeScale": UIFont.preferredFont(forTextStyle: .body).pointSize / 17,
            "memoryRevision": memoryRevision]
    }
    deinit { monitor.cancel(); observers.forEach(NotificationCenter.default.removeObserver) }
}
