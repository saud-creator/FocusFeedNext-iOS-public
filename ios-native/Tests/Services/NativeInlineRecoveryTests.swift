import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeInlineRecoveryTests: XCTestCase {
    func testSurfaceTapPreferenceDoesNotDisableExplicitPlayback() async throws {
        let services = InlineFailureServices(); let context = ReaderContext(services: services)
        context.preferences.set("video.clickToggle", "false")
        let item = PostMedia(kind: "video", url: "ffmedia:surface", previewUrl: nil, width: 640, height: 360, alt: nil, durationMs: nil, variants: [])
        let view = InlinePlayerView(item: item, context: context, playbackKey: "1:surface:0")
        view.toggleFromSurface(); try await settle()
        XCTAssertTrue(services.attempts.isEmpty, "Turning off surface taps must leave the video untouched.")
        view.play(); try await settle()
        XCTAssertEqual(services.attempts, ["ffmedia:surface"], "Explicit playback remains usable when surface taps are disabled.")
        context.preferences.set("video.clickToggle", "true")
        view.toggleFromSurface(); try await settle()
        XCTAssertEqual(services.repairs, 1, "An enabled surface tap can request the settled player's explicit Retry.")
        view.stop()
    }
    func testCancelledInlineSeekRejectsLateCompletionAndPreservesRememberedPosition() async throws {
        let services = InlineFailureServices(); services.allowPlayerCreation = true; services.delaySeek = true
        let context = ReaderContext(services:services)
        let key = "1:126:0"
        context.rememberMedia(key,position:12)
        let item = PostMedia(kind:"video",url:"ffmedia:owned",previewUrl:nil,width:640,height:360,alt:nil,durationMs:nil,variants:[])
        let view = InlinePlayerView(item:item,context:context,playbackKey:key)
        defer { view.stop(); services.completeSeek() }
        view.play()
        try await settleUntil { services.pendingSeek != nil }
        let previous = try XCTUnwrap(services.players.first)
        XCTAssertEqual(services.seekRequests.first?.position,12)
        view.stop()
        XCTAssertEqual(context.position(key),12,"Recycling a pending seek must not save the new player's initial zero time.")
        try await settleUntil { services.cancelledSeeks == 1 }
        services.delaySeek = false
        view.play(startPlaying:false)
        try await settleUntil { services.seekRequests.count == 2 }
        let replacement = try XCTUnwrap(services.players.last)
        XCTAssertFalse(previous === replacement)
        services.completeSeek() // Models an SDK callback delivered after cancellation.
        try await settle()
        XCTAssertTrue(previous.playRequests.isEmpty,"Late completion must not restart the cancelled player.")
        XCTAssertTrue(replacement.playRequests.isEmpty,"A paused replacement must retain its playback intent.")
        XCTAssertTrue(services.ownedPlayer === replacement)
    }

    func testRejectedInlineSeekSettlesAndDoesNotStartAutoplayRetryLoop() async throws {
        let services = InlineFailureServices(); services.allowPlayerCreation = true; services.failSeek = true
        let context = ReaderContext(services:services)
        let key = "1:127:0"; context.rememberMedia(key,position:9)
        let item = PostMedia(kind:"video",url:"ffmedia:owned",previewUrl:nil,width:640,height:360,alt:nil,durationMs:nil,variants:[])
        let view = InlinePlayerView(item:item,context:context,playbackKey:key)
        defer { view.stop() }
        view.play()
        try await settleUntil { services.seekRequests.count == 1 }
        try await settle()
        view.play(automatically:true)
        try await settle()
        XCTAssertEqual(services.attempts.count,1,"A failed seek must settle for explicit Retry instead of autoplay-looping.")
        XCTAssertTrue(services.players[0].playRequests.isEmpty)
        view.stop()
        XCTAssertEqual(context.position(key),9,"A rejected seek must preserve the remembered playhead.")
    }

    func testRecoveredItemRebindsLoopWithoutReplayingTheOldItemCallback() async throws {
        let services = InlineFailureServices()
        services.allowPlayerCreation = true
        let context = ReaderContext(services: services)
        context.preferences.set("video.loop", "true")
        let item = PostMedia(kind:"video",url:"ffmedia:owned",previewUrl:nil,width:640,height:360,alt:nil,durationMs:nil,variants:[])
        let view = InlinePlayerView(item:item,context:context,playbackKey:"1:128:0")
        defer { view.stop() }
        view.play()
        try await settleUntil { view.loopingItem != nil && services.players.first?.playRequests.count == 1 }
        let player = try XCTUnwrap(services.players.first)
        let oldItem = try XCTUnwrap(view.loopingItem)
        let replacement = AVPlayerItem(asset: AVMutableComposition())
        NotificationCenter.default.post(name: .AVPlayerItemDidPlayToEndTime, object: oldItem)
        player.replaceCurrentItem(with: replacement)
        try await settleUntil { view.loopingItem === replacement }
        XCTAssertTrue(services.seekRequests.isEmpty)

        NotificationCenter.default.post(name: .AVPlayerItemDidPlayToEndTime, object: replacement)
        try await settleUntil { player.playRequests.count == 2 }
        XCTAssertEqual(services.seekRequests.map(\.position), [0])
    }

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
    private func settleUntil(_ condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while ProcessInfo.processInfo.systemUptime < deadline {
            if condition() { return }
            await Task.yield(); try await Task.sleep(nanoseconds:1_000_000)
        }
        XCTFail("The controlled inline operation did not settle.")
        throw FixtureFailure.didNotSettle
    }
    private enum FixtureFailure: Error { case didNotSettle }
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
    var players: [InlinePlaybackSpy] = []
    var seekRequests: [(owner:UUID,position:Double)] = []
    var delaySeek = false
    var failSeek = false
    var pendingSeek: CheckedContinuation<Void,Never>?
    var cancelledSeeks = 0
    func perform(_ request: AppRequest) async throws -> Data { throw AppServiceError(code:"unexpected_fixture_operation", message:"No content request is expected.") }
    func cancel(requestID: UUID) {}
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw AppServiceError(code:"fixture", message:"No sign-in in this fixture.") }
    func mediaURL(for handle: String) async throws -> URL { throw AppServiceError(code:"fixture", message:"No network media URL in this fixture.") }
    func loadImage(url: String, maxPixelDimension: Int) async throws -> UIImage { throw AppServiceError(code:"fixture", message:"No image work in this fixture.") }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer {
        attempts.append(url)
        if allowPlayerCreation {
            let player = InlinePlaybackSpy(); player.replaceCurrentItem(with:AVPlayerItem(asset:AVMutableComposition()))
            players.append(player); ownedPlayer = player; return player
        }
        throw AppServiceError(code:"controlled_failure", message:"Controlled player creation failure.")
    }
    func seekPlayer(player:AVPlayer,owner:UUID,position:Double)async throws {
        seekRequests.append((owner,position))
        if failSeek { throw AppServiceError(code:"controlled_seek_failure",message:"Controlled seek failure.") }
        if delaySeek {
            // Intentionally finish after cancellation to test the caller's late-result guards.
            await withTaskCancellationHandler(operation:{
                await withCheckedContinuation { pendingSeek = $0 }
            },onCancel:{ Task { @MainActor in self.cancelledSeeks += 1 } })
        }
    }
    func completeSeek() { let complete = pendingSeek; pendingSeek = nil; complete?.resume() }
    func releasePlayer(owner: UUID) { ownedPlayer?.pause(); ownedPlayer?.replaceCurrentItem(with:nil); ownedPlayer = nil }
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw AppServiceError(code:"fixture", message:"No viewer in this fixture.") }
    func recoverMedia() async throws {}
    func recoverMediaHandle(_ handle: String) async throws -> String { repairs += 1; return "ffmedia:renewed" }
}

/// Records playback intent without executing a decoder or network request.
private final class InlinePlaybackSpy: AVPlayer, @unchecked Sendable {
    private let requestLock = NSLock()
    private var requests: [Float] = []
    var playRequests: [Float] { requestLock.lock(); defer { requestLock.unlock() }; return requests }
    override func playImmediately(atRate rate: Float) { requestLock.lock(); requests.append(rate); requestLock.unlock() }
}
