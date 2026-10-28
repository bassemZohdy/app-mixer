import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApplicationStore } from '../dist/index.js';

const initial = id => ({id, schemaVersion:1, revision:0, pages:[]});
const page = {id:'home', route:'/', title:'Home', components:[]};

test('persists drafts and immutable versions across connections and restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'app-mixer-db-'));
  const path = join(dir, 'definitions.sqlite');
  let first, second, other, raw;
  try {
    first = new SqliteApplicationStore(path, initial('demo'));
    second = new SqliteApplicationStore(path, initial('demo'));
    other = new SqliteApplicationStore(path, initial('other'));
    first.apply(0, [{op:'addPage',page}]);
    assert.throws(() => second.apply(0, []), /Revision conflict/);
    assert.throws(() => first.apply(1, [{op:'addPage',page}]), /Duplicate/);
    assert.equal(first.getDraft().revision, 1);
    first.publish(1);
    second.apply(1, [{op:'setPageTitle',pageId:'home',title:'Changed'}]);
    second.publish(2);
    assert.equal(first.getPublished(1).definition.pages[0].title, 'Home');
    assert.equal(first.getPublished().definition.pages[0].title, 'Changed');
    assert.equal(other.getPublished(), undefined);
    first.getPublished(1).definition.pages[0].title = 'mutated';
    assert.equal(first.getPublished(1).definition.pages[0].title, 'Home');
    raw = new DatabaseSync(path);
    assert.throws(() => raw.exec("UPDATE application_publications SET definition = '{}'"), /immutable/);
    assert.throws(() => raw.exec('DELETE FROM application_publications'), /immutable/);
    assert.throws(() => raw.exec("INSERT OR REPLACE INTO application_publications VALUES ('demo', 1, '{}')"), /immutable/);
    raw.close(); raw = undefined;
    first.close(); first = undefined;
    second.close(); second = undefined;
    first = new SqliteApplicationStore(path, initial('demo'));
    assert.equal(first.getDraft().revision, 2);
    assert.equal(first.getPublished(1).definition.pages[0].title, 'Home');
    assert.equal(first.getPublished().version, 2);
    assert.equal(first.getPublished(3), undefined);
    assert.throws(() => first.publish(1), /Revision conflict/);
  } finally {
    raw?.close(); first?.close(); second?.close(); other?.close();
    await rm(dir, {recursive:true, force:true});
  }
});
