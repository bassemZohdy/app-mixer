# A2UI web renderer: initial subset

`@app-mixer/web` provides a browser DOM renderer and a trusted-code component registry. The adapter accepts A2UI v0.9.1 `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` envelopes for the [App Mixer v1 catalog](../packages/web/catalog/v1/catalog.json), a restricted subset of the v0.9.1 basic catalog. It accepts the basic catalog identifier for backward compatibility but does not support the whole catalog; clients should advertise only the App Mixer catalog. It supports **only** `Text`, `Column`, `Row`, `Card`, `TextField`, and `Button`, with the properties listed below. It must not be advertised as a complete implementation of the basic catalog or protocol. The generated CLI application uses this renderer for its workspace; currently it maps only Text manifest components and reports other component types as unsupported.

| Component | Supported properties (in addition to `id` and `component`) |
| --- | --- |
| Text | `text`: literal string or absolute data path; optional `variant`: h1–h5, body, caption. Text is displayed literally, including Markdown syntax. A bound value that is a finite number or a boolean is shown in its JSON spelling (`3`, `2.5`, `true`; a whole number never gains `.0`); null, a missing path, an object or an array shows nothing. The web, React Native and Flutter renderers behave the same and the shared fixture checks it. |
| Column, Row | `children`: array of component IDs; optional `justify` and `align` flex alignment. |
| Card | `child`: component ID. |
| TextField | Literal `label`, absolute `value.path`, and optional `variant` (`shortText` or `longText`); writes changes to the local model. |
| Button | `child`, optional `variant`, and `action.event` with `name` and optional context containing primitives or absolute data paths. |

The optional `A2UIJsonLines` helper frames decoded JSONL text in order, including messages split across chunks; network transport and UTF-8 decoding remain the caller’s responsibility. Components can arrive incrementally; missing children render as empty placeholders. Data model updates use absolute JSON pointers and create missing object parents; deleting an array element preserves its index. Updates reject unsafe keys, cycles, unsupported values, and structures over 10,000 nodes or 100 levels deep. Text bindings re-render after updates. Built-in components are validated before an update is committed, including components not yet connected to the root. Renderers registered through `ComponentRegistry` are trusted application code, not model-provided code; custom registrations can supply an optional validator as the third argument to `register`. The renderer caps surfaces, stored components, and expanded tree size, and rejects cyclic or excessively deep trees; rendered text uses `textContent`.

Not yet implemented: basic catalog parity, Markdown, templates and relative bindings, additional form components, action functions and validation, theme, `sendDataModel`, and broader protocol conformance coverage. A pinned upstream schema test covers representative lifecycle and action messages. The initial P1-03 renderer is complete for this documented catalog; broader A2UI protocol and basic-catalog coverage remains future work. Renderer parity across other platforms is a separate task.

Example after building the workspaces and serving the compiled module to a browser:

```js
import { A2UIRenderer, APP_MIXER_CATALOG } from './index.js';
const renderer = new A2UIRenderer(document.getElementById('app'));
renderer.apply({version:'v0.9.1', createSurface:{surfaceId:'main', catalogId:APP_MIXER_CATALOG}});
renderer.apply({version:'v0.9.1', updateComponents:{surfaceId:'main', components:[
  {id:'root', component:'Column', children:['greeting']},
  {id:'greeting', component:'Text', text:'Hello'}
]}});
```

Protocol references: [A2UI v0.9.1 quickstart](https://a2ui.org/quickstart/) and [message reference](https://a2ui.org/reference/messages/).

CI also starts a generated app and checks its rendered workspace in headless Chrome. This is a smoke test, not full protocol conformance.

Pass an `onAction` callback as the third argument to `A2UIRenderer` to receive v0.9.1 action messages. Buttons are disabled without a callback. Callbacks from buttons superseded by a component update or surface recreation are ignored. Only explicitly mapped event context is included; actions are never sent to a server by the renderer. The caller must authorize and route actions.

## Variants and stable hooks

The renderers do not impose a theme: colors, borders and fonts belong to the host. Variants and component IDs are exposed so a host can style and select them.

| | Web | React Native | Flutter |
| --- | --- | --- | --- |
| Component ID | `data-component-id` on the component's root element | `testID` | `ValueKey('a2ui:<id>')` |
| Variant | `data-variant` (`h1`-`h5`, `body`, `caption`, `shortText`, `longText`, `default`, `primary`, `borderless`) | `variantStyles={{Button:{primary:...},TextField:{longText:...}}}` prop, applied as `style` | `primary` is Material's filled button; `default` and `borderless` are the text button; `longText` is a multi-line field |

Example (web): `button[data-variant="primary"] { background: #1a56db; color: white }`, or select a component in a test with `[data-component-id="save"]`. Text variants also keep their element or text-theme mapping.

## Data updates

A data-only update (`updateDataModel`, which every keystroke in a `TextField` sends) no longer rebuilds the surface when every rendered component is built in (`Text`, `Column`, `Row`, `Card`, `TextField`, `Button`): the bound `Text` and `TextField` nodes are refreshed in place, so DOM nodes, focus and selection are kept and no element is created. A surface that renders any custom component, or an `updateComponents` message, still rebuilds, because a custom renderer may read any part of the data. `node scripts/bench-renderer.mjs [updates]` measures it on a 998-component surface: about 0.7 ms per update against about 15 ms for a rebuild on the development machine (about 20 times faster). The React Native and Flutter stores still re-snapshot the tree on every update.
