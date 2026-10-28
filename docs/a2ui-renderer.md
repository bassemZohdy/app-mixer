# A2UI web renderer: initial subset

`@app-mixer/web` provides a browser DOM renderer and a trusted-code component registry. The initial adapter accepts A2UI v0.9.1 `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface` envelopes for the v0.9.1 basic catalog. It supports **only** `Text`, `Column`, `Row`, and `Card`, with the properties listed below. It must not be advertised as a complete implementation of the basic catalog or protocol. The generated CLI application is not yet wired to this renderer.

| Component | Supported properties (in addition to `id` and `component`) |
| --- | --- |
| Text | `text`: literal string or absolute data path; optional `variant`: h1–h5, body, caption. Text is displayed literally, including Markdown syntax. |
| Column, Row | `children`: array of component IDs. |
| Card | `child`: component ID. |

Components can arrive incrementally; missing children render as empty placeholders. Data model updates use absolute JSON pointers, but nested parent objects must already exist. Text bindings re-render after updates. Unknown component types and unsupported properties fail rather than executing supplied code. Renderers registered through `ComponentRegistry` are trusted application code, not model-provided code. The renderer rejects cyclic and excessively deep trees; rendered text uses `textContent`.

Not yet implemented: basic catalog parity, Markdown, templates and relative bindings, forms, actions, functions, validation, theme, `sendDataModel`, JSONL transport, and a browser integration/conformance suite. P1-03 remains open until the supported catalog is defined, integrated into the generated application, and verified with realistic browser and protocol tests. Renderer parity across other platforms is a separate task.

Example after building the workspaces and serving the compiled module to a browser:

```js
import { A2UIRenderer, BASIC_CATALOG } from './index.js';
const renderer = new A2UIRenderer(document.getElementById('app'));
renderer.apply({version:'v0.9.1', createSurface:{surfaceId:'main', catalogId:BASIC_CATALOG}});
renderer.apply({version:'v0.9.1', updateComponents:{surfaceId:'main', components:[
  {id:'root', component:'Column', children:['greeting']},
  {id:'greeting', component:'Text', text:'Hello'}
]}});
```

Protocol references: [A2UI v0.9.1 quickstart](https://a2ui.org/quickstart/) and [message reference](https://a2ui.org/reference/messages/).
