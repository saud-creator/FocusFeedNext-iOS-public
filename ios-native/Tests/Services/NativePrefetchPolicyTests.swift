import XCTest
@testable import FocusFeedNextNative

final class NativePrefetchPolicyTests: XCTestCase {
    private func runtime() -> ReaderRuntimeSnapshot { ReaderRuntimeSnapshot(foreground:true, wifi:true, expensive:false, constrained:false, lowPower:false, thermal:"nominal", reduceMotion:false, reduceTransparency:false, contentSizeScale:1, memoryRevision:0) }
    func testModesVaryRunwayWhilePreservingVisibleImageCapacity() {
        let value = runtime()
        XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"balanced", runtime:value), ImagePrefetchPolicy(capacity:1, screensAhead:1))
        XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"fast", runtime:value), ImagePrefetchPolicy(capacity:2, screensAhead:2))
        XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"ultra", runtime:value), ImagePrefetchPolicy(capacity:2, screensAhead:3))
        XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"battery", runtime:value), .disabled)
        XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"ultra", runtime:nil), .disabled)
    }
    func testBackgroundPowerDataAndThermalConditionsStopSpeculation() {
        let healthy = runtime()
        for key in 0..<6 {
            var changed = healthy
            switch key { case 0: changed.foreground = false; case 1: changed.wifi = false; case 2: changed.expensive = true; case 3: changed.constrained = true; case 4: changed.lowPower = true; default: changed.thermal = "serious" }
            XCTAssertEqual(ImagePrefetchPolicy.effective(mode:"ultra", runtime:changed), .disabled)
        }
    }
}
