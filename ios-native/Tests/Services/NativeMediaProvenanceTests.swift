import XCTest
@testable import FocusFeedNextNative

final class NativeMediaProvenanceTests: XCTestCase {
    func testEqualHTTPStatusRetainsDifferentFailureOrigins() {
        let queue = NativeMediaHTTPFailure(status:503,brokerOrigin:"local_queue",trustedResponse:true)
        let upstream = NativeMediaHTTPFailure(status:503,brokerOrigin:"upstream_http",trustedResponse:true)
        XCTAssertEqual(queue.status,upstream.status)
        XCTAssertEqual(queue.origin,.localQueue)
        XCTAssertEqual(upstream.origin,.upstreamHTTP)
        XCTAssertNotEqual(queue,upstream)
        let rateLimit = NativeMediaHTTPFailure(status:429,brokerOrigin:"upstream_http",trustedResponse:true)
        XCTAssertEqual(rateLimit.origin,.upstreamHTTP)
    }

    func testMissingUnexpectedAndUntrustedOriginsNeverInferFromStatus() {
        for header in [nil,"upstream_http_private_url=https://invalid.example","other"] as [String?] {
            XCTAssertEqual(NativeMediaHTTPFailure(status:429,brokerOrigin:header,trustedResponse:true).origin,.unknown)
        }
        XCTAssertEqual(NativeMediaHTTPFailure(status:429,brokerOrigin:"local_queue",trustedResponse:false).origin,.unknown)
    }

    func testDiagnosticExportPreservesTypedOriginAndStatusWithoutPrivateDetails() {
        let journal = ConnectionJournal()
        journal.record("failure",stage:"media",code:"local_queue",status:503,detail:["url":"http://127.0.0.1/private","secret":"private"])
        journal.record("failure",stage:"media",code:"upstream_http",status:429)
        journal.record("failure",stage:"media",code:"interrupted_body",status:200)
        journal.record("failure",stage:"media",code:"decoder_failure")
        let rows = journal.snapshot()
        XCTAssertEqual(rows.compactMap { $0["code"] as? String },["local_queue","upstream_http","interrupted_body","decoder_failure"])
        XCTAssertEqual(rows[0]["status"] as? Int,503)
        XCTAssertEqual(rows[1]["status"] as? Int,429)
        XCTAssertNil(rows[0]["url"])
        XCTAssertNil(rows[0]["secret"])
    }
}
