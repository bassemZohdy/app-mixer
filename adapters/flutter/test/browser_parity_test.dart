@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';
import 'parity_scenario.dart';

void main() {
  testWidgets('preserves surfaces when nested interactive controls are rejected', verifySurfaceParity);
  testWidgets('narrow row remains usable', verifyNarrowRowParity);
  testWidgets('narrow nested row remains usable', verifyNarrowNestedRowParity);
}
