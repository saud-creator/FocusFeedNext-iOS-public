import Foundation

/// Values crossing the private provider boundary. Never print credential-bearing requests.
enum NativeJSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([NativeJSONValue]), object([String: NativeJSONValue])
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode([NativeJSONValue].self) { self = .array(decoded) }
        else { self = .object(try value.decode([String: NativeJSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let decoded): try value.encode(decoded)
        case .number(let decoded): try value.encode(decoded)
        case .string(let decoded): try value.encode(decoded)
        case .array(let decoded): try value.encode(decoded)
        case .object(let decoded): try value.encode(decoded)
        }
    }
}

struct NativeServiceError: Error, LocalizedError, Codable, Equatable {
    let code: String
    let stage: String
    var retryable: Bool = false
    var httpStatus: Int? = nil
    var requestId: String? = nil
    var errorDescription: String? { ConnectionFault.loginMessage(code, arabic: Locale.preferredLanguages.first?.hasPrefix("ar") == true) }
    static let cancelled = NativeServiceError(code: "cancelled", stage: "queue")
    static let unavailable = NativeServiceError(code: "bridge_failure", stage: "bridge")
}

/// Restricted to the repository/session layer; it must never be exposed by a screen model.
struct NativeSessionCandidate: Codable {
    let authToken: String
    let ct0: String
}

struct NativeRequestContext: Codable {
    let id: String
    let generation: UInt64
    var priority: Int = 1
    let deadline: UInt64
    var authentication: Bool = false
}

struct NativeProviderRequest: Codable {
    let operation: String
    let variables: [String: NativeJSONValue]
    let authToken: String
    let ct0: String
    let context: NativeRequestContext
}

struct NativeProviderResponse: Codable {
    let status: Int
    let body: NativeJSONValue
    let timing: NativeJSONValue?
}

/// Adapter for the extracted transport implementation. The UI never uses string commands.
final class NativeInvocation: NSObject {
    private let arguments: Data
    private let completion: (Result<Any, Error>) -> Void
    private let lock = NSLock()
    private var settled = false
    init(arguments: Data, completion: @escaping (Result<Any, Error>) -> Void) {
        self.arguments = arguments
        self.completion = completion
    }
    func parseArgs<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: arguments) }
    func resolve(_ value: [String: Any] = [:]) { finish(.success(value)) }
    func fail(_ error: Error) { finish(.failure(error)) }
    private func finish(_ result: Result<Any, Error>) {
        lock.lock()
        guard !settled else { lock.unlock(); return }
        settled = true
        lock.unlock()
        completion(result)
    }
}
