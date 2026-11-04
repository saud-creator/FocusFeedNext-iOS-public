import XCTest
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeFullscreenRecoveryTests: XCTestCase {
    func testPendingSeekPositionSurvivesQualityChangeAndBrokerRestart() async throws {
        let fixture = FullscreenFixture(position:12)
        defer { fixture.stop() }
        fixture.controller.loadViewIfNeeded()
        try await settle { fixture.players.first?.pendingSeekCount == 1 }
        XCTAssertEqual(fixture.controller.dismissalResult()["position"] as? Double,12)
        fixture.controller.selectQuality(NativeMediaVariant(label:"480p",url:fixture.alternateURL))
        try await settle { fixture.players.count == 2 && fixture.players[1].pendingSeekCount == 1 }
        XCTAssertEqual(fixture.players[1].requestedPositions,[12])
        fixture.controller.prepareForBrokerRestart()
        fixture.service.invalidate(accountEpoch:0,brokerEpoch:1)
        fixture.controller.resumeAfterBrokerRestart()
        try await settle { fixture.players.count == 3 && fixture.players[2].pendingSeekCount == 1 }
        XCTAssertEqual(fixture.players[2].requestedPositions,[12])
        XCTAssertEqual(fixture.controller.dismissalResult()["position"] as? Double,12)
    }

    func testFailedSeekAndCloseRetainTheRequestedPosition() async throws {
        let fixture = FullscreenFixture(position:18)
        defer { fixture.stop() }
        fixture.controller.loadViewIfNeeded()
        try await settle { fixture.players.first?.pendingSeekCount == 1 }
        fixture.players[0].completeNextSeek(finished:false)
        try await settle { fixture.controller.view.accessibilityIdentifier == "native-video-failed" }
        XCTAssertEqual(fixture.controller.dismissalResult()["position"] as? Double,18)
        fixture.controller.prepareForDismissal()
        fixture.service.releasePlayer(owner:fixture.owner)
        XCTAssertEqual(fixture.controller.dismissalResult()["position"] as? Double,18)
    }

    func testQueuedOldItemEndCannotRestartAReplacementPlayer() async throws {
        let fixture = FullscreenFixture(position:0)
        defer { fixture.stop() }
        fixture.controller.loadViewIfNeeded()
        try await settle { fixture.controller.loopingItem != nil }
        let oldItem = try XCTUnwrap(fixture.controller.loopingItem)
        let replacement = FullscreenPlaybackSpy()
        replacement.replaceCurrentItem(with:AVPlayerItem(asset:AVMutableComposition()))
        defer { replacement.replaceCurrentItem(with:nil) }
        NotificationCenter.default.post(name:.AVPlayerItemDidPlayToEndTime,object:oldItem)
        fixture.controller.player = replacement
        await drainActor()
        XCTAssertTrue(replacement.requestedPositions.isEmpty)
        XCTAssertTrue(replacement.playRequests.isEmpty,"An old end callback must not autoplay a newer paused player.")
    }

    func testItemReplacementRejectsOldEndAndRebindsTheNewItem() async throws {
        let fixture = FullscreenFixture(position:0)
        defer { fixture.stop() }
        fixture.controller.loadViewIfNeeded()
        try await settle { fixture.controller.loopingItem != nil }
        let player = try XCTUnwrap(fixture.players.first)
        let oldItem = try XCTUnwrap(fixture.controller.loopingItem)
        let replacement = AVPlayerItem(asset:AVMutableComposition())
        NotificationCenter.default.post(name:.AVPlayerItemDidPlayToEndTime,object:oldItem)
        player.replaceCurrentItem(with:replacement)
        try await settle { fixture.controller.loopingItem === replacement }
        await drainActor()
        XCTAssertTrue(player.requestedPositions.isEmpty,"A recovered item's player must reject the old item's callback.")
        NotificationCenter.default.post(name:.AVPlayerItemDidPlayToEndTime,object:replacement)
        try await settle { player.pendingSeekCount == 1 }
        XCTAssertEqual(player.requestedPositions,[0])
        player.completeNextSeek(finished:true)
        try await settle { player.playRequests.count == 1 }
    }

    func testQueuedEndIsRejectedAfterPauseRevisionOrDismissal() async throws {
        let fixture = FullscreenFixture(position:0)
        defer { fixture.stop() }
        fixture.controller.loadViewIfNeeded()
        try await settle { fixture.controller.loopingItem != nil }
        let player = try XCTUnwrap(fixture.players.first)
        let item = try XCTUnwrap(fixture.controller.loopingItem)
        let revision = fixture.service.playbackPauseRevision
        fixture.service.pausePlayer(player: player, owner: UUID())
        XCTAssertEqual(fixture.service.playbackPauseRevision, revision, "An unrelated owner cannot pause the active player.")
        NotificationCenter.default.post(name:.AVPlayerItemDidPlayToEndTime,object:item)
        fixture.service.pausePlayer(player: player, owner: fixture.owner)
        await drainActor()
        XCTAssertTrue(player.requestedPositions.isEmpty,"An explicit service interruption must invalidate a queued loop.")
        NotificationCenter.default.post(name:.AVPlayerItemDidPlayToEndTime,object:item)
        fixture.controller.prepareForDismissal()
        await drainActor()
        XCTAssertTrue(player.requestedPositions.isEmpty)
        XCTAssertTrue(player.playRequests.isEmpty)
    }

    private func settle(_ condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while ProcessInfo.processInfo.systemUptime < deadline {
            if condition() { return }
            await Task.yield(); try await Task.sleep(nanoseconds:1_000_000)
        }
        XCTFail("The controlled fullscreen operation did not settle.")
        throw FixtureFailure.didNotSettle
    }
    private func drainActor() async { for _ in 0..<20 { await Task.yield() } }
    private enum FixtureFailure: Error { case didNotSettle }
}

