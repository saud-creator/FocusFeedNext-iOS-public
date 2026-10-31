import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeInlineRecoveryTests: XCTestCase {
    func testFullscreenStatePreservesOpaqueQualityAndDoesNotOverwriteReturnedSettings() {
        let services = InlineFailureServices()
        let context = ReaderContext(services: services)
        let key = "1:125:0"
        context.rememberMedia(key, paused:true, position:12, speed:1.5, muted:true, loopPlayback:false, selectedHandle:"ffmedia:quality720")
        let item = PostMedia(kind:"video", url:"ffmedia:default", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let view = InlinePlayerView(item:item, context:context, playbackKey:key)
        let first = view.mediaPresentation()
        XCTAssertEqual(first.items[0].url, "ffmedia:quality720")
        XCTAssertEqual(first.position, 12); XCTAssertEqual(first.speed, 1.5)
        XCTAssertTrue(first.muted); XCTAssertFalse(first.loopPlayback); XCTAssertFalse(first.playing)
        context.rememberMedia(key, paused:true, position:21, speed:2, muted:false, loopPlayback:true, selectedHandle:"ffmedia:quality480")
        view.stop() // A recycled inactive cell must not replace the fullscreen result.
        let returned = view.mediaPresentation()
        XCTAssertEqual(returned.items[0].url, "ffmedia:quality480")
        XCTAssertEqual(returned.position, 21); XCTAssertEqual(returned.speed, 2)
        XCTAssertFalse(returned.muted); XCTAssertTrue(returned.loopPlayback); XCTAssertFalse(returned.playing)
        context.rememberMedia(key, selectedHandle:"http://127.0.0.1/private")
        XCTAssertEqual(context.playbackState(key)?.selectedHandle, "ffmedia:quality480", "Only opaque media handles belong in UI playback state.")
    }

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
        view.resumeIfInterrupted(); try await settle()
        XCTAssertEqual(services.repairs, 0, "Availability events must not start a second player recovery owner.")
        XCTAssertEqual(services.attempts.count, 1)
        view.play(); try await settle()
        XCTAssertEqual(services.repairs, 1)
        XCTAssertEqual(services.attempts, ["ffmedia:old", "ffmedia:renewed"], "Manual Retry must rebuild with the renewed registration.")
        view.stop()
    }
    func testRecoveryOpportunityDoesNotReplaceAnOwnedPausedPlayerItem() async throws {
        let services = InlineFailureServices(); services.allowPlayerCreation = true
        let context = ReaderContext(services:services)
        let item = PostMedia(kind:"video", url:"ffmedia:owned", previewUrl:nil, width:640, height:360, alt:nil, durationMs:nil, variants:[])
        let view = InlinePlayerView(item:item, context:context, playbackKey:"1:124:0")
        view.play(startPlaying:false); try await settle()
        let original = try XCTUnwrap(services.ownedPlayer)
        XCTAssertNotNil(original.currentItem)
        view.resumeIfInterrupted(); try await settle()
        XCTAssertEqual(services.attempts.count, 1, "An existing player item belongs to the service recovery path.")
        XCTAssertEqual(services.repairs, 0)
        XCTAssertTrue(services.ownedPlayer === original)
        view.stop()
    }
    private func settle() async throws { for _ in 0..<15 { await Task.yield(); try await Task.sleep(nanoseconds: 1_000_000) } }
}

/// Requests fail by default; an opt-in empty paused composition tests existing
/// ownership. Neither path performs network playback or proves AVKit decoding.
@MainActor private final class InlineFailureServices: AppServices {
    let accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    var attempts: [String] = []
    var repairs = 0
    var allowPlayerCreation = false
    var ownedPlayer: AVPlayer?
    func perform(_ request: AppRequest) async throws -> Data { throw AppServiceError(code:"unexpected_fixture_operation", message:"No content request is expected.") }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw AppServiceError(code:"fixture", message:"No sign-in in this fixture.") }
    func mediaURL(for handle: String) async throws -> URL { throw AppServiceError(code:"fixture", message:"No network media URL in this fixture.") }
    func imageData(url: String, maxPixelDimension: Int) async throws -> Data { throw AppServiceError(code:"fixture", message:"No image work in this fixture.") }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer {
        attempts.append(url)
        if allowPlayerCreation { let player = AVPlayer(playerItem:AVPlayerItem(asset:AVMutableComposition())); ownedPlayer = player; return player }
        throw AppServiceError(code:"controlled_failure", message:"Controlled player creation failure.")
    }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"No viewer in this fixture.") }
    func recoverMedia() async throws {}
    func recoverMediaHandle(_ handle: String) async throws -> String { repairs += 1; return "ffmedia:renewed" }
}
