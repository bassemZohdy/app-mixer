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
    let advance = app.buttons["Advance surface"]
    XCTAssertTrue(advance.waitForExistence(timeout: 10))
    advance.tap()
    XCTAssertTrue(app.staticTexts["Secondary Ada"].waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Grace")
    advance.tap()
    XCTAssertTrue(app.staticTexts["Secondary Ada"].waitForNonExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "Grace")
    advance.tap()
    XCTAssertTrue(app.staticTexts["Secondary Grace"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["Secondary Ada"].exists)
    XCTAssertEqual(field.value as? String, "Grace")
    let layout = app.buttons["Check narrow layout"]
    XCTAssertTrue(layout.waitForExistence(timeout: 10))
    layout.tap()
    let labels = ["A long nested column label needs to wrap", "A long nested card label needs to wrap", "A long nested row label needs to wrap"]
    let elements = labels.map { label -> XCUIElement in
      let matches = app.staticTexts.matching(identifier: label)
      XCTAssertTrue(matches.firstMatch.waitForExistence(timeout: 10))
      // React Native can expose a matching text wrapper as well as its leaf.
      return matches.element(boundBy: max(0, matches.count - 1))
    }
    let left = elements[0].frame.minX
    for element in elements {
      XCTAssertGreaterThan(element.frame.width, 0)
      XCTAssertGreaterThan(element.frame.height, 20)
      XCTAssertGreaterThanOrEqual(element.frame.minX, left - 1)
      XCTAssertLessThanOrEqual(element.frame.maxX, left + 241)
    }
    XCTAssertLessThanOrEqual(elements[0].frame.maxX, elements[1].frame.minX + 1)
    XCTAssertLessThanOrEqual(elements[1].frame.maxX, elements[2].frame.minX + 1)
    let identity = app.buttons["Check surface identity"]
    XCTAssertTrue(identity.waitForExistence(timeout: 10))
    identity.tap()
    XCTAssertTrue(app.staticTexts.matching(identifier: "Mount 1").firstMatch.waitForExistence(timeout: 10))
    let replace = app.buttons["Replace test surface"]
    XCTAssertTrue(replace.waitForExistence(timeout: 10))
    replace.tap()
    XCTAssertTrue(app.staticTexts.matching(identifier: "Mount 2").firstMatch.waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts.matching(identifier: "Mount 1").firstMatch.exists)
    let multiline = app.buttons["Check multiline input"]
    XCTAssertTrue(multiline.waitForExistence(timeout: 10))
    multiline.tap()
    let notes = app.textViews["Notes"]
    XCTAssertTrue(notes.waitForExistence(timeout: 10))
    notes.tap()
    notes.typeText("First\nSecond")
    XCTAssertEqual(notes.value as? String, "First\nSecond")
    let saveNote = app.buttons["Save note"]
    XCTAssertTrue(saveNote.waitForExistence(timeout: 10))
    saveNote.tap()
    XCTAssertTrue(app.staticTexts["Saved multiline note"].waitForExistence(timeout: 10))
  }
}
