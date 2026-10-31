import XCTest

/// Runs the real native welcome/settings path. These tests do not provide
/// fabricated provider content or establish live sign-in/media acceptance.
final class ReaderNativeUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    private func launch(language: String = "en", largeText: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "ar" ? "ar_SA" : "en_US"]
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch(); return app
    }
    func testWelcomeHasNativeControlsAndNoReaderTabsBeforeSignIn() throws {
        let app = launch()
        let signIn = app.buttons["welcome.signIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20), "A fresh test installation must settle into the welcome state.")
        XCTAssertTrue(signIn.isHittable)
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 44)
        XCTAssertEqual(app.tabBars.count, 0)
        XCTAssertEqual(app.webViews.count, 0, "The private provider engine must not be exposed to accessibility.")
    }
    func testSettingsNavigationAndPreferenceDraftCancel() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 20))
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.isHittable); settings.tap()
        let appearance = app.cells["settings.appearance"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5)); appearance.tap()
        let density = app.cells["setting.density"]
        XCTAssertTrue(density.waitForExistence(timeout: 5)); density.tap()
        app.buttons["Compact"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons["Close"].tap()
        let discard = app.alerts.buttons["Discard changes"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5)); discard.tap()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 5))
        settings.tap(); app.cells["settings.appearance"].tap()
        XCTAssertTrue(app.cells["setting.density"].staticTexts["Comfortable"].exists, "Discard must not persist the draft.")
    }
    func testArabicAccessibilityTextKeepsPrimaryActionsReachable() throws {
        let app = launch(language: "ar", largeText: true)
        let signIn = app.buttons["welcome.signIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20)); XCTAssertTrue(signIn.isHittable)
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 44)
        XCTAssertTrue(app.buttons["الإعدادات"].isHittable)
        app.buttons["الإعدادات"].tap()
        XCTAssertTrue(app.cells["settings.account"].waitForExistence(timeout: 5))
        app.cells["settings.account"].tap()
        XCTAssertTrue(app.staticTexts["تسجيل الدخول إلى X"].waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.navigationBars.buttons["حفظ"].isHittable)
        XCUIDevice.shared.orientation = .portrait
    }
}
