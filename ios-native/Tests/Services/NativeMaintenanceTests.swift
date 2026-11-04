import XCTest
@testable import FocusFeedNextNative

@MainActor final class NativeMaintenanceTests: XCTestCase {
    func testCompletedPreloadsAreNotRestartedByHealthySameGenerationUpdates() async throws {
        var pages: [NativePreloadKind] = []
        var checks = 0
        let scheduler = NativeMaintenanceScheduler(check:{ _ in checks += 1 },page:{ kind, _ in pages.append(kind); return true },failed:{ _, _ in XCTFail("Fixture preload unexpectedly failed.") },startupDelay:0)
        defer { scheduler.stop() }
        scheduler.configure(settings:NativeMaintenanceSettings(),generation:1,foreground:true,ready:true,busy:false)
        try await settle { pages.count == 2 && !scheduler.pending(.bookmarks) && !scheduler.pending(.following) }
        XCTAssertEqual(Set(pages),Set([.bookmarks,.following]))
        scheduler.recordSuccess()
        scheduler.configure(settings:NativeMaintenanceSettings(),generation:1,foreground:true,ready:true,busy:false)
        XCTAssertFalse(scheduler.pending(.bookmarks)); XCTAssertFalse(scheduler.pending(.following))
        XCTAssertEqual(pages.count,2,"A healthy monitor/session publish must not repeat startup traversal.")
        XCTAssertEqual(checks,0,"Fresh startup traffic must not trigger an immediate health probe.")
    }

    func testSettingsAndForegroundGateEachStartupFeatureWithoutPolling() async throws {
        var pages: [NativePreloadKind] = []
        let scheduler = NativeMaintenanceScheduler(check:{ _ in XCTFail("Disabled monitor must not probe.") },page:{ kind, _ in pages.append(kind); return true },failed:{ _, _ in XCTFail("Fixture preload unexpectedly failed.") },startupDelay:0)
        defer { scheduler.stop() }
        let settings = NativeMaintenanceSettings(values:["monitoring.autoCheck":"false","startup.preloadBookmarks":"false"])
        scheduler.configure(settings:settings,generation:1,foreground:false,ready:true,busy:false)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(pages.isEmpty)
        scheduler.configure(settings:settings,generation:1,foreground:true,ready:true,busy:true)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(pages.isEmpty,"Startup work must yield to foreground requests.")
        scheduler.configure(settings:settings,generation:1,foreground:true,ready:true,busy:false)
        try await settle { pages.count == 1 && !scheduler.pending(.following) }
        XCTAssertEqual(pages,[.following])
        scheduler.request(.bookmarks)
        try await settle { pages.count == 2 && !scheduler.pending(.bookmarks) }
        XCTAssertEqual(pages,[.following,.bookmarks],"An explicit user request can start a disabled automatic preload.")
    }

    func testLateCancelledPageCannotMarkNewGenerationAsComplete() async throws {
        var oldPage: CheckedContinuation<Bool,Never>?
        var attempts: [(NativePreloadKind,UInt64)] = []
        let scheduler = NativeMaintenanceScheduler(check:{ _ in },page:{ kind, generation in
            attempts.append((kind,generation))
            if generation == 1 { return await withCheckedContinuation { oldPage = $0 } }
            return true
        },failed:{ _, _ in XCTFail("Fixture preload unexpectedly failed.") },startupDelay:0)
        defer {
            let finish = oldPage; oldPage = nil; finish?.resume(returning:false)
            scheduler.stop()
        }
        scheduler.configure(settings:NativeMaintenanceSettings(),generation:1,foreground:true,ready:true,busy:false)
        try await settle { oldPage != nil }
        scheduler.configure(settings:NativeMaintenanceSettings(),generation:2,foreground:true,ready:true,busy:false)
        let finish = oldPage; oldPage = nil; finish?.resume(returning:true)
        try await settle { attempts.filter { $0.1 == 2 }.count == 2 && !scheduler.pending(.bookmarks) && !scheduler.pending(.following) }
        XCTAssertEqual(Set(attempts.filter { $0.1 == 2 }.map { $0.0 }),Set([.bookmarks,.following]))
        XCTAssertFalse(scheduler.pending(.bookmarks)); XCTAssertFalse(scheduler.pending(.following))
    }

    private func settle(_ condition: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        while ProcessInfo.processInfo.systemUptime < deadline {
            if condition() { return }
            await Task.yield(); try await Task.sleep(nanoseconds:1_000_000)
        }
        XCTFail("The controlled maintenance operation did not settle.")
        throw FixtureFailure.didNotSettle
    }
    private enum FixtureFailure: Error { case didNotSettle }
}
