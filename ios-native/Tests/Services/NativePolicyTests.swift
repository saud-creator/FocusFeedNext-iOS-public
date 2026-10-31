import Foundation

/// The same deterministic assertions run in XCTest and the macOS Foundation
/// harness. They exercise ownership and interruption state, not live X traffic.
private enum NativePolicyCases {
    static func run(_ check: (Bool, String) -> Void) {
        let queued = NativeMediaHTTPFailure(status:503, brokerOrigin:"local_queue", trustedResponse:true)
        let upstream = NativeMediaHTTPFailure(status:503, brokerOrigin:"upstream_http", trustedResponse:true)
        check(queued.status == upstream.status && queued.origin != upstream.origin, "equal status retains distinct broker provenance")
        check(queued.origin == .localQueue, "only broker provenance identifies local queue exhaustion")
        check(NativeMediaHTTPFailure(status:429, brokerOrigin:"upstream_http", trustedResponse:true).origin == .upstreamHTTP, "upstream rate limiting is not local capacity")
        check(NativeMediaHTTPFailure(status:429, brokerOrigin:nil, trustedResponse:true).origin == .unknown, "status alone cannot infer provenance")
        check(NativeMediaHTTPFailure(status:503, brokerOrigin:"local_queue", trustedResponse:false).origin == .unknown, "untrusted responses cannot assert broker provenance")
        check(NativeMediaHTTPFailure(status:503, brokerOrigin:"private=https://invalid.example", trustedResponse:true).origin == .unknown, "arbitrary header content is discarded")

        var active = ActiveTimeBudget(limit: 10)
        check(!active.update(now: 0, active: true), "fresh budget")
        check(!active.update(now: 5, active: true), "foreground accrues active time")
        check(!active.update(now: 6, active: false), "background boundary preserves prior active time")
        check(!active.update(now: 1806, active: false), "thirty-minute suspension is not loading time")
        check(active.elapsed == 6, "background does not consume watchdog budget")
        check(!active.update(now: 1806, active: true), "foreground resumes existing budget")
        check(active.update(now: 1810, active: true), "remaining active time expires")
        active.progress(now: 1810, active: true)
        check(active.elapsed == 0, "observed playback progress resets stall budget")

        var retry = RecoveryAttemptBudget()
        check(retry.claim(epoch: 1, now: 0, manual: false), "first automatic attempt")
        check(!retry.claim(epoch: 1, now: 20, manual: false), "same epoch does not loop")
        check(retry.claim(epoch: 2, now: 20, manual: false), "restored connection permits new attempt")
        check(!retry.claim(epoch: 3, now: 21, manual: false), "route flapping obeys ten-second cooldown")
        check(retry.claim(epoch: 3, now: 30, manual: false), "cooldown expires")
        check(retry.claim(epoch: 3, now: 30, manual: true), "explicit Retry starts its own bounded attempt")

        for cycle in 0..<100 {
            let start = Double(cycle) * 2000
            var loading = ActiveTimeBudget(limit: 35)
            _ = loading.update(now: start, active: true)
            _ = loading.update(now: start + 2, active: false)
            _ = loading.update(now: start + 1802, active: true)
            check(!loading.update(now: start + 1805, active: true), "cycle \(cycle): suspension cannot exhaust image load")
            var repair = RecoveryAttemptBudget()
            check(repair.claim(epoch: UInt64(cycle + 1), now: start, manual: false), "cycle \(cycle): one repair is owned")
            check(!repair.claim(epoch: UInt64(cycle + 1), now: start + 50, manual: false), "cycle \(cycle): repeated callbacks cannot replay repair")
            let before = MediaOwnership(accountEpoch: UInt64(cycle), brokerEpoch: 1)
            let after = MediaOwnership(accountEpoch: UInt64(cycle + 1), brokerEpoch: 2)
            check(before != after, "cycle \(cycle): account/proxy change rejects stale completion")
        }

        let old = Data("previous".utf8), next = Data("candidate".utf8)
        var stored: Data? = old
        let transaction = SessionTransaction()
        do {
            try transaction.commit(next, read: { stored }, write: { stored = $0 }, remove: { stored = nil })
            check(stored == next, "session write committed")
            try transaction.rollback(write: { stored = $0 }, remove: { stored = nil })
            check(stored == old, "candidate rollback restores previous session")
        } catch { check(false, "ordinary commit/rollback must succeed") }

        var failCandidate = true
        do {
            try transaction.commit(next, read: { stored }, write: { value in
                stored = value
                if failCandidate { failCandidate = false; throw SessionWriteError.save }
            }, remove: { stored = nil })
            check(false, "partially failed write must throw")
        } catch { check(stored == old, "write failure after mutation still restores prior session") }

        do {
            let record = try SessionRecord.encode(token: "test-token", csrf: "test_csrf", cookies: [])
            let decoded = try SessionRecord.decode(record)
            check(decoded.token == "test-token" && decoded.csrf == "test_csrf", "versioned record round-trips")
            let legacy = try SessionRecord.decode(Data("test-token\ntest_csrf".utf8))
            check(legacy == decoded, "legacy two-line record remains readable")
        } catch { check(false, "session compatibility decoding") }
        for data in [Data("bad".utf8), Data("a\nb\nc".utf8), Data("{\"version\":2,\"authToken\":\"a\",\"ct0\":\"b\"}".utf8)] {
            do { _ = try SessionRecord.decode(data); check(false, "malformed/unsupported session must be rejected") }
            catch { check(true, "invalid record preserved for explicit recovery") }
        }

        let handoff = LoginHandoff()
        check(!handoff.finish(active: true), "login cannot finish before capture")
        handoff.didCapture()
        check(!handoff.finish(active: false), "captured login waits for activation")
        check(handoff.finish(active: true), "login commits once after activation")
        check(!handoff.finish(active: true), "late activation cannot settle login twice")
        check(!LoginHandoff.permitsProviderRequest(loginOpen: true, authentication: false), "ordinary reads cannot replace login candidate cookies")
        check(LoginHandoff.permitsProviderRequest(loginOpen: false, authentication: false), "saved-session verification is an ordinary read")
    }
}

