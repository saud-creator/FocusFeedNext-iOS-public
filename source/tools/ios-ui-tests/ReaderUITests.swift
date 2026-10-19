import XCTest

final class ReaderUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    func testWelcomeAndRotation() {
        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["Sign in with Twitter"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 30), "Welcome must finish loading without credentials")
        XCTAssertTrue(app.webViews.firstMatch.exists)
        capture("welcome-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(signIn.exists)
        capture("welcome-landscape")
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
