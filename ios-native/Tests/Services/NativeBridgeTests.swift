import XCTest
@testable import FocusFeedNextNative

/// These calls cross the generated Swift/UniFFI boundary into the linked Rust
/// library. Temporary databases contain fixture identity only; no provider or
/// Keychain access occurs.
final class NativeBridgeTests: XCTestCase {
    private func request(_ operation: NativeOperation, generation: UInt64 = 0, args: String = "{}", id: String = UUID().uuidString) -> NativeRequest {
        NativeRequest(requestId:id, accountGeneration:generation, sourceRevision:0,
                      deadlineMillis:UInt64(Date().timeIntervalSince1970 * 1000) + 30_000,
                      priority:1, operation:operation, argumentsJson:args)
    }
    private func withCore(_ body: (NativeCore) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-bridge-\(UUID().uuidString)", isDirectory:true)
        defer { try? FileManager.default.removeItem(at:directory) }
        let core = try NativeCore(dataDirectory:directory.path)
        defer { try? core.shutdown() }
        try body(core)
    }
    private func assertCode(_ expected: String, _ body: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
        do { try body(); XCTFail("Expected typed bridge failure \(expected)",file:file,line:line) }
        catch NativeError.Operation(let code, _) { XCTAssertEqual(code,expected,file:file,line:line) }
        catch { XCTFail("Expected NativeError.Operation, received \(error)",file:file,line:line) }
    }
    func testExplicitCancellationRejectsOnlyItsRequestAcrossGeneratedBridge() throws {
        try withCore { core in
            let cancelled = request(.getPreferences)
            core.cancelRequest(requestId:cancelled.requestId)
            assertCode("cancelled") { _ = try core.execute(request:cancelled) }
            let preferences = try core.execute(request:request(.getPreferences))
            XCTAssertNotNil(try JSONSerialization.jsonObject(with:Data(preferences.utf8)) as? [String:Any])
            try core.shutdown()
            try core.shutdown()
            assertCode("core_closed") { _ = try core.execute(request:request(.getPreferences)) }
        }
    }
    func testAccountGenerationAndActionPhasesSurviveGeneratedEnumMapping() throws {
        try withCore { core in
            _ = try core.execute(request:request(.setAccount,generation:1,args:#"{"account":{"id":"1","username":"fixture","displayName":"Fixture"}}"#))
            assertCode("stale_request") { _ = try core.execute(request:request(.getPreferences)) }
            let preparation = request(.prepareAction,generation:1,args:#"{"operation":"follow","username":"reader"}"#)
            let result = try core.execute(request:preparation)
            let object = try XCTUnwrap(try JSONSerialization.jsonObject(with:Data(result.utf8)) as? [String:Any])
            let token = try XCTUnwrap(object["token"] as? String)
            let args = String(decoding:try JSONSerialization.data(withJSONObject:["token":token]),as:UTF8.self)
            _ = try core.execute(request:request(.beginAction,generation:1,args:args))
            core.cancelRequest(requestId:preparation.requestId)
            assertCode("action_in_flight") { _ = try core.execute(request:request(.clearSession,generation:1,args:#"{"disconnect":true}"#)) }
            let finishArgs = String(decoding:try JSONSerialization.data(withJSONObject:["token":token,"outcome":"uncertain"]),as:UTF8.self)
            _ = try core.execute(request:request(.finishAction,generation:1,args:finishArgs))
            _ = try core.execute(request:request(.clearSession,generation:1,args:#"{"disconnect":true}"#))
            _ = try core.execute(request:request(.getPreferences,generation:2))
        }
    }
}