/// Empty compositions and held callbacks exercise controller ownership only.
/// No provider, CDN, decoder, or physical playback is exercised by these checks.
@MainActor private final class FullscreenFixture {
    let owner: UUID
    let service: NativeMediaService
    let controller: NativeVideoController
    let alternateURL: String
    private let storage: FullscreenPlayerStorage
    var players: [FullscreenPlaybackSpy] { storage.players }
    init(position: Double) {
        let owner = UUID(); self.owner = owner
        let prefix = "http://127.0.0.1:12345/media/" + String(repeating:"a",count:48) + "/"
        let source = prefix + String(repeating:"b",count:32)
        alternateURL = prefix + String(repeating:"c",count:32)
        let storage = FullscreenPlayerStorage(); self.storage = storage
        let service = NativeMediaService(validateBrokerURL:{ _ in },repair:{ url, _ in url },playerFactory:{ _ in
            let player = FullscreenPlaybackSpy()
            player.replaceCurrentItem(with:AVPlayerItem(asset:AVMutableComposition()))
            storage.players.append(player); return player
        })
        self.service = service
        let args = NativeMediaArgs(revision:1,items:[NativeMediaItem(url:source,kind:"video",alt:nil,variants:[])],
            index:0,position:position,playing:false,speed:1,muted:true,loop:true,retryLabel:nil,locale:"en")
        controller = NativeVideoController(source:source,service:service,args:args,owner:owner,isApplicationActive:{ true })
    }
    func stop() {
        controller.prepareForDismissal(); service.releasePlayer(owner:owner)
        players.forEach { $0.completeAllSeeks() }
    }
}

@MainActor private final class FullscreenPlayerStorage { var players: [FullscreenPlaybackSpy] = [] }

private final class FullscreenPlaybackSpy: AVPlayer, @unchecked Sendable {
    private let stateLock = NSLock()
    private var positions: [Double] = []
    private var playback: [Float] = []
    private var completions: [(target:CMTime,completion:@Sendable (Bool) -> Void)] = []
    private var reportedTime = CMTime.zero
    var requestedPositions: [Double] { stateLock.lock(); defer { stateLock.unlock() }; return positions }
    var playRequests: [Float] { stateLock.lock(); defer { stateLock.unlock() }; return playback }
    var pendingSeekCount: Int { stateLock.lock(); defer { stateLock.unlock() }; return completions.count }
    override func currentTime() -> CMTime { stateLock.lock(); defer { stateLock.unlock() }; return reportedTime }
    override func playImmediately(atRate rate: Float) { stateLock.lock(); playback.append(rate); stateLock.unlock() }
    override func seek(to time:CMTime,toleranceBefore:CMTime,toleranceAfter:CMTime,completionHandler:@escaping @Sendable (Bool) -> Void) {
        stateLock.lock(); positions.append(time.seconds); completions.append((time,completionHandler)); stateLock.unlock()
    }
    func completeNextSeek(finished: Bool) {
        stateLock.lock()
        guard !completions.isEmpty else { stateLock.unlock(); return }
        let next = completions.removeFirst()
        if finished { reportedTime = next.target }
        stateLock.unlock(); next.completion(finished)
    }
    func completeAllSeeks() { while pendingSeekCount > 0 { completeNextSeek(finished:false) } }
}
