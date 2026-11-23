// TASK-019: the Kubernetes base manifest is secure by default; the open variant exists only as a named example overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../deploy/kubernetes/', import.meta.url));
const base = readFileSync(join(root, 'data-plane/deployment.yaml'), 'utf8');
/** Every YAML file outside test-support; test-support fixtures describe their own scenarios. */
function manifests(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.parentPath.replaceAll('\\', '/').includes('test-support'))
    .map(entry => [join(entry.parentPath, entry.name).replaceAll('\\', '/'), readFileSync(join(entry.parentPath, entry.name), 'utf8')]);
}

test('TASK-019 the base manifest serves a signed publication with JWT access over TLS', () => {
  for (const [name, value] of [
    ['APP_MIXER_PUBLICATION_MODE', 'signed'],
    ['APP_MIXER_ACCESS_MODE', 'jwt'],
    ['APP_MIXER_TRANSPORT', 'tls']
  ])
    assert.match(base, new RegExp('name: ' + name + ', value: ' + value + '\\b'), name + ' is secure by default');
  assert.match(base, /name: APP_MIXER_RELEASE_KEYS_PATH, value: \/trust\/keys\.json/, 'release trust is mounted');
  assert.match(base, /name: APP_MIXER_JWKS_PATH, value: \/jwt-trust\/jwks\.json/, 'the JWT key set is mounted');
  assert.match(base, /name: APP_MIXER_TLS_CERT_PATH, value: \/tls\/tls\.crt/, 'the TLS certificate is mounted');
  assert.equal((base.match(/scheme: HTTPS/g) ?? []).length, 3, 'every probe speaks HTTPS');
});

test('TASK-019 the base image is pinned without a test tag', () => {
  const images = [...base.matchAll(/^\s*image:\s*(\S+)$/gm)].map(match => match[1]);
  assert.equal(images.length, 1);
  assert.match(images[0], /@sha256:[a-f0-9]{64}$|:[0-9][A-Za-z0-9._-]*$/);
  assert.doesNotMatch(images[0], /:test$/);
});

test('TASK-019 the rendered base contains no unsigned, public or http setting, and the open overlay is the only place they appear', () => {
  assert.doesNotMatch(base, /value: (unsigned|public|http)\s*\}?\s*$/m);
  const offenders = [];
  for (const [path, text] of manifests(root))
    for (const match of text.matchAll(/value: (unsigned|public|http)\s*\}?\s*$/gm)) if (!path.includes('/open-example/')) offenders.push(`${path}: value: ${match[1]}`);
  assert.deepEqual(offenders, []);
});

test('TASK-019 the open example overlay opts out of every secure default', () => {
  const overlay = readFileSync(join(root, 'open-example/kustomization.yaml'), 'utf8');
  for (const value of ['unsigned', 'public', 'http']) assert.match(overlay, new RegExp('value: ' + value + '\\s*\\}\\s*$', 'm'), value + ' is set explicitly');
  for (const setting of ['APP_MIXER_RELEASE_KEYS_PATH', 'APP_MIXER_JWKS_PATH', 'APP_MIXER_TLS_CERT_PATH'])
    assert.match(overlay, new RegExp('name: ' + setting + ', \\$patch: delete'), setting + ' is removed');
});

test('TASK-019 the stepped examples reassemble the secure settings on top of the open variant', () => {
  const secure = readFileSync(join(root, 'signed-jwt-tls-example/kustomization.yaml'), 'utf8'),
    revocation = readFileSync(join(root, 'signed-jwt-tls-revocation-example/kustomization.yaml'), 'utf8');
  assert.match(secure, /value: tls/, 'the TLS step restores the secure transport');
  assert.match(revocation, /name: APP_MIXER_REVOCATION_MODE, value: postgres/, 'the revocation step switches revocation on by name');
  assert.doesNotMatch(revocation, /env\/\d+\/value/, 'overlays no longer patch environment entries by index');
});
