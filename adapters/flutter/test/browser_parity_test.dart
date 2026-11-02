@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';
import 'parity_scenario.dart';

void main() {
  test('literal text limit counts Unicode code points', verifyUnicodeTextLimit);
  test('identifier limit counts Unicode code points', verifyUnicodeIdentifierLimit);
  test('text and action context support root bindings', verifyRootValueBindings);
  test('field paths may contain line breaks', verifyLineBreakFieldPath);
  testWidgets('preserves surfaces when nested interactive controls are rejected', verifySurfaceParity);
  testWidgets('surface removal and recreation preserve editing isolation', verifySurfaceEditingIdentity);
  testWidgets('field labels do not include adjacent text in layouts', verifyAdjacentFieldSemantics);
  testWidgets('narrow row remains usable', verifyNarrowRowParity);
  testWidgets('narrow nested row remains usable', verifyNarrowNestedRowParity);
}
