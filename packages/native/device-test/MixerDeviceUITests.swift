import XCTest

final class MixerDeviceUITests: XCTestCase {
  func testBoundFieldAndAction() {
    let app = XCUIApplication()
    app.launch()
    let field = app.textFields["Name"]
    XCTAssertTrue(field.waitForExistence(timeout: 30), "Accessible name field should appear")
    XCTAssertEqual(field.value as? String, "Ada")
    XCTAssertTrue(app.staticTexts["Device heading"].exists)
    XCTAssertTrue(app.staticTexts["First item"].exists)
    XCTAssertTrue(app.staticTexts["Second item"].exists)
    let update = app.buttons["Update data"]
    XCTAssertTrue(update.waitForExistence(timeout: 10))
    update.tap()
    let mirror = app.textFields["Name copy"]
    XCTAssertTrue(mirror.waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Lin")
    XCTAssertEqual(mirror.value as? String, "Lin")
    XCTAssertTrue(app.staticTexts["Lin"].exists)
    let reject = app.buttons["Reject invalid"]
    XCTAssertTrue(reject.waitForExistence(timeout: 10))
    reject.tap()
    XCTAssertTrue(app.staticTexts["Rejected safely"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Device heading"].exists)
    XCTAssertFalse(app.staticTexts["Wrong heading"].exists)
    XCTAssertEqual(field.value as? String, "Lin")
    field.tap()
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "Grace")
    XCTAssertEqual(field.value as? String, "Grace")
    XCTAssertEqual(mirror.value as? String, "Grace")
    XCTAssertTrue(app.staticTexts["Grace"].exists)
    mirror.tap()
    mirror.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "Ada")
    XCTAssertEqual(field.value as? String, "Ada")
    XCTAssertTrue(app.staticTexts["Ada"].exists)
    mirror.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "Grace")
    XCTAssertEqual(field.value as? String, "Grace")
    let save = app.buttons["Save"]
    XCTAssertTrue(save.waitForExistence(timeout: 10))
    XCTAssertTrue(save.isEnabled)
    save.tap()
    XCTAssertTrue(app.staticTexts["Saved Grace"].waitForExistence(timeout: 10))
    XCTAssertFalse(save.isEnabled)

    // The shared accessibility reference replaces the interactive surface.
    app.buttons["Show reference"].tap()
    XCTAssertTrue(app.staticTexts["Account"].waitForExistence(timeout: 10))
    for text in ["Profile", "Contact details", "Preferences", "Advanced", "Body copy", "Small print", "Inside a card"] {
      XCTAssertTrue(app.staticTexts[text].exists, text)
    }
    XCTAssertEqual(app.textFields["Name"].value as? String, "Ada")
    XCTAssertEqual(app.textViews["Notes"].value as? String, "Line one")
    XCTAssertTrue(app.buttons["Save"].isEnabled)
    let heights = ["Account", "Profile", "Contact details", "Body copy", "Small print"].map { app.staticTexts[$0].firstMatch.frame.height }
    XCTAssertEqual(heights, heights.sorted(by: >), "Text heights follow the reference sizes")
    XCTAssertEqual(Set(heights).count, heights.count, "Each size is distinct")
  }
}
