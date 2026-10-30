import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeInlineRecoveryTests: XCTestCase {
    func testExplicitRetryRefreshesFailedHandleWithoutAutoplayRetryLoop() async throws {
        let services = InlineFailureServices()
        let context = ReaderContext(services: services)
        let item = PostMedia(kind:"video", url:"ffmedia:old", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let view = InlinePlayerView(item:item, context:context, playbackKey:"1:123:0")
        view.play(); try await settle()
        XCTAssertEqual(services.attempts, ["ffmedia:old"])
        XCTAssertEqual(services.repairs, 0, "The first playback attempt must not request fresh metadata.")
        view.play(automatically:true); try await settle()
        XCTAssertEqual(services.attempts.count, 1, "Failed playback must settle instead of autoplay-retrying.")
        view.play(); try await settle()
        XCTAssertEqual(services.repairs, 1)
        XCTAssertEqual(services.attempts, ["ffmedia:old", "ffmedia:renewed"], "Manual Retry must rebuild with the renewed registration.")
        view.stop()
    }
    private func settle() async throws { for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds: 1_000_000) } }
}

/// Every attempted player deterministically fails before any decoder/network
/// work. This fixture tests application retry ownership, not AVKit decoding.
@MainActor private final class InlineFailureServices: AppServices {
    let accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    var attempts: [String] = []
    var repairs = 0
    func perform(_ request: AppRequest) async throws -> Data { throw AppServiceError(code:"unexpected_fixture_operation", message:"No content request is expected.") }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw AppServiceError(code:"fixture", message:"No sign-in in this fixture.") }
    func mediaURL(for handle: String) async throws -> URL { throw AppServiceError(code:"fixture", message:"No network media URL in this fixture.") }
    func imageData(url: String, maxPixelDimension: Int) async throws -> Data { throw AppServiceError(code:"fixture", message:"No image work in this fixture.") }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { attempts.append(url); throw AppServiceError(code:"controlled_failure", message:"Controlled player creation failure.") }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"No viewer in this fixture.") }
    func recoverMedia() async throws {}
    func recoverMediaHandle(_ handle: String) async throws -> String { repairs += 1; return "ffmedia:renewed" }
}
