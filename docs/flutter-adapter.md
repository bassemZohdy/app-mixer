# Flutter renderer: static prototype

`adapters/flutter` contains a Flutter package with an initial A2UI v0.9.1 renderer for literal Text, Column, Row and Card. It accepts create, incremental component update and delete surface messages for the App Mixer catalog or the basic catalog identifier. Accepting a catalog identifier does not imply support for the full catalog.

A host supplies `AppMixerA2UI` with `subscribe`, a function that receives a message callback and may return an unsubscribe callback, and `onError`. A new subscription must replay the current state. The widget unsubscribes on replacement or disposal and ignores late messages. Updates are validated and applied atomically, with limits on surfaces, components, tree depth and expanded size. Incoming text is rendered as text and never executed.

This prototype does not support data-model updates, bindings, TextField, Button, actions, or the full web catalog. Typography and layout parity are not complete: explicit `stretch` alignment is rejected and the default cross-axis alignment is centered to avoid unbounded layout errors. Platform integration and accessibility testing remain future work. P2-01 remains open until Flutter and React Native cover the supported web catalog and cross-platform parity is verified.

The Flutter workflow runs only for pull requests changing the Flutter package or its workflow. It downloads the pinned Flutter SDK and verifies its published SHA-256, then runs `flutter analyze` and widget tests. On a machine with Flutter 3.35.5 installed, run `flutter pub get`, `flutter analyze`, and `flutter test` from `adapters/flutter`.
