import XCTest

/// Runs the real native welcome/settings path. These tests do not provide
/// fabricated provider content or establish live sign-in/media acceptance.
final class ReaderNativeUITests: XCTestCase {
    // Intel CI can spend more than 20 seconds cold-starting the host app.
    private let coldLaunchTimeout: TimeInterval = 50

    override func setUpWithError() throws { continueAfterFailure = false }
    private func launch(language: String = "en", largeText: Bool = false) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "ar" ? "ar_SA" : "en_US"]
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch(); return app
    }
    func testWelcomeHasNativeControlsAndNoReaderTabsBeforeSignIn() throws {
        let app = launch()
        let signIn = app.buttons["welcome.signIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: coldLaunchTimeout), "A fresh test installation must settle into the welcome state.")
        XCTAssertTrue(signIn.isHittable)
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 44)
        XCTAssertEqual(app.tabBars.count, 0)
        XCTAssertEqual(app.webViews.count, 0, "The private provider engine must not be exposed to accessibility.")
        capture("native-welcome")
    }
    func testSettingsNavigationAndPreferenceDraftCancel() throws {
        let app = launch()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: coldLaunchTimeout))
        let settings = app.buttons["welcome.settings"]
        XCTAssertTrue(settings.isHittable); settings.tap()
        let appearance = app.cells["settings.appearance"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5)); appearance.tap()
        let density = app.cells["setting.density"]
        XCTAssertTrue(density.waitForExistence(timeout: 5)); density.tap()
        let compact = app.descendants(matching: .any).matching(identifier: "setting.choice.density.compact").firstMatch
        XCTAssertTrue(waitUntilHittable(compact), "Density options must be selectable in the grouped list.")
        XCTAssertGreaterThanOrEqual(compact.frame.height, 44)
        compact.tap()
        XCTAssertTrue(density.staticTexts["Compact"].waitForExistence(timeout: 5), "The choice must update the shared draft.")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons["Close"].tap()
        let discard = app.alerts.buttons["Discard changes"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5)); discard.tap()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 5))
        settings.tap(); app.cells["settings.appearance"].tap()
        XCTAssertTrue(app.cells["setting.density"].staticTexts["Comfortable"].exists, "Discard must not persist the draft.")
        capture("native-settings-appearance")
    }
    func testArabicAccessibilityTextKeepsPrimaryActionsReachable() throws {
        let app = launch(language: "ar", largeText: true)
        defer { XCUIDevice.shared.orientation = .portrait }
        let signIn = app.buttons["welcome.signIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: coldLaunchTimeout), "The Arabic welcome screen must load.")
        XCTAssertTrue(waitUntilHittable(signIn), "Sign-in must be visible when the welcome screen opens.")
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 44)
        capture("native-arabic-accessibility-welcome")

        let settings = app.buttons["welcome.settings"]
        if !settings.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(waitUntilHittable(settings), "Settings must be reachable at the largest text size.")
        XCTAssertGreaterThanOrEqual(settings.frame.height, 44)
        settings.tap()
        let account = app.cells["settings.account"]
        XCTAssertTrue(waitUntilHittable(account)); account.tap()
        let signInRow = app.staticTexts["تسجيل الدخول إلى X"]
        XCTAssertTrue(signInRow.waitForExistence(timeout: 5))
        capture("native-arabic-accessibility-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        let window = app.windows.firstMatch
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard window.exists else { return false }
            let frame = window.frame
            return frame.width > frame.height
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 8), .completed, "The app must rotate to landscape.")
        XCTAssertTrue(waitUntilHittable(app.navigationBars.buttons["حفظ"]), "Save must remain reachable after rotation.")
        capture("native-arabic-accessibility-landscape")
    }
    private func waitUntilHittable(_ element: XCUIElement) -> Bool {
        let condition = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        return XCTWaiter.wait(for: [condition], timeout: 6) == .completed
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
