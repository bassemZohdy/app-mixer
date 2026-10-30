# React Native renderer: initial subset

`@app-mixer/native` provides an initial React Native renderer for **Text, Column, Row, Card, TextField and Button**, plus trusted host-registered extension components. It accepts A2UI v0.9.1 create, incremental component and data-model update, and delete surface messages for the App Mixer catalog or the basic catalog identifier. Only the documented subset is supported; accepting a catalog identifier does not imply full catalog parity.

```jsx
import * as React from 'react';
import {View, Text, TextInput, Pressable} from 'react-native';
import {createReactNativeA2UIComponent} from '@app-mixer/native';

const NativeA2UI = createReactNativeA2UIComponent(React, {View, Text, TextInput, Pressable});
function Screen({subscribe, onError, onAction}) {
  return <NativeA2UI subscribe={subscribe} onError={onError} onAction={onAction} />;
}
```

A stable `subscribe(receive)` supplies ordered messages and may return an unsubscribe function. A new subscriber must receive a replay of the current state. Changing the function resets the renderer; cleanup unsubscribes and ignores late messages. Unsubscribe failures are sent to `onError` without blocking a replacement source. Text is passed as native text, not executed or interpreted as markup. Incoming unsupported messages and components are rejected and reported to `onError`; invalid component updates leave the preceding state intact. Surface, component, depth and expanded-tree limits constrain resource use. The host owns network transport, identity and authorization.

Text supports literals and absolute JSON pointer bindings. Data-model updates support nested paths and array element removal while preserving indices; prototype-sensitive paths and oversized or unsupported data values are rejected. TextField supports a label, short/long text, and updates to a non-root data path. Stale input callbacks are rejected after component replacement or surface recreation. Button emits explicitly selected literal or data-path context to `onAction`; it is disabled without a handler. The host must authorize and route every action. Stale button callbacks are rejected after component replacement or surface recreation. Typography and accessibility are preliminary; headings receive a header role and sizes approximating browser defaults, while native font scaling stays enabled. Exact fonts, margins and typography may differ between platforms. Local tests cover the independent state store, invalid updates and resource limits, and compare supported trees, bindings, field updates, button action context and data updates against the web renderer. CI exercises lifecycle behavior with simulated native primitives and also tests real React Native for Web controls in a simulated DOM, including the field's accessible label and the button's role, name and disabled state. It does not run an iOS or Android application. React Native device tests, Flutter catalog gaps and cross-platform behavioral and visual parity remain open under P2-01. See the [web renderer](a2ui-renderer.md), [React bridge](react-adapter.md) and [Angular bridge](angular-adapter.md).

## Trusted extension components

A host may register static leaf components with `NativeComponentRegistry.register(name, render, validate)`, then pass the registry as the third argument to `createReactNativeA2UIComponent`. Names are lowercase identifiers. The synchronous validator receives an isolated copy of the complete component and must return `true`; it must check every property the renderer relies on. `id` and `component` are reserved for the protocol, and `key`, `ref`, and `children` are rejected. Remaining properties are copied into the React component's props. Extension properties are static values: the native adapter does not automatically interpret their bindings or dispatch their actions. Extension code is trusted host code. Registrations are captured when the component factory is called, so recreate the factory when registrations or approvals change.

For application definitions, `registerDeclaredNativeExtensionComponent` from `@app-mixer/core` connects a host-approved `ExtensionRegistry` entry to a native registry only when the selected definition references its exact owner and declares that component on its page. The host must select a validated published definition, provide the component validator, and recreate the registry when the definition or approvals change. This bridge does not load code from definitions.
