import XCTest
@testable import FocusFeedNextNative

@MainActor final class NativeReadingRestoreTests: XCTestCase {
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
                for _ in 0..<4 { try NativeReadingRestoreScope.budget?.consume() }
            }
            XCTFail("The fourth provider read must be refused.")
        } catch { XCTAssertEqual(error as? NativeReadingRestoreError, .limitReached) }
        XCTAssertEqual(budget.remaining, 0)
        XCTAssertNil(NativeReadingRestoreScope.budget)
    }
}
