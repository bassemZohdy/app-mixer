# Status badge extension example

This example contains a versioned extension manifest, a trusted web component, and an application definition that references it. The component validates its static properties and renders text with `textContent`.

From the repository root, build the workspace and run the end-to-end example test:

```sh
npm run build
node --test packages/cli/test/extension-example.test.mjs
```

The test generates a temporary Ed25519 key, signs the manifest with a digest of `extension.mjs`, checks a pinned host approval, installs the signed registration, publishes the application, and renders the component with a generated workspace. It also checks that changed package bytes and invalid component properties are rejected. The generated key is for the test only.

To try the static browser registration in a generated workspace, create a project with `app-mixer create status-demo`. Replace its `application.json` with this example's `application.json`. Copy the contents of `extension.mjs` into the generated project's `extensions.mjs`, then append:

```js
export const installedExtensions = [installedExtension];
```

Start the generated project with `npm run dev`. Its server exposes `extensions.mjs` directly, so keeping the example code in that file avoids adding another server route. The browser workspace does not verify signatures or load packages from definitions: its host owns the static code and must separately apply publication, signature and approval policies. Never include credentials in browser code.

The example signs the source file as a test artifact. A digest alone does not establish that deployed JavaScript is identical to approved bytes; production hosts must build, verify and deploy the approved artifact through their own controlled pipeline. Use trusted publisher keys, review permissions, and rebuild the runtime when approvals change.
