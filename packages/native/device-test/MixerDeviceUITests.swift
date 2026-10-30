import XCTest

final class MixerDeviceUITests: XCTestCase {
  func testBoundFieldAndAction() {
    let app = XCUIApplication()
    app.launch()
    let field = app.textFields["Name"]
    XCTAssertTrue(field.waitForExistence(timeout: 30), "Accessible name field should appear")
    XCTAssertEqual(field.value as? String, "Ada")
    XCTAssertTrue(app.staticTexts["Device heading"].exists)
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "Grace")
    XCTAssertEqual(field.value as? String, "Grace")
    let save = app.buttons["Save"]
    XCTAssertTrue(save.waitForExistence(timeout: 10))
    XCTAssertTrue(save.isEnabled)
    save.tap()
    XCTAssertTrue(app.staticTexts["Saved Grace"].waitForExistence(timeout: 10))
    XCTAssertFalse(save.isEnabled)
  }
}
