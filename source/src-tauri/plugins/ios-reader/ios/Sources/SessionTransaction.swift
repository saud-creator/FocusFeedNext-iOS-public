import Foundation

enum SessionWriteError: Error { case save, verification, unsupportedRecord }

/// A verified write to the single authoritative session entry. Storage is
/// injected so interrupted writes can be tested without a real account.
final class SessionTransaction {
    private var previous: Data?
    private var pending = false
    func commit(_ data: Data, read: () throws -> Data?, write: (Data) throws -> Void, remove: () throws -> Void) throws {
        guard !pending else { throw SessionWriteError.save }
        previous = try read()
        try write(data)
        pending = true
        do {
            guard try read() == data else { throw SessionWriteError.verification }
        } catch {
            try rollback(write: write, remove: remove)
            throw error
        }
    }
    func rollback(write: (Data) throws -> Void, remove: () throws -> Void) throws {
        guard pending else { return }
        if let previous = previous { try write(previous) } else { try remove() }
        finalize()
    }
    func finalize() { previous = nil; pending = false }
}

enum SessionRecord {
    static func encode(token: String, csrf: String, cookies: [[String: Any]]) throws -> Data {
        guard !token.isEmpty, !csrf.isEmpty, token.count <= 512, csrf.count <= 512 else { throw SessionWriteError.unsupportedRecord }
        return try JSONSerialization.data(withJSONObject: ["version": 1, "authToken": token, "ct0": csrf, "cookies": cookies])
    }
}
