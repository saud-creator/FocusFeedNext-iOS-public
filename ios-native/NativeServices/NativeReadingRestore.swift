import Foundation

enum NativeReadingRestoreError: Error, Equatable { case limitReached }

/// One optional launch restoration can issue at most three provider HTTP reads,
/// including engine retries, profile resolution and evicted-body rehydration.
/// Manual navigation runs outside the task-local scope and has no such cap.
final class NativeProviderReadBudget: @unchecked Sendable {
    private let lock = NSLock()
    private var available: Int
    init(limit: Int = 3) { available = min(3, max(0, limit)) }
    var remaining: Int { lock.lock(); defer { lock.unlock() }; return available }
    func consume() throws {
        lock.lock(); defer { lock.unlock() }
        guard available > 0 else { throw NativeReadingRestoreError.limitReached }
        available -= 1
    }
}

enum NativeReadingRestoreScope {
    @TaskLocal static var budget: NativeProviderReadBudget? = nil
}

/// Native HTTP callbacks do not inherit the Swift task-local scope. Retain its
/// budget under the parent engine request through retries, then release it when
/// that request settles. URL authorization remains the transport's responsibility.
@MainActor final class NativeProviderReadGate {
    private struct Binding { let id: UUID; let budget: NativeProviderReadBudget }
    private var parents: [String: Binding] = [:]
    var boundParentCount: Int { parents.count }
    func bind(_ budget: NativeProviderReadBudget?, parentID: String) -> UUID? {
        guard let budget else { return nil }
        let id = UUID(); parents[parentID] = Binding(id: id, budget: budget); return id
    }
    func release(parentID: String, bindingID: UUID?) {
        guard let bindingID, parents[parentID]?.id == bindingID else { return }
        parents.removeValue(forKey: parentID)
    }
    func dispatch(parentID: String, url: URL, method: String, start: () -> Void) throws {
        // Transaction bootstrap HTML/scripts and account mutations are not
        // provider page reads. Every actual API GET, including a retry, is.
        if method == "GET", url.scheme == "https", url.host == "x.com", url.path.hasPrefix("/i/api/") {
            try parents[parentID]?.budget.consume()
        }
        start()
    }
}
