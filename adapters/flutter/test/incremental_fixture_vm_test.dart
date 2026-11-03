@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'parity_scenario.dart' show incrementalMissingChildFixture;

void main() {
  test('Flutter incremental fixture matches the shared JSON fixture', () {
    final json = File('assets/incremental-missing-child.json').readAsStringSync();
    expect(jsonDecode(json), incrementalMissingChildFixture);
  });
}
