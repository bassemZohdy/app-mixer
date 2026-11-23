// TASK-010: csp hashing, SQLite opening, JSON request-body reading and the timing-safe comparisons have one shared definition each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { BodyReadError, bearerAuthorized, inlineHashes, openDatabase, readBodyBytes, readJsonBody, timingSafeEqualBuffers } = await import('../../shared/dist/index.js');

/** A minimal IncomingMessage: headers plus an async-iterable body. */
function request(chunks, contentType = 'application/json') {
  const stream = Readable.from(chunks);
  stream.headers = { 'content-type': contentType };
  return stream;
}

test('TASK-010 inlineHashes hashes inline script and style blocks and skips blocks with a src', () => {
  const script = '<script>alert(1)</script>';
  const html = `<html><head><style>body{color:red}</style><script src="x.js"></script>${script}</head></html>`;
  assert.deepEqual(inlineHashes(html, 'script'), ["'sha256-" + createHash('sha256').update('alert(1)').digest('base64') + "'"]);
  assert.deepEqual(inlineHashes(html, 'style'), ["'sha256-" + createHash('sha256').update('body{color:red}').digest('base64') + "'"]);
  assert.deepEqual(inlineHashes('<b>no blocks</b>', 'script'), []);
});

test('TASK-010 openDatabase returns an open database', () => {
  const db = openDatabase(':memory:');
  try {
    assert.ok(db instanceof DatabaseSync);
    assert.equal(db.prepare('select 1 as one').get().one, 1);
  } finally {
    db.close();
  }
});

test('TASK-010 readJsonBody parses a JSON body and refuses the wrong content type, oversize bodies and invalid JSON', async () => {
  assert.deepEqual(await readJsonBody(request(['{"a":', '1}']), { maxBytes: 64 }), { a: 1 });
  for (const [chunks, contentType, maxBytes, reason] of [
    [['{}'], 'text/plain', 64, 'content-type'],
    [['{}'], undefined, 64, 'content-type'],
    [['aaaaaaaaaaaaaaaa'], 'application/json', 8, 'too-large'],
    [['{not json}'], 'application/json; charset=utf-8', 64, 'invalid-json']
  ]) {
    const stream = Readable.from(chunks);
    stream.headers = contentType === undefined ? {} : { 'content-type': contentType };
    await assert.rejects(readJsonBody(stream, { maxBytes }), error => error instanceof BodyReadError && error.reason === reason, reason);
  }
});

test('TASK-010 readBodyBytes returns raw bytes and accepts a caller-supplied content type', async () => {
  const form = request(['a=1&b=2'], 'application/x-www-form-urlencoded');
  assert.equal((await readBodyBytes(form, { maxBytes: 64, contentType: /^application\/x-www-form-urlencoded(?:\s*;|$)/i })).toString('utf8'), 'a=1&b=2');
  await assert.rejects(readBodyBytes(request(['{}'], 'application/json'), { maxBytes: 64, contentType: /^text\/csv$/i }), error => error instanceof BodyReadError && error.reason === 'content-type');
});

test('TASK-010 the timing-safe comparisons refuse different lengths, content and tokens without throwing', () => {
  assert.equal(timingSafeEqualBuffers(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(timingSafeEqualBuffers(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.equal(timingSafeEqualBuffers(Buffer.from('abc'), Buffer.from('ab')), false);
  assert.equal(bearerAuthorized('Bearer abc', 'abc'), true);
  assert.equal(bearerAuthorized('Bearer abd', 'abc'), false);
  assert.equal(bearerAuthorized(undefined, 'abc'), false);
  assert.equal(bearerAuthorized('', 'abc'), false);
});

test('TASK-010 every helper has exactly one definition: no second copy survives in any package source', () => {
  const sources = [];
  for (const name of ['agent', 'cli', 'core', 'native', 'shared', 'web']) {
    const folder = join(root, 'packages', name, 'src');
    for (const relative of readdirSync(folder, { recursive: true })) {
      const path = join(folder, relative);
      if (path.endsWith('.ts')) sources.push([name, path]);
    }
  }
  const guards = [
    ['a request-body reader', /for await \(const \w+ of (?:req|request|incoming)\b/, [/packages[\\/]shared[\\/]src[\\/]http\.ts$/]],
    ['a direct timingSafeEqual call', /(?<!Buffers)\btimingSafeEqual\(/, [/packages[\\/]shared[\\/]src[\\/]http\.ts$/]],
    ['a bearer header comparison', /Buffer\.from\((?:`Bearer |'Bearer ')/, [/packages[\\/]shared[\\/]src[\\/]http\.ts$/]],
    ['an openDatabase definition', /export function openDatabase\b/, [/packages[\\/]shared[\\/]src[\\/]sqlite-open\.ts$/]],
    ['an inlineHashes definition', /export function inlineHashes\b/, [/packages[\\/]shared[\\/]src[\\/]csp\.ts$/]]
  ];
  const offenders = [];
  for (const [label, pattern, allowed] of guards)
    for (const [name, path] of sources) {
      const normalized = path.replaceAll('\\', '/');
      if (allowed.some(exception => exception.test(normalized))) continue;
      if (pattern.test(readFileSync(path, 'utf8'))) offenders.push(`${label} in ${normalized}`);
    }
  assert.deepEqual(offenders, []);
});

test('TASK-010 csp.ts and sqlite-open.ts exist only inside the shared package', () => {
  const copies = [];
  for (const name of ['agent', 'cli', 'core', 'native', 'web']) {
    const folder = join(root, 'packages', name, 'src');
    for (const relative of readdirSync(folder, { recursive: true }))
      if (relative.replaceAll('\\', '/') === 'csp.ts' || relative.replaceAll('\\', '/') === 'sqlite-open.ts') copies.push(name + '/' + relative);
  }
  assert.deepEqual(copies, []);
});
