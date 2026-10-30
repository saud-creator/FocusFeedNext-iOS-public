import Foundation

enum NativeRecoveryError: Error { case timeout }

/// A bounded async result. Expiry settles the caller immediately, explicitly
/// cancels underlying work, and refuses late completion. It never replays writes.
@MainActor final class NativeActiveDeadline<Value> {
    private var budget: ActiveTimeBudget
    private var active: Bool
    private var continuation: CheckedContinuation<Value, Error>?
    private var work: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var settled = false
    init(seconds: TimeInterval = 30, active: Bool) { budget = ActiveTimeBudget(limit: seconds); self.active = active }
    func setActive(_ active: Bool) {
        _ = budget.update(now: ProcessInfo.processInfo.systemUptime, active: active)
        self.active = active
    }
    func run(_ operation: @escaping () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !settled else { continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                _ = self.budget.update(now: ProcessInfo.processInfo.systemUptime, active: self.active)
                self.work = Task { @MainActor in
                    do { self.finish(.success(try await operation())) }
                    catch { self.finish(.failure(error)) }
                }
                self.timer = Task { @MainActor in
                    while !Task.isCancelled {
                        do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
                        if self.budget.update(now: ProcessInfo.processInfo.systemUptime, active: self.active) {
                            self.finish(.failure(NativeRecoveryError.timeout)); return
                        }
                    }
                }
            }
        }, onCancel: { Task { @MainActor in self.cancel() } })
    }
    func cancel() { finish(.failure(CancellationError())) }
    private func finish(_ result: Result<Value, Error>) {
        guard !settled else { return }; settled = true
        let continuation = self.continuation; self.continuation = nil
        work?.cancel(); timer?.cancel(); work = nil; timer = nil
        continuation?.resume(with: result)
    }
}

/// One foreground/path opportunity after route flapping settles. A caller owns
/// the actual read-only repairs and chooses only visible affected media.
@MainActor final class NativeRecoveryDebouncer {
    private var pending: Task<Void, Never>?
    func submit(_ action: @escaping () -> Void) {
        pending?.cancel()
        pending = Task { @MainActor in
            do { try await Task.sleep(nanoseconds: 750_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            action(); self.pending = nil
        }
    }
    func cancel() { pending?.cancel(); pending = nil }
}
