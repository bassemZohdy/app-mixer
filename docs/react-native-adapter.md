# React Native renderer: static prototype

`@app-mixer/native` provides an initial React Native renderer for **Text, Column, Row and Card only**. It accepts A2UI v0.9.1 create, incremental component and data-model update, and delete surface messages for the App Mixer catalog or the basic catalog identifier. Only the documented subset is supported; accepting a catalog identifier does not imply full catalog parity.

```jsx
import * as React from 'react';
import {View, Text} from 'react-native';
import {createReactNativeA2UIComponent} from '@app-mixer/native';

const NativeA2UI = createReactNativeA2UIComponent(React, {View, Text});
function Screen({subscribe, onError}) {
  return <NativeA2UI subscribe={subscribe} onError={onError} />;
}
```

A stable `subscribe(receive)` supplies ordered messages and may return an unsubscribe function. A new subscriber must receive a replay of the current state. Changing the function resets the renderer; cleanup unsubscribes and ignores late messages. Text is passed as native text, not executed or interpreted as markup. Incoming unsupported messages and components are rejected and reported to `onError`; invalid component updates leave the preceding state intact. Surface, component, depth and expanded-tree limits constrain resource use. The host owns network transport, identity and authorization.

Text supports literals and absolute JSON pointer bindings. Data-model updates support nested paths and array element removal while preserving indices; prototype-sensitive paths and oversized or unsupported data values are rejected. TextField, Button and action handling are not implemented. Typography and accessibility are preliminary; headings receive a header role, but variants do not yet match web styles. Local tests cover the independent state store, invalid updates and resource limits, and compare supported static trees, bindings and updates against the web renderer. CI uses real React with simulated native primitives for lifecycle and rendering; it does not run an iOS or Android application. React Native platform tests, Flutter and cross-platform behavioral and visual parity remain open under P2-01. See the [web renderer](a2ui-renderer.md), [React bridge](react-adapter.md) and [Angular bridge](angular-adapter.md).
