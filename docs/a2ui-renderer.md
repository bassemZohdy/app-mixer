# A2UI web renderer: initial subset

`@app-mixer/web` provides a browser DOM renderer and a trusted-code component registry. The adapter accepts A2UI v0.9.1 `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` envelopes for the [App Mixer v1 catalog](../packages/web/catalog/v1/catalog.json), a restricted subset of the v0.9.1 basic catalog. It accepts the basic catalog identifier for backward compatibility but does not support the whole catalog; clients should advertise only the App Mixer catalog. It supports **only** `Text`, `Column`, `Row`, `Card`, `TextField`, and `Button`, with the properties listed below. It must not be advertised as a complete implementation of the basic catalog or protocol. The generated CLI application uses this renderer for its workspace; currently it maps only Text manifest components and reports other component types as unsupported.

| Component | Supported properties (in addition to `id` and `component`) |
| --- | --- |
| Text | `text`: literal string or absolute data path; optional `variant`: h1–h5, body, caption. Text is displayed literally, including Markdown syntax. |
| Column, Row | `children`: array of component IDs; optional `justify` and `align` flex alignment. |
| Card | `child`: component ID. |
| TextField | Literal `label`, absolute `value.path`, and optional `variant` (`shortText` or `longText`); writes changes to the local model. |
| Button | `child`, optional `variant`, and `action.event` with `name` and optional context containing primitives or absolute data paths. |

The optional `A2UIJsonLines` helper frames decoded JSONL text in order, including messages split across chunks; network transport and UTF-8 decoding remain the caller’s responsibility. Components can arrive incrementally; missing children render as empty placeholders. Data model updates use absolute JSON pointers and create missing object parents; deleting an array element preserves its index. Text bindings re-render after updates. Unknown component types and unsupported properties fail rather than executing supplied code. Renderers registered through `ComponentRegistry` are trusted application code, not model-provided code. The renderer caps surfaces, stored components, and expanded tree size, and rejects cyclic or excessively deep trees; rendered text uses `textContent`.

Not yet implemented: basic catalog parity, Markdown, templates and relative bindings, additional form components, action functions and validation, theme, `sendDataModel`, and a protocol conformance suite. P1-03 remains open until the supported catalog and protocol behavior are verified with a broader conformance suite. Renderer parity across other platforms is a separate task.

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

Pass an `onAction` callback as the third argument to `A2UIRenderer` to receive v0.9.1 action messages. Buttons are disabled without a callback. Only explicitly mapped event context is included; actions are never sent to a server by the renderer. The caller must authorize and route actions.
