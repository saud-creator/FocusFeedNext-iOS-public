import XCTest
import UIKit
import AVFoundation
@testable import FocusFeedNextNative

@MainActor final class NativeAppCancellationTests: XCTestCase {
    func testAlreadyCancelledCommandNeverReachesBackend() async throws {
        let services = LateCompletionServices(); services.delayCompletion = false
        let task = Task { try await services.command(.setRead, ["postId": .string("123"), "read": .bool(true)]) }
        task.cancel()
        do { try await task.value; XCTFail("An already cancelled command must not start backend work.") }
        catch is CancellationError {} catch { XCTFail("Expected cancellation, received \(error).") }
        XCTAssertTrue(services.requestIDs.isEmpty)
    }

    func testCancelledReadDoesNotPublishLateSuccessfulResult() async throws {
        let services = LateCompletionServices()
        let task = Task { try await services.call(.runtimeSnapshot, as: Bool.self) }
        try await waitForRequest(services)
        task.cancel()
        services.complete()
        do { _ = try await task.value; XCTFail("A cancelled UI read must reject a late success.") }
        catch is CancellationError {} catch { XCTFail("Expected cancellation, received \(error).") }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(services.cancelledIDs, services.requestIDs)
    }

    func testCancelledCommandDoesNotPublishLateSuccessfulResult() async throws {
        let services = LateCompletionServices()
        let task = Task { try await services.command(.setRead, ["postId": .string("123"), "read": .bool(true)]) }
        try await waitForRequest(services)
        task.cancel()
        services.complete()
        do { try await task.value; XCTFail("A cancelled UI command must not present a late success.") }
        catch is CancellationError {} catch { XCTFail("Expected cancellation, received \(error).") }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(services.cancelledIDs, services.requestIDs)
    }

    private func waitForRequest(_ services: LateCompletionServices) async throws {
        for _ in 0..<100 {
            if services.pending != nil { return }
            await Task.yield()
        }
        throw AppServiceError(code: "fixture_not_started", message: "The controlled operation did not start.")
    }
}

/// This intentionally ignores cancellation until completion, modeling a callback
/// that races a cancelled Swift task. It performs no provider or account action.
@MainActor private final class LateCompletionServices: AppServices {
    let accountGeneration: UInt64 = 1
    let events = AsyncStream<AppEvent> { _ in }
    var requestIDs: [UUID] = []
    var cancelledIDs: [UUID] = []
    var pending: CheckedContinuation<Data, Never>?
    var delayCompletion = true
    func perform(_ request: AppRequest) async throws -> Data {
        requestIDs.append(request.requestID)
        if !delayCompletion { return Data("true".utf8) }
        return await withCheckedContinuation { pending = $0 }
    }
    func complete() { let current = pending; pending = nil; current?.resume(returning: Data("true".utf8)) }
    func cancel(requestID: UUID) { cancelledIDs.append(requestID) }
    func signIn(presenting: UIViewController) async throws -> SessionSnapshot { throw unavailable }
    func mediaURL(for handle: String) async throws -> URL { throw unavailable }
    func imageData(url: String, maxPixelDimension: Int) async throws -> Data { throw unavailable }
    func makePlayer(url: String, owner: UUID) async throws -> AVPlayer { throw unavailable }
    func releasePlayer(owner: UUID) {}
    func presentMedia(_ request: MediaPresentation, from: UIViewController) async throws -> MediaPresentationResult { throw unavailable }
    func recoverMedia() async throws { throw unavailable }
    private var unavailable: AppServiceError { AppServiceError(code: "unexpected_fixture_operation", message: "This fixture only exercises request cancellation.") }
}
