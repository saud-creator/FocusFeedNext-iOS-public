import XCTest

final class ReaderUITests: XCTestCase {
    override func setUp() { super.setUp(); continueAfterFailure = false;XCUIDevice.shared.orientation = .portrait }
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
        XCTAssertTrue(app.staticTexts["Fixture page ready"].waitForExistence(timeout:5))
        return app
    }
    func testFirstPagePaintsWithin250Milliseconds() {
        let app=fixture("photos")
        capture("first-page-timing")
        XCTAssertTrue(app.staticTexts["First content painted within 250 ms"].waitForExistence(timeout:5),"Returned first-page content must paint within 250 ms")
        XCTAssertTrue(app.staticTexts["Feed cards do not overlap"].waitForExistence(timeout:5),"Measured media cards must not overlap the next post")
        let timing=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","First content render:")).firstMatch
        if timing.exists {print("Controlled first-page timing: \(timing.label)")}
        app.terminate()
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
        let open=app.buttons["Open image: Fixture photograph"]
        revealAboveTabs(open,in:app);open.tap()
        let close=app.buttons.matching(NSPredicate(format:"identifier == %@ OR label ==[c] %@","native-photo-close","Close")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout:10))
        let photograph=app.images.matching(NSPredicate(format:"identifier == %@ AND label == %@","native-photo-image","Fixture photograph")).firstMatch
        XCTAssertTrue(photograph.waitForExistence(timeout:10),"The native viewer must decode the actual fixture image")
        XCTAssertTrue(app.frame.contains(close.frame))
        XCTAssertFalse(photograph.frame.intersects(close.frame),"Native controls must stay outside the photo's safe viewport")
        if app.statusBars.firstMatch.exists {XCTAssertFalse(close.frame.intersects(app.statusBars.firstMatch.frame))}
        capture("native-photo-safe-area")
        photograph.doubleTap();photograph.pinch(withScale:0.5,velocity:-1)
        photograph.doubleTap() // Return to fit before handing the swipe to the pager.
        app.swipeLeft()
        XCTAssertTrue(app.navigationBars.staticTexts["2 / 2"].waitForExistence(timeout:5))
        capture("native-photo-next-page")
        close.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        revealAboveTabs(open,in:app);open.tap()
        XCTAssertTrue(photograph.waitForExistence(timeout:10),"A dismissed viewer must release ownership for the next presentation")
        close.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        revealAboveTabs(app.staticTexts["Recoverable image failure"].firstMatch,in:app,centered:true)
        XCTAssertTrue(app.buttons["Retry image"].waitForExistence(timeout:10),"The failed inline fixture must settle into recovery")
        revealAboveTabs(app.buttons["Retry image"].firstMatch,in:app)
        let article=app.buttons["Read full article"].firstMatch
        revealAboveTabs(article,in:app);article.tap()
        let chapter=app.staticTexts["Fixture article chapter"].firstMatch
        XCTAssertTrue(chapter.waitForExistence(timeout:5),"An article must show its full content inside the reader")
        revealAboveTabs(chapter,in:app)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@","Complete article paragraph.")).firstMatch.exists)
        capture("native-article-reader")
        let closeArticle=app.buttons["Close article"].firstMatch
        revealAboveTabs(closeArticle,in:app);closeArticle.tap()
        XCTAssertFalse(chapter.exists)
        let welcome=app.buttons["Return to welcome"]
        XCTAssertTrue(welcome.waitForExistence(timeout:5))
        XCTAssertGreaterThanOrEqual(welcome.frame.height,44)
        XCTAssertTrue(app.otherElements["section header"].firstMatch.frame.contains(welcome.frame),"Fixture navigation stays in its sticky header")
        XCTAssertTrue(welcome.isHittable)
        welcome.tap()
        XCTAssertTrue(app.staticTexts["Fixture welcome without reader navigation"].waitForExistence(timeout:5))
        XCTAssertEqual(app.tabBars.count,0)
        capture("welcome-after-reader")
        app.terminate()
    }
    func testNativeVideoDismissalAndRotation() {
        let app=fixture("video")
        let play=app.buttons["Play"].firstMatch
        revealAboveTabs(play,in:app);play.tap()
        let fullScreen=app.buttons["Full screen"].firstMatch
        revealAboveTabs(fullScreen,in:app);fullScreen.tap()
        XCTAssertTrue(app.descendants(matching:.any)["native-video-ready"].waitForExistence(timeout:15),"AVKit must load the actual MP4 fixture")
        // AVKit hides its controls during playback. Reveal them as a person
        // would; the native dismissal label varies across supported iOS releases.
        let player=app.descendants(matching:.any)["native-video-ready"]
        let done=app.buttons.matching(NSPredicate(format:"label ==[c] %@ OR label ==[c] %@","Done","Close")).firstMatch
        if !done.exists {player.tap()}
        XCTAssertTrue(done.waitForExistence(timeout:10))
        XCUIDevice.shared.press(.home);app.activate()
        XCUIDevice.shared.orientation = .landscapeLeft
        capture("native-video-landscape")
        if !done.exists || !done.isHittable {player.tap()}
        done.tap()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        // A completed audio lease must not deactivate the next presentation.
        revealAboveTabs(fullScreen,in:app);fullScreen.tap()
        XCTAssertTrue(app.descendants(matching:.any)["native-video-ready"].waitForExistence(timeout:15),"A dismissed player must allow a fresh playback session")
        if !done.exists || !done.isHittable {app.descendants(matching:.any)["native-video-ready"].tap()}
        XCTAssertTrue(done.waitForExistence(timeout:10));done.tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout:5))
        app.terminate()
    }
    func testFailedAccountsSettleAndRetry() {
        let app=fixture("accounts")
        XCTAssertTrue(app.staticTexts["Fixture connection interrupted"].waitForExistence(timeout:5))
        XCTAssertFalse(app.staticTexts["Loading the people you follow…"].exists)
        let retry=app.buttons["Try again"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout:5))
        XCTAssertGreaterThanOrEqual(retry.frame.height,44)
        revealAboveTabs(retry,in:app);retry.tap()
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
    private func revealAboveTabs(_ element:XCUIElement,in app:XCUIApplication,centered:Bool=false) {
        XCTAssertTrue(element.waitForExistence(timeout:5))
        let header=app.otherElements["section header"].firstMatch
        XCTAssertTrue(header.exists,"The reader's sticky header must define the unobscured viewport")
        let top=max(app.frame.minY,header.frame.maxY)+4
        let bottom=app.tabBars.firstMatch.frame.minY-4
        let height=bottom-top
        let targetBottom=centered ? top+height*0.55 : bottom
        for _ in 0..<8 {
            let rect=element.frame
            if rect.minY>=top && rect.maxY<=targetBottom {
                XCTAssertTrue(element.isHittable,"A control inside the reading viewport must accept touches")
                return
            }
            let distance=rect.minY<top ? min(top-rect.minY+12,height*0.3) : -min(rect.maxY-targetBottom+12,height*0.3)
            let origin=app.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0))
            let start=origin.withOffset(CGVector(dx:0,dy:top-app.frame.minY+height*0.5))
            let end=start.withOffset(CGVector(dx:0,dy:distance))
            // Hold at the end to avoid fling/overshoot around a short target.
            start.press(forDuration:0.05,thenDragTo:end,withVelocity:.slow,thenHoldForDuration:0.2)
        }
        XCTAssertGreaterThanOrEqual(element.frame.minY,top,"Media controls must not remain underneath the sticky header")
        XCTAssertLessThanOrEqual(element.frame.maxY,targetBottom,"Media controls must be reachable above native navigation")
        XCTAssertTrue(element.isHittable,"Revealed controls must accept touches")
    }
}
