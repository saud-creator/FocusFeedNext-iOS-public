import XCTest
@testable import FocusFeedNextNative

@MainActor final class NativeMediaRecoveryIdentityTests: XCTestCase {
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
