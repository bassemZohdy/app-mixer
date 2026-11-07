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
    for text in ["3", "2.5", "4", "true", "false"] {
      XCTAssertTrue(app.staticTexts[text].firstMatch.exists, "bound scalar " + text)
    }
    // Component IDs are exposed as testID, which iOS reports as the accessibility identifier.
    for component in ["h1", "h2", "body", "name", "notes", "save", "stat-count"] {
      XCTAssertTrue(app.descendants(matching: .any)[component].firstMatch.exists, "testID hook " + component)
    }
    XCTAssertEqual(app.textFields["Name"].value as? String, "Ada")
    XCTAssertEqual(app.textViews["Notes"].value as? String, "Line one")
    XCTAssertTrue(app.buttons["Save"].isEnabled)
    let heights = ["Account", "Profile", "Contact details", "Body copy", "Small print"].map { app.staticTexts[$0].firstMatch.frame.height }
    XCTAssertEqual(heights, heights.sorted(by: >), "Text heights follow the reference sizes")
    XCTAssertEqual(Set(heights).count, heights.count, "Each size is distinct")

    // Row `justify` places a label at the start, the centre and the end of the screen width.
    app.buttons["Show layout"].tap()
    let start = app.staticTexts["Row start"], center = app.staticTexts["Row center"], end = app.staticTexts["Row end"]
    XCTAssertTrue(start.waitForExistence(timeout: 10))
    XCTAssertTrue(center.exists && end.exists)
    let width = app.windows.firstMatch.frame.width
    XCTAssertLessThan(start.frame.minX, center.frame.minX)
    XCTAssertLessThan(center.frame.minX, end.frame.minX)
    XCTAssertLessThanOrEqual(start.frame.minX, width * 0.1, "start label sits at the leading edge")
    XCTAssertGreaterThanOrEqual(end.frame.maxX, width * 0.9, "end label sits at the trailing edge")
    XCTAssertEqual(center.frame.midX, width / 2, accuracy: width * 0.1, "centre label sits in the middle")
  }
}
