import Foundation

extension NativeHostService {
    /// Private compatibility surface for Rust's existing transport protocol.
    /// Provider faults remain encoded so Rust can preserve their typed provenance.
    @MainActor func call(command: String, argumentsJSON: String = "{}") async throws -> String {
        guard let data = argumentsJSON.data(using: .utf8), data.count <= 262144 else { throw NativeServiceError.unavailable }
        let cancellation = NativeInvocationCancellation()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let invocation = NativeInvocation(arguments: data) { result in
                    do {
                        let value = try result.get()
                        let encoded = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
                        guard let text = String(data: encoded, encoding: .utf8) else { throw NativeServiceError.unavailable }
                        continuation.resume(returning: text)
                    } catch { continuation.resume(throwing: error) }
                }
                cancellation.install(invocation) { [weak self] in
                    Task { @MainActor in self?.cancelCall(command: command, arguments: data) }
                }
                guard !cancellation.isCancelled else { return }
                do { try self.dispatch(command, invocation: invocation) }
                catch { invocation.fail(NativeServiceError.unavailable) }
            }
        }, onCancel: { cancellation.cancel() })
    }

    @MainActor private func dispatch(_ command: String, invocation: NativeInvocation) throws {
        if ["login", "request", "commit", "recoverLogin"].contains(command) { try ensureTransportAttached() }
        switch command {
        case "login": login(invocation)
        case "waitForLoginActive": waitForLoginActive(invocation)
        case "endLogin": try endLogin(invocation)
        case "recoverLogin": try recoverLogin(invocation)
        case "commit": commit(invocation)
        case "rollback": rollback(invocation)
        case "finalize": finalize(invocation)
        case "migrateSession": try migrateSession(invocation)
        case "logout": logout(invocation)
        case "request": try request(invocation)
        case "cancelReads": try cancelReads(invocation)
        case "runtime": runtime(invocation)
        case "connectionMetrics": connectionMetrics(invocation)
        case "connectionDiagnostics": connectionDiagnostics(invocation)
        case "shareConnectionReport": shareConnectionReport(invocation)
        case "openExternal": try openExternal(invocation)
        case "openProfile": try openProfile(invocation)
        case "sharePreferences": try sharePreferences(invocation)
        case "presentMedia": try presentMedia(invocation)
        case "dismissMedia": dismissMedia(invocation)
        default: throw NativeServiceError.unavailable
        }
    }

    @MainActor private func cancelCall(command: String, arguments: Data) {
        if command == "login" || command == "recoverLogin" { cancelSignIn(); return }
        guard command == "request", let request = try? JSONDecoder().decode(NativeProviderRequest.self, from: arguments) else { return }
        cancelRequest(id: request.context.id)
    }

    @MainActor func beginLogin() async throws -> NativeSessionCandidate { try await decoded("login") }
    @MainActor func commitCandidate() async throws -> NativeSessionCandidate { try await loginTransactionStep("commit") }
    @MainActor func finalizeLogin() async throws { let _: EmptyNativeResponse = try await loginTransactionStep("finalize") }
    @MainActor func rollbackLogin() async throws { let _: EmptyNativeResponse = try await decoded("rollback") }
    @MainActor func logout() async throws { let _: EmptyNativeResponse = try await decoded("logout") }
    /// Invoke only after the repository verified the saved candidate through Me.
    /// Legacy records remain readable until the versioned record is verified.
    @MainActor func migrateSavedCandidate(_ candidate: NativeSessionCandidate) async throws {
        let args = try JSONEncoder().encode(candidate)
        guard let text = String(data: args, encoding: .utf8) else { throw NativeServiceError.unavailable }
        let _: EmptyNativeResponse = try await decoded("migrateSession", arguments: text)
    }
    @MainActor func cancelReads(beforeGeneration: UInt64? = nil) async {
        let args = beforeGeneration.map { "{\"beforeGeneration\":\($0)}" } ?? "{}"
        _ = try? await call(command: "cancelReads", argumentsJSON: args)
    }
    @MainActor func request(_ request: NativeProviderRequest) async throws -> NativeProviderResponse {
        var current = request
        var transportRetried = false
        let write = ["Follow", "Unfollow", "DeleteBookmark"].contains(request.operation)
        while true {
            try Task.checkCancellation()
            let encoded = try JSONEncoder().encode(current)
            guard let args = String(data: encoded, encoding: .utf8) else { throw NativeServiceError.unavailable }
            do { return try await decoded("request", arguments: args) }
            catch let error as NativeServiceError {
                if error.code == "background_paused", current.context.authentication, !write {
                    let _: EmptyNativeResponse = try await decoded("waitForLoginActive")
                    let context = current.context
                    current = NativeProviderRequest(operation: current.operation, variables: current.variables, authToken: current.authToken, ct0: current.ct0,
                        context: NativeRequestContext(id: context.id, generation: context.generation, priority: context.priority,
                            deadline: UInt64(Date().timeIntervalSince1970 * 1000) + 75_000, authentication: true))
                    continue
                }
                if error.code == "transport_initialization", !write, !transportRetried {
                    transportRetried = true
                    continue
                }
                throw error
            }
        }
    }
    @MainActor private func loginTransactionStep<T: Decodable>(_ command: String) async throws -> T {
        while true {
            try Task.checkCancellation()
            let _: EmptyNativeResponse = try await decoded("waitForLoginActive")
            do { return try await decoded(command) }
            catch let error as NativeServiceError where error.code == "background_paused" { continue }
        }
    }
    @MainActor private func decoded<T: Decodable>(_ command: String, arguments: String = "{}") async throws -> T {
        let result = try await call(command: command, argumentsJSON: arguments)
        let data = Data(result.utf8)
        if let wrapper = try? JSONDecoder().decode(NativeFaultEnvelope.self, from: data) { throw wrapper.fault }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct EmptyNativeResponse: Decodable {}
private struct NativeFaultEnvelope: Decodable { let fault: NativeServiceError }

private final class NativeInvocationCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var invocation: NativeInvocation?
    private var onCancel: (() -> Void)?
    private var cancelled = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func install(_ invocation: NativeInvocation, onCancel: @escaping () -> Void) {
        lock.lock()
        self.invocation = invocation; self.onCancel = onCancel
        let cancelNow = cancelled
        lock.unlock()
        if cancelNow { invocation.fail(CancellationError()); onCancel() }
    }
    func cancel() {
        lock.lock(); cancelled = true
        let current = invocation; let action = onCancel
        lock.unlock()
        current?.fail(CancellationError()); action?()
    }
}
