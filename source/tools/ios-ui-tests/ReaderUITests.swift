import XCTest

final class ReaderUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false }
    override func tearDown() {
        print("Reader UI hierarchy: \(XCUIApplication().debugDescription)")
        capture("test-final-state")
        super.tearDown()
    }
    private func application() -> XCUIApplication {
        let app = XCUIApplication()
        // Tauri redirects stderr to os_log. XCTest otherwise echoes os_log back
        // to stderr, recursively filling that pipe and blocking UIKit startup.
        // Keep unified logging enabled; disable only its debugger stderr echo.
        app.launchEnvironment["OS_ACTIVITY_DT_MODE"] = "NO"
        return app
    }
    func testWelcomeAndRotation() {
        let app = application()
        app.launchArguments=["-AppleLanguages","(en)","-AppleLocale","en_US"]
        app.launch()
        let signIn = app.buttons["Sign in with Twitter"]
        let ready=signIn.waitForExistence(timeout:30)
        capture("welcome-before-assertion")
        XCTAssertTrue(ready, "Welcome must finish loading without credentials")
        XCTAssertTrue(signIn.isHittable)
        XCTAssertTrue(app.buttons["Settings"].exists)
        XCTAssertEqual(app.tabBars.count, 0, "Welcome must not retain reader navigation")
        capture("welcome-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(signIn.exists)
        capture("welcome-landscape")
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }
    private func fixture(_ scenario:String)->XCUIApplication {
        let app=application()
        app.launchEnvironment["FFN_UI_TEST_SCENARIO"]=scenario
        app.launch()
        XCTAssertTrue(app.staticTexts["Simulator fixture reader"].waitForExistence(timeout:30))
        XCTAssertTrue(app.staticTexts["First content painted within 250 ms"].waitForExistence(timeout:5))
        return app
    }
    func testWelcomeFailureRetryCancellationAndResume() {
        let app=application()
        app.launchEnvironment["FFN_UI_TEST_SCENARIO"]="authentication"
        app.launch()
        let signIn=app.buttons["Sign in with Twitter"]
        XCTAssertTrue(signIn.waitForExistence(timeout:30));signIn.tap()
        let retry=app.buttons["Retry sign-in"]
        XCTAssertTrue(retry.waitForExistence(timeout:5))
        XCUIDevice.shared.press(.home);app.activate()
        XCTAssertTrue(retry.waitForExistence(timeout:5));retry.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout:5));XCTAssertTrue(signIn.isEnabled)
        XCTAssertEqual(app.buttons.matching(identifier:"Sign in with Twitter").count,1)
        XCTAssertEqual(app.tabBars.count,0)
        capture("welcome-failure-retry-cancel-resume")
        app.terminate()
    }
    func testPhotoSafeAreaPagingZoomAndNavigationLifecycle() {
        let app=fixture("photos")
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        XCTAssertEqual(app.tabBars.count,1)
        XCTAssertLessThan(app.tabBars.firstMatch.frame.height,110,"Only one native navigation layer may occupy the bottom")
        app.buttons["Open image: Fixture photograph"].tap()
        let close=app.navigationBars.buttons.matching(identifier:"Close").firstMatch
        XCTAssertTrue(close.waitForExistence(timeout:10))
        XCTAssertGreaterThanOrEqual(close.frame.minY,app.statusBars.firstMatch.frame.maxY)
        capture("native-photo-safe-area")
        let photograph=app.images["native-photo-image"]
        XCTAssertTrue(photograph.waitForExistence(timeout:10),"The native viewer must decode the actual fixture image")
        photograph.doubleTap();photograph.pinch(withScale:0.5,velocity:-1)
        photograph.doubleTap() // Return to fit before handing the swipe to the pager.
        app.swipeLeft()
        XCTAssertTrue(app.navigationBars.staticTexts["2 / 2"].waitForExistence(timeout:5))
        capture("native-photo-next-page")
        close.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        app.buttons["Open image: Fixture photograph"].tap()
        XCTAssertTrue(app.images["native-photo-image"].waitForExistence(timeout:10),"A dismissed viewer must release ownership for the next presentation")
        app.navigationBars.buttons.matching(identifier:"Close").firstMatch.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        XCTAssertTrue(app.buttons["Retry image"].waitForExistence(timeout:10),"The failed inline fixture must settle into recovery")
        app.buttons["Return to welcome"].tap()
        XCTAssertTrue(app.staticTexts["Fixture welcome without reader navigation"].waitForExistence(timeout:5))
        XCTAssertEqual(app.tabBars.count,0)
        capture("welcome-after-reader")
        app.terminate()
    }
    func testNativeVideoDismissalAndRotation() {
        let app=fixture("video")
        app.buttons["Play"].firstMatch.tap()
        app.buttons["Full screen"].firstMatch.tap()
        // AVKit owns the controls and dismissal, including the system Done button.
        let done=app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout:10))
        XCUIDevice.shared.press(.home);app.activate()
        XCUIDevice.shared.orientation = .landscapeLeft
        capture("native-video-landscape")
        done.tap()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        app.terminate()
    }
    func testFailedAccountsSettleAndRetry() {
        let app=fixture("accounts")
        XCTAssertTrue(app.staticTexts["Fixture connection interrupted"].waitForExistence(timeout:5))
        XCTAssertFalse(app.staticTexts["Loading the people you follow…"].exists)
        app.buttons["Retry"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["No accounts found"].waitForExistence(timeout:5))
        capture("accounts-retry-completed")
        app.terminate()
    }
    func testArabicAndLargeText() {
        for scenario in ["arabic","large-text"] {
            let app=fixture(scenario)
            XCTAssertEqual(app.tabBars.count,1)
            capture(scenario+"-portrait")
            XCUIDevice.shared.orientation = .landscapeLeft
            capture(scenario+"-landscape")
            XCUIDevice.shared.orientation = .portrait
            app.terminate()
        }
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
