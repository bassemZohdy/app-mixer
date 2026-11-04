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
    let repeatButton = app.buttons["Check repeated fields"]
    XCTAssertTrue(repeatButton.waitForExistence(timeout: 10))
    repeatButton.tap()
    let repeated = app.textFields.matching(identifier: "Repeated")
    XCTAssertTrue(repeated.element(boundBy: 1).waitForExistence(timeout: 10))
    XCTAssertEqual(repeated.count, 2)
    let firstRepeated = repeated.element(boundBy: 0)
    let secondRepeated = repeated.element(boundBy: 1)
    XCTAssertEqual(firstRepeated.value as? String, "Ada")
    let marker = app.staticTexts.matching(identifier: "Reorder marker").firstMatch
    XCTAssertTrue(marker.waitForExistence(timeout: 10))
    XCTAssertLessThan(firstRepeated.frame.minY, marker.frame.minY)
    XCTAssertLessThan(marker.frame.minY, secondRepeated.frame.minY)
    firstRepeated.tap()
    firstRepeated.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "Grace")
    XCTAssertEqual(secondRepeated.value as? String, "Grace")
    let reorder = app.buttons["Reorder fields"]
    XCTAssertTrue(reorder.waitForExistence(timeout: 10))
    reorder.tap()
    XCTAssertEqual(repeated.count, 2)
    XCTAssertLessThan(marker.frame.minY, firstRepeated.frame.minY)
    XCTAssertLessThan(firstRepeated.frame.minY, secondRepeated.frame.minY)
    XCTAssertEqual(firstRepeated.value as? String, "Grace")
    XCTAssertEqual(secondRepeated.value as? String, "Grace")
    secondRepeated.tap()
    secondRepeated.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "Lin")
    XCTAssertEqual(firstRepeated.value as? String, "Lin")
    let signed = app.buttons["Check signed extension"]
    XCTAssertTrue(signed.waitForExistence(timeout: 10))
    signed.tap()
    XCTAssertTrue(app.staticTexts["Verified signed extension"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Tampered plan rejected"].waitForExistence(timeout: 10))
    let incremental = app.buttons["Check incremental layout"]
    XCTAssertTrue(incremental.waitForExistence(timeout: 10))
    incremental.tap()
    let textElement: (String) -> XCUIElement = { label in
      let matches = app.staticTexts.matching(NSPredicate(format: "label == %@", label))
      XCTAssertTrue(matches.firstMatch.waitForExistence(timeout: 10), "Missing text: \(label)")
      return matches.element(boundBy: max(0, matches.count - 1))
    }
    for (hostID, prefix) in [("ltr-layout-host", "LTR"), ("rtl-layout-host", "RTL")] {
      let host = app.descendants(matching: .any).matching(identifier: hostID).firstMatch
      let left = textElement("\(prefix) Left")
      let right = textElement("\(prefix) Right")
      XCTAssertTrue(host.waitForExistence(timeout: 10))
      XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label == %@", "\(prefix) Middle")).firstMatch.exists)
      if prefix == "LTR" { XCTAssertLessThan(left.frame.minX, right.frame.minX) }
      else { XCTAssertGreaterThan(left.frame.minX, right.frame.minX) }
      let visible = [("Left", left.frame), ("Right", right.frame)].sorted { $0.1.minX < $1.1.minX }
      let expectedOrder = prefix == "LTR" ? ["Left", "Right"] : ["Right", "Left"]
      XCTAssertEqual(visible.map(\.0), expectedOrder)
      let remaining = host.frame.width - visible.reduce(0) { $0 + $1.1.width }
      let expectedOuter = remaining / 6 // space-around with three slots, including the empty child
      XCTAssertEqual(visible[0].1.minX - host.frame.minX, expectedOuter, accuracy: 3, "\(prefix) unresolved leading slot spacing")
      XCTAssertEqual(host.frame.maxX - visible[1].1.maxX, expectedOuter, accuracy: 3, "\(prefix) unresolved trailing slot spacing")
    }
    let resolveMissing = app.buttons["Resolve missing child"]
    XCTAssertTrue(resolveMissing.waitForExistence(timeout: 10))
    resolveMissing.tap()
    for (hostID, prefix) in [("ltr-layout-host", "LTR"), ("rtl-layout-host", "RTL")] {
      let host = app.descendants(matching: .any).matching(identifier: hostID).firstMatch
      let labels = [textElement("\(prefix) Left"), textElement("\(prefix) Middle"), textElement("\(prefix) Right")]
      let orderedLabels = labels.sorted { $0.frame.minX < $1.frame.minX }
      let expectedOrder = prefix == "LTR" ? ["Left", "Middle", "Right"] : ["Right", "Middle", "Left"]
      XCTAssertEqual(orderedLabels.map(\.label), expectedOrder.map { "\(prefix) \($0)" })
      let ordered = orderedLabels.map(\.frame)
      let remaining = host.frame.width - ordered.reduce(0) { $0 + $1.width }
      XCTAssertEqual(ordered[0].minX - host.frame.minX, remaining / 6, accuracy: 3, "\(prefix) resolved outer spacing")
      XCTAssertEqual(ordered[2].maxX - host.frame.maxX, -remaining / 6, accuracy: 3, "\(prefix) resolved outer spacing")
      XCTAssertEqual(ordered[1].minX - ordered[0].maxX, remaining / 3, accuracy: 3, "\(prefix) resolved first gap")
      XCTAssertEqual(ordered[2].minX - ordered[1].maxX, remaining / 3, accuracy: 3, "\(prefix) resolved second gap")
    }
  }
}
