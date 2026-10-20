import XCTest

final class ReaderUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    override func tearDown() {
        print("Reader UI hierarchy: \(XCUIApplication().debugDescription)")
        capture("test-final-state")
        super.tearDown()
    }
    func testWelcomeAndRotation() {
        let app = XCUIApplication()
        app.launchArguments=["-AppleLanguages","(en)","-AppleLocale","en_US"]
        app.launch()
        let signIn = app.buttons["Sign in with Twitter"]
        let ready=signIn.waitForExistence(timeout:30)
        capture("welcome-before-assertion")
        XCTAssertTrue(ready, "Welcome must finish loading without credentials")
        XCTAssertTrue(signIn.isHittable)
        XCTAssertTrue(app.buttons["Settings"].exists)
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
