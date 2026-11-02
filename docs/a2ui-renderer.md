# A2UI web renderer: initial subset

`@app-mixer/web` provides a browser DOM renderer and a trusted-code component registry. The adapter accepts A2UI v0.9.1 `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` envelopes for the [App Mixer v1 catalog](../packages/web/catalog/v1/catalog.json), a restricted subset of the v0.9.1 basic catalog. It accepts the basic catalog identifier for backward compatibility but does not support the whole catalog; clients should advertise only the App Mixer catalog. It supports **only** `Text`, `Column`, `Row`, `Card`, `TextField`, and `Button`, with the properties listed below. It must not be advertised as a complete implementation of the basic catalog or protocol. The generated CLI application uses this renderer for its workspace; it maps Text, Input and static Card manifest components and reports other built-in component types as unsupported.

| Component | Supported properties (in addition to `id` and `component`) |
| --- | --- |
| Text | `text`: literal string or absolute data path; optional `variant`: h1–h5, body, caption. Literal text is limited to 10,000 Unicode code points and displayed literally, including Markdown syntax. |
| Column, Row | `children`: array of component IDs; optional `justify` and `align` flex alignment. |
| Card | `child`: component ID. |
| TextField | Literal `label`, absolute `value.path`, and optional `variant` (`shortText` or `longText`); writes changes to the local model. |
| Button | `child`, optional `variant`, and `action.event` with `name` and optional context containing primitives or absolute data paths. |

The optional `A2UIJsonLines` helper frames decoded JSONL text in order, including messages split across chunks; network transport and UTF-8 decoding remain the caller’s responsibility. Component, surface and action identifiers are limited to 256 Unicode code points. Components can arrive incrementally; missing children render as empty placeholders. Text and action-context bindings accept an empty path or `/` for the root value; text fields require a non-root path. For compatibility with A2UI v0.9.1, `/` also replaces the whole model in data updates, so the empty-named root property cannot be addressed on its own. This differs from RFC 6901 JSON Pointer semantics. Field paths may contain line breaks in their segments. Data model updates use absolute JSON pointers and create missing object parents; array updates reject noncanonical or out-of-range indices, including intermediate paths; deleting an array element preserves its index. Updates reject unsafe keys, cycles, unsupported values, and structures over 10,000 nodes or 100 levels deep. Text bindings re-render after updates. When a data update replaces a focused text field, the renderer restores focus and its selection, clamping the selection to the new value. Repeated references to a field remain independently editable and retain focus on the edited occurrence. During input-method composition, data updates are applied to the model and surface rendering is deferred until composition ends. Actions use the updated model immediately; the composed field value wins if an external update changes that same path. A component update or surface deletion can still interrupt composition. Built-in components are validated before an update is committed, including components not yet connected to the root. Renderers registered through `ComponentRegistry` are trusted application code, not model-provided code; custom registrations can supply an optional validator as the third argument to `register`. The renderer caps surfaces, stored components, and expanded tree size, and rejects cyclic or excessively deep trees; rendered text uses `textContent`.

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

CI also starts a generated app and checks its rendered workspace in headless Chrome. Its interactive renderer smoke test verifies that nested inputs and buttons are rejected without replacing existing controls or breaking their actions. It also checks Chromium�s accessibility tree for the button name, standalone heading level, and absence of a separate heading for the button label; this does not replace screen-reader testing. This is a smoke test, not full protocol conformance.

Pass an `onAction` callback as the third argument to `A2UIRenderer` to receive v0.9.1 action messages. Buttons are disabled without a callback. Heading-styled Text inside a button retains its heading element for styling but receives `role="presentation"`, so it remains button-label content rather than a separate heading. Built-in Button and TextField components are rejected anywhere inside a Button, including children resolved by later updates; a rejected update leaves the prior surface intact. Trusted custom components can still render interactive controls and must enforce their own accessible composition rules. Callbacks from buttons superseded by a component update or surface recreation are ignored. Only explicitly mapped event context is included; actions are never sent to a server by the renderer. The caller must authorize and route actions.

Application-definition `Input` components use `props: {label, path, variant?}`, where `label` is a string, `path` is a non-root absolute JSON Pointer, and `variant` is `shortText` or `longText`. The generated workspace and proposal preview map these to `TextField`; unsupported properties and invalid paths are rejected. Input edits update the local surface data model only and are not saved or sent to a service. Use a separately authorized capability or a host-provided editor for durable data.

An application-definition `Text` component can use `props: {path, variant?}` to display a value from the local surface data model, including values edited by an Input. `path` is an absolute JSON Pointer and `variant`, when provided, is `h1` through `h5`, `body`, or `caption`. A bound Text cannot also specify `text`; displayed values are literal text. Existing `props.text` definitions remain supported. Local bindings do not persist data.

An application-definition `Card` can use `props: {title?, text?}` to display an optional heading and body in a section. Both values must be strings of at most 10,000 characters and are rendered as plain text; unknown properties are rejected. The card is static and does not load data or invoke an action.
