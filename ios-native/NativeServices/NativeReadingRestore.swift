import Foundation

enum NativeReadingRestoreError: Error, Equatable { case limitReached }

/// One optional launch restoration can issue at most three provider reads,
/// including profile resolution and evicted-body rehydration inside a page.
/// Manual navigation runs outside the task-local scope and has no such cap.
@MainActor final class NativeProviderReadBudget {
    private(set) var remaining: Int
    init(limit: Int = 3) { remaining = min(3, max(0, limit)) }
    func consume() throws {
        guard remaining > 0 else { throw NativeReadingRestoreError.limitReached }
        remaining -= 1
    }
}

enum NativeReadingRestoreScope {
    @TaskLocal static var budget: NativeProviderReadBudget? = nil
}
