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
        // A storage adapter can fail after changing its record. Mark ownership
        // before writing so that every failed write has a restoration path.
        pending = true
        do {
            try write(data)
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
    struct Candidate: Equatable {
        let token: String
        let csrf: String
    }
    static func decode(_ data: Data) throws -> Candidate {
        guard data.count <= 262144 else { throw SessionWriteError.unsupportedRecord }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            guard object["version"] as? Int == 1,
                  let token = object["authToken"] as? String,
                  let csrf = object["ct0"] as? String else { throw SessionWriteError.unsupportedRecord }
            return try candidate(token: token, csrf: csrf)
        }
        // The old Rust keyring backend stored the primary pair as two lines.
        guard let text = String(data: data, encoding: .utf8),
              let split = text.firstIndex(of: "\n") else { throw SessionWriteError.unsupportedRecord }
        return try candidate(token: String(text[..<split]), csrf: String(text[text.index(after: split)...]))
    }
    static func candidate(token: String, csrf: String) throws -> Candidate {
        let safe: (String) -> Bool = { value in
            !value.isEmpty && value.utf8.count <= 512 && value.utf8.allSatisfy {
                ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 || $0 == 37
            }
        }
        guard safe(token), safe(csrf) else { throw SessionWriteError.unsupportedRecord }
        return Candidate(token: token, csrf: csrf)
    }
    static func encode(token: String, csrf: String, cookies: [[String: Any]]) throws -> Data {
        _ = try candidate(token: token, csrf: csrf)
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "authToken": token, "ct0": csrf, "cookies": cookies])
        guard data.count <= 262144 else { throw SessionWriteError.unsupportedRecord }
        return data
    }
}
