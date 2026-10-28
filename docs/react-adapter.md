# React DOM host bridge: prototype

`@app-mixer/web/react` exports `createReactA2UIComponent(React)`, a small React lifecycle bridge to the existing DOM renderer. Pass the application's own React module; the bridge does not bundle React or implement a separate component catalog. The component accepts a stable `subscribe(receive)` function that sends A2UI messages in order and optionally returns an unsubscribe function, plus required `onAction` and `onError` callbacks.

```jsx
import * as React from 'react';
import {createReactA2UIComponent} from '@app-mixer/web/react';

const A2UI = createReactA2UIComponent(React);
// subscribe should be stable across renders and replay the current surface
// when a new subscriber connects.
function App({subscribe, onAction, onError}) {
  return <A2UI subscribe={subscribe} onAction={onAction} onError={onError} />;
}
```

The bridge creates a renderer after the host mounts, forwards incoming messages and action events, reports invalid messages to `onError`, and unsubscribes and clears the host when the component unmounts or `subscribe` changes. Late messages after cleanup are ignored; unsubscribe failures are sent to `onError` and do not prevent a replacement source from connecting. Hosts must authorize and route actions. A new subscription starts with an empty renderer; the source must replay the current surface and data. Calling the factory during every render changes component identity and resets state, so create it outside the component.

The bridge uses the existing [web renderer](a2ui-renderer.md) and its limited six-component catalog. The current tests exercise the bridge's lifecycle through a simulated React hook host and compare its rendered DOM and action behavior with the native DOM renderer. CI additionally exercises React 19 Strict Mode with a real React DOM runtime, including callback changes and cleanup. These checks do not establish cross-platform parity. Angular, React Native and Flutter adapters, framework integration tests and parity across platforms remain open under P2-01.
