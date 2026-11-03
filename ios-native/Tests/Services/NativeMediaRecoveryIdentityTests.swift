import XCTest
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeMediaRecoveryIdentityTests: XCTestCase {
    func testLateRecoveryCannotTakeOwnershipBackFromReplacementWithSameOwner() async throws {
        let source = "http://127.0.0.1:12345/media/" + String(repeating:"a",count:48) + "/" + String(repeating:"b",count:32)
        var pending: CheckedContinuation<URL,Never>?
        let service = NativeMediaService(validateBrokerURL:{ _ in }, repair:{ _, _ in await withCheckedContinuation { pending = $0 } },
            playerFactory:{ _ in AVPlayer(playerItem:AVPlayerItem(asset:AVMutableComposition())) })
        var failures = 0
        service.playerFailed = { _, _ in failures += 1 }
        let owner = UUID()
        let previous = try await service.makePlayer(url:source, owner:owner)
        service.receiveItemFailure(player:previous, item:try XCTUnwrap(previous.currentItem), owner:owner)
        for _ in 0..<100 where pending == nil { await Task.yield() }
        XCTAssertNotNil(pending,"The controlled recovery must reach its delayed native result.")
        let replacement = try await service.makePlayer(url:source, owner:owner)
        let finish = pending; pending = nil
        finish?.resume(returning:try XCTUnwrap(URL(string:source)))
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(failures,0,"An old recovery must not report failure against the healthy replacement.")
        service.releasePlayer(owner:owner)
        XCTAssertNil(replacement.currentItem,"The healthy replacement must remain the owned player until release.")
    }

    func testQueuedFailureFromReplacedPlayerOrItemCannotRepairHealthyReplacement() async throws {
        let source = "http://127.0.0.1:12345/media/" + String(repeating:"a",count:48) + "/" + String(repeating:"b",count:32)
        var repairs = 0
        let service = NativeMediaService(validateBrokerURL:{ _ in }, repair:{ url, _ in repairs += 1; return url },
            playerFactory:{ _ in AVPlayer(playerItem:AVPlayerItem(asset:AVMutableComposition())) })
        let owner = UUID()
        let previous = try await service.makePlayer(url:source, owner:owner)
        let previousItem = try XCTUnwrap(previous.currentItem)
        let replacement = try await service.makePlayer(url:source, owner:owner)
        let replacementItem = try XCTUnwrap(replacement.currentItem)
        // These represent callbacks already queued before a reuse/source change.
        service.receiveItemFailure(player:previous, item:previousItem, owner:owner)
        service.receiveItemFailure(player:replacement, item:previousItem, owner:owner)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(repairs,0,"An obsolete KVO failure must not spend the current item's recovery budget.")
        XCTAssertTrue(replacement.currentItem === replacementItem)
        service.releasePlayer(owner:owner)
    }

    func testRenewedRegistrationCannotStartAnotherAutomaticSequenceInSameEpoch() async throws {
        let prefix = "http://127.0.0.1:12345/media/" + String(repeating:"a",count:48) + "/"
        let initial = prefix + String(repeating:"b",count:32)
        let renewed = try XCTUnwrap(URL(string:prefix + String(repeating:"c",count:32)))
        var repairs = 0
        let service = NativeMediaService(validateBrokerURL:{ _ in }, repair:{ _, _ in repairs += 1; return renewed })
        let first = try await service.recover(url:initial, automatic:true)
        XCTAssertEqual(first,renewed)
        do {
            _ = try await service.recover(url:renewed.absoluteString, automatic:true)
            XCTFail("A renewed local URL must share its original automatic recovery budget.")
        } catch NativeMediaFailure.recoveryExhausted {}
        XCTAssertEqual(repairs,1)
        _ = try await service.recover(url:renewed.absoluteString, automatic:false)
        XCTAssertEqual(repairs,2,"Explicit Retry starts one new bounded sequence.")
    }

    func testOwnershipCallbacksDistinguishBrokerCleanupFromAccountReplacement() {
        let service = NativeMediaService(validateBrokerURL:{ _ in },repair:{ url, _ in url })
        var transitions: [String] = []
        service.ownershipInvalidated = { transitions.append("before:\($0)") }
        service.ownershipSettled = { transitions.append("after:\($0)") }
        service.invalidate(accountEpoch:1,brokerEpoch:1)
        service.invalidate(accountEpoch:1,brokerEpoch:2)
        service.invalidate(accountEpoch:2,brokerEpoch:2)
        XCTAssertEqual(transitions,["before:true","after:true","before:false","after:false","before:true","after:true"])
        service.invalidate(accountEpoch:2,brokerEpoch:2)
        XCTAssertEqual(transitions.count,6,"Repeated ownership publishes must not start another restoration.")
    }
}