#if NATIVE_POLICY_HARNESS
@main struct NativePolicyHarness {
    @MainActor static func main() async throws {
        var count = 0
        NativePolicyCases.run { condition, message in
            precondition(condition, message); count += 1
        }
        let deadline = NativeActiveDeadline<Int>(seconds: 0, active: true)
        do {
            _ = try await deadline.run { try await Task.sleep(nanoseconds: 1_000_000_000); return 1 }
            preconditionFailure("deadline must settle before work")
        } catch NativeRecoveryError.timeout { count += 1 }
        print("Native Foundation policy checks passed: \(count) assertions; 100 simulated interruption cycles; no live provider traffic.")
    }
}
#else
import XCTest
@testable import FocusFeedNextNative

final class NativePolicyTests: XCTestCase {
    func testInterruptionOwnershipAndSessionCompatibility() {
        NativePolicyCases.run { condition, message in XCTAssertTrue(condition, message) }
    }
    @MainActor func testDeadlineSettlesAndCancelsOwnedWork() async throws {
        let cancelled = expectation(description: "owned work cancelled")
        let deadline = NativeActiveDeadline<Int>(seconds: 0, active: true)
        do {
            _ = try await deadline.run {
                do { try await Task.sleep(nanoseconds: 10_000_000_000); return 1 }
                catch { cancelled.fulfill(); throw error }
            }
            XCTFail("deadline must win")
        } catch NativeRecoveryError.timeout { }
        await fulfillment(of: [cancelled], timeout: 2)
    }
    @MainActor func testManualCancellationSettlesExactlyOnce() async throws {
        let deadline = NativeActiveDeadline<Int>(seconds: 30, active: true)
        let task = Task { try await deadline.run { try await Task.sleep(nanoseconds: 10_000_000_000); return 1 } }
        await Task.yield()
        deadline.cancel(); deadline.cancel()
        do { _ = try await task.value; XCTFail("cancelled operation returned content") }
        catch is CancellationError { }
    }
    @MainActor func testBrokerURLRejectsRemoteAndDecoratedURLs() throws {
        let secret = String(repeating: "a", count: 48), id = String(repeating: "b", count: 32)
        _ = try NativeMediaService.brokerURL("http://127.0.0.1:12345/media/\(secret)/\(id)")
        for url in ["https://pbs.twimg.com/image.jpg", "http://localhost:12345/media/\(secret)/\(id)", "http://127.0.0.1:12345/media/\(secret)/\(id)?source=x", "http://127.0.0.1:12345/media/wrong/\(id)"] {
            XCTAssertThrowsError(try NativeMediaService.brokerURL(url))
        }
    }
    @MainActor func testForegroundOpportunityIsDebouncedOnce() async throws {
        let debouncer = NativeRecoveryDebouncer()
        var calls = 0
        debouncer.submit { calls += 100 }
        try await Task.sleep(nanoseconds: 100_000_000)
        debouncer.submit { calls += 1 }
        try await Task.sleep(nanoseconds: 850_000_000)
        XCTAssertEqual(calls, 1, "route flapping must yield one useful opportunity")
        debouncer.submit { calls += 100 }
        debouncer.cancel()
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(calls, 1, "background cancellation suppresses a pending opportunity")
    }
    func testDiagnosticsRemainBoundedAndRejectArbitraryDetails() throws {
        let journal = ConnectionJournal()
        for _ in 0..<600 {
            journal.record("failure", stage: "media", code: "decoder_failure", detail: ["authToken": "must-not-persist", "url": "https://invalid.example/private", "elapsedMs": 1.0])
        }
        let snapshot = journal.snapshot()
        XCTAssertEqual(snapshot.count, 512)
        let data = try JSONSerialization.data(withJSONObject: snapshot)
        XCTAssertLessThanOrEqual(data.count, 256 * 1024)
        let encoded = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(encoded.contains("must-not-persist"))
        XCTAssertFalse(encoded.contains("invalid.example"))
        XCTAssertTrue(ConnectionJournal().snapshot().isEmpty, "a new session must not reload diagnostic history")
    }
}
#endif
