import XCTest
@testable import FocusFeedNextNative

@MainActor final class NativeReadingRestoreTests: XCTestCase {
    func testHTTPRetriesAndSiblingRequestsShareTheThreeDispatchCeiling() throws {
        let gate = NativeProviderReadGate(); let budget = NativeProviderReadBudget()
        let first = gate.bind(budget,parentID:"page")
        let second = gate.bind(budget,parentID:"detail")
        defer { gate.release(parentID:"page",bindingID:first); gate.release(parentID:"detail",bindingID:second) }
        let api = try XCTUnwrap(URL(string:"https://x.com/i/api/graphql/query/UserTweets"))
        var dispatched = 0
        try gate.dispatch(parentID:"page",url:api,method:"GET") { dispatched += 1 }
        // The retained transaction engine may retry the same parent internally.
        try gate.dispatch(parentID:"page",url:api,method:"GET") { dispatched += 1 }
        try gate.dispatch(parentID:"detail",url:api,method:"GET") { dispatched += 1 }
        XCTAssertThrowsError(try gate.dispatch(parentID:"page",url:api,method:"GET") { dispatched += 1 }) {
            XCTAssertEqual($0 as? NativeReadingRestoreError,.limitReached)
        }
        XCTAssertThrowsError(try gate.dispatch(parentID:"detail",url:api,method:"GET") { dispatched += 1 })
        XCTAssertEqual(dispatched,3,"A refused retry must not start a native HTTP job.")
        XCTAssertEqual(budget.remaining,0)
    }

    func testBootstrapAndWritesAreExemptAndManualPagingIsUnrestrictedAfterRelease() throws {
        let gate = NativeProviderReadGate(); let budget = NativeProviderReadBudget(limit:1)
        let binding = gate.bind(budget,parentID:"restore")
        let home = try XCTUnwrap(URL(string:"https://x.com/home"))
        let script = try XCTUnwrap(URL(string:"https://abs.twimg.com/responsive-web/client-web/main.js"))
        let api = try XCTUnwrap(URL(string:"https://x.com/i/api/graphql/query/Bookmarks"))
        var dispatched = 0
        for _ in 0..<5 {
            try gate.dispatch(parentID:"restore",url:home,method:"GET") { dispatched += 1 }
            try gate.dispatch(parentID:"restore",url:script,method:"GET") { dispatched += 1 }
            try gate.dispatch(parentID:"restore",url:api,method:"POST") { dispatched += 1 }
        }
        XCTAssertEqual(budget.remaining,1)
        try gate.dispatch(parentID:"restore",url:api,method:"GET") { dispatched += 1 }
        XCTAssertThrowsError(try gate.dispatch(parentID:"restore",url:api,method:"GET") { dispatched += 1 })
        XCTAssertEqual(dispatched,16)
        gate.release(parentID:"restore",bindingID:binding)
        XCTAssertEqual(gate.boundParentCount,0)
        for _ in 0..<8 { try gate.dispatch(parentID:"manual",url:api,method:"GET") { dispatched += 1 } }
        XCTAssertEqual(dispatched,24)
        XCTAssertEqual(budget.remaining,0)
    }

    func testOldBindingReleaseCannotRemoveNewerParentOwnershipAndFailureReleasesCapacity() throws {
        let gate = NativeProviderReadGate()
        let old = gate.bind(NativeProviderReadBudget(),parentID:"same")
        let currentBudget = NativeProviderReadBudget(limit:0)
        let current = gate.bind(currentBudget,parentID:"same")
        gate.release(parentID:"same",bindingID:old)
        XCTAssertEqual(gate.boundParentCount,1)
        let api = try XCTUnwrap(URL(string:"https://x.com/i/api/graphql/query/UserTweets"))
        XCTAssertThrowsError(try gate.dispatch(parentID:"same",url:api,method:"GET") { XCTFail("New ownership was removed by an old completion.") })
        func cancelledRequest() throws {
            defer { gate.release(parentID:"same",bindingID:current) }
            throw CancellationError()
        }
        XCTAssertThrowsError(try cancelledRequest())
        XCTAssertEqual(gate.boundParentCount,0)
        var dispatched = false
        try gate.dispatch(parentID:"same",url:api,method:"GET") { dispatched = true }
        XCTAssertTrue(dispatched,"A settled request must not retain a quota binding for manual work.")
    }

    func testBudgetConsumptionIsAtomicAcrossConcurrentCallbacks() async {
        let budget = NativeProviderReadBudget()
        let admitted = await withTaskGroup(of:Bool.self,returning:Int.self) { group in
            for _ in 0..<100 {
                group.addTask {
                    do { try budget.consume(); return true }
                    catch { return false }
                }
            }
            var admitted = 0
            for await succeeded in group { if succeeded { admitted += 1 } }
            return admitted
        }
        XCTAssertEqual(admitted,3); XCTAssertEqual(budget.remaining,0)
    }

    func testNestedProviderReadsShareOneRestoreBudget() async throws {
        let budget = NativeProviderReadBudget()
        try await NativeReadingRestoreScope.$budget.withValue(budget) {
            // Model an initial feed page, then its profile/detail reads from
            // inherited child work. Each reaches the same transport gate.
            try NativeReadingRestoreScope.budget?.consume()
            try await Task { @MainActor in
                try NativeReadingRestoreScope.budget?.consume()
                try NativeReadingRestoreScope.budget?.consume()
            }.value
            XCTAssertThrowsError(try NativeReadingRestoreScope.budget?.consume()) {
                XCTAssertEqual($0 as? NativeReadingRestoreError, .limitReached)
            }
        }
        XCTAssertEqual(budget.remaining, 0)
        XCTAssertNil(NativeReadingRestoreScope.budget, "Manual paging after restoration must be unrestricted.")
    }

    func testConcurrentRestoreScopesDoNotBorrowEachOthersReads() async throws {
        let first = NativeProviderReadBudget(limit: 1)
        let second = NativeProviderReadBudget(limit: 2)
        let a = Task { @MainActor in
            try await NativeReadingRestoreScope.$budget.withValue(first) {
                await Task.yield()
                try NativeReadingRestoreScope.budget?.consume()
            }
        }
        let b = Task { @MainActor in
            try await NativeReadingRestoreScope.$budget.withValue(second) {
                try NativeReadingRestoreScope.budget?.consume()
                await Task.yield()
                try NativeReadingRestoreScope.budget?.consume()
            }
        }
        try await a.value; try await b.value
        XCTAssertEqual(first.remaining, 0); XCTAssertEqual(second.remaining, 0)
        XCTAssertNil(NativeReadingRestoreScope.budget)
    }

    func testFailedRestoreReleasesScopeAndCannotRaiseTheThreeReadCeiling() async throws {
        let budget = NativeProviderReadBudget(limit: 100)
        do {
            try await NativeReadingRestoreScope.$budget.withValue(budget) {
                await Task.yield()
                for _ in 0..<4 { try NativeReadingRestoreScope.budget?.consume() }
            }
            XCTFail("The fourth provider read must be refused.")
        } catch { XCTAssertEqual(error as? NativeReadingRestoreError, .limitReached) }
        XCTAssertEqual(budget.remaining, 0)
        XCTAssertNil(NativeReadingRestoreScope.budget)
    }
}
