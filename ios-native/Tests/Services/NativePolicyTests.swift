import Foundation

/// The same deterministic assertions run in XCTest and the macOS Foundation
/// harness. They exercise ownership and interruption state, not live X traffic.
private enum NativePolicyCases {
    static func run(_ check: (Bool, String) -> Void) {
        var monitoring = NativeMaintenancePolicy()
        check(monitoring.configure(generation:1,now:0),"new account initializes maintenance once")
        monitoring.foreground = true; monitoring.ready = true
        check(monitoring.delay(now:0) == 300,"default monitor honors five minutes")
        check(monitoring.delay(now:299) == 1,"monitor does not poll before its interval")
        check(monitoring.delay(now:300) == 0,"configured deadline becomes due")
        monitoring.success(now:290)
        check(monitoring.delay(now:300) == 290,"real foreground success makes a redundant probe unnecessary")
        monitoring.beganProbe(now:600)
        check(monitoring.delay(now:610) == 290,"failed probe still waits the normal interval")
        monitoring.busy = true
        check(monitoring.delay(now:900) == nil,"user work owns priority")
        monitoring.busy = false; monitoring.foreground = false
        check(monitoring.delay(now:900) == nil,"no background monitor timer")
        monitoring.foreground = true; monitoring.settings = NativeMaintenanceSettings(values:["monitoring.autoCheck":"false"])
        check(monitoring.delay(now:900) == nil,"disabled monitor performs no automatic check")
        monitoring.settings = NativeMaintenanceSettings(values:["monitoring.intervalMinutes":"17","startup.preloadBookmarks":"false"])
        check(monitoring.delay(now:600) == 1020,"saved interval reconfigures the monitor")
        check(!monitoring.settings.enabled(.bookmarks) && monitoring.settings.enabled(.following),"startup options are independent")
        check(!monitoring.configure(generation:1,now:1000),"healthy identity does not reset account maintenance")
        check(monitoring.configure(generation:2,now:1000),"new identity resets maintenance ownership")
        check(monitoring.delay(now:1000) == 1020,"new generation starts a fresh interval")
        monitoring.ready = false
        check(monitoring.delay(now:9000) == nil,"unverified or disconnected accounts never auto-login")
        var traversal = NativeCursorProgress()
        do {
            check(try !traversal.accept(next:"older",pageItems:60),"provider cursor keeps full traversal open")
            do { _ = try traversal.accept(next:"older",pageItems:60); check(false,"repeated cursor cannot claim completeness") }
            catch NativeCursorError.repeatedCursor { check(true,"loop settles as partial/error") }
            check(try traversal.accept(next:nil,pageItems:60),"only terminal cursor completes traversal")
            var stalled = NativeCursorProgress()
            _ = try stalled.accept(next:"one",pageItems:0)
            _ = try stalled.accept(next:"two",pageItems:0)
            do { _ = try stalled.accept(next:"three",pageItems:0); check(false,"empty pages with rotating cursors cannot loop forever") }
            catch NativeCursorError.noProgress { check(true,"nonproductive traversal settles without count ceiling") }
            var longCycle = NativeCursorProgress()
            var detected = false
            for index in 0..<2000 {
                do { _ = try longCycle.accept(next:"cycle-\(index % 300)",pageItems:60) }
                catch NativeCursorError.repeatedCursor { detected = true; break }
            }
            check(detected,"constant-space guard detects cycles longer than a viewport/history window")
            var completeTraversal = NativeCursorProgress()
            for index in 0..<10000 { _ = try completeTraversal.accept(next:"page-\(index)",pageItems:60) }
            check(try completeTraversal.accept(next:nil,pageItems:0),"large legitimate traversal has no application count ceiling")
        } catch { check(false,"ordinary cursor policy unexpectedly failed") }
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
        let callback = NativeCallbackOperation<Int>()
        var lateCompletion: ((Result<Int, Error>) -> Void)?
        var nativeCancellations = 0
        let pending = Task { try await callback.run(start:{ lateCompletion = $0 }, cancel:{ nativeCancellations += 1 }) }
        for _ in 0..<100 where lateCompletion == nil { await Task.yield() }
        precondition(lateCompletion != nil,"controlled native callback must start"); count += 1
        pending.cancel()
        do { _ = try await pending.value; preconditionFailure("cancelled callback must not wait for native completion") }
        catch is CancellationError { count += 1 }
        precondition(nativeCancellations == 1,"owned native work must be cancelled once"); count += 1
        lateCompletion?(.success(99)); callback.cancel()
        for _ in 0..<10 { await Task.yield() }
        precondition(nativeCancellations == 1,"late callback cannot cancel or settle newer work"); count += 1
        print("Native Foundation policy checks passed: \(count) assertions; 100 simulated interruption cycles; no live provider traffic.")
    }
}
#else
import XCTest
@testable import FocusFeedNextNative

final class NativePolicyTests: XCTestCase {
    @MainActor func testNativeCallbackCancellationDoesNotWaitForLateCompletion() async throws {
        let operation = NativeCallbackOperation<Int>()
        var completion: ((Result<Int, Error>) -> Void)?
        var cancellations = 0
        let pending = Task { try await operation.run(start:{ completion = $0 }, cancel:{ cancellations += 1 }) }
        for _ in 0..<100 where completion == nil { await Task.yield() }
        XCTAssertNotNil(completion)
        pending.cancel()
        do { _ = try await pending.value; XCTFail("Cancelled callback returned a value.") }
        catch is CancellationError {}
        XCTAssertEqual(cancellations,1)
        completion?(.success(99)); operation.cancel()
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(cancellations,1,"A late SDK callback must not settle or cancel an operation twice.")
    }

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
