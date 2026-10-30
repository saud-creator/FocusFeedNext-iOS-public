import Foundation

/// This actor's executor keeps synchronous FFI/database work away from UIKit.
actor CoreRepository {
    private let native: NativeCore
    private init(native: NativeCore) { self.native = native }
    static func open() async throws -> CoreRepository {
        // Match dirs::data_dir() on iOS, used by the preceding application.
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = base.appendingPathComponent("FocusFeedNext", isDirectory: true)
        let native = try await Task.detached(priority: .userInitiated) { try NativeCore(dataDirectory: directory.path) }.value
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        return CoreRepository(native: native)
    }
    func execute(_ operation: NativeOperation, args: Data, generation: UInt64, revision: UInt64, id: String, deadline: UInt64) throws -> Data {
        guard let text = String(data: args, encoding: .utf8) else { throw AppServiceError(code: "invalid_request", message: "Invalid request.") }
        let request = NativeRequest(requestId: id, accountGeneration: generation, sourceRevision: revision, deadlineMillis: deadline, priority: 1, operation: operation, argumentsJson: text)
        return Data(try native.execute(request: request).utf8)
    }
    nonisolated func cancel(_ id: String) { native.cancelRequest(requestId: id) }
    func shutdown() throws { try native.shutdown() }
}
