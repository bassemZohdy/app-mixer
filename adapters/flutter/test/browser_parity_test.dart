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
  testWidgets('external updates do not interrupt input composition', verifyInputComposition);
  testWidgets('field labels do not include adjacent text in layouts', verifyAdjacentFieldSemantics);
  testWidgets('narrow row remains usable', verifyNarrowRowParity);
  testWidgets('row spacing modes place children consistently', verifyRowSpacing);
  testWidgets('unresolved row references reserve flex slots until later updates resolve them', verifyIncrementalMissingChildSpacing);
  testWidgets('unresolved column references reserve vertical flex slots until resolved', verifyIncrementalMissingColumnSpacing);
  testWidgets('row cross-axis alignment places children consistently', verifyRowAlignment);
  testWidgets('column cross-axis alignment places children consistently', verifyColumnAlignment);
  testWidgets('narrow nested row remains usable', verifyNarrowNestedRowParity);
}
