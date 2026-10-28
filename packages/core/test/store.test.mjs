import test from 'node:test';import assert from 'node:assert/strict';import {ApplicationStore} from '../dist/index.js';
test('draft isolation, versioning and atomic invalid patch',()=>{
const store=new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
store.apply(0,[{op:'addPage',page:{id:'home',route:'/',title:'Home',components:[]}}]);
store.publish(1);store.apply(1,[{op:'setPageTitle',pageId:'home',title:'Changed'}]);
assert.equal(store.getPublished().definition.pages[0].title,'Home');
assert.throws(()=>store.apply(1,[]),/Revision conflict/);
assert.throws(()=>store.apply(2,[{op:'addPage',page:{id:'duplicate',route:'/',title:'Bad',components:[]}}]),/Duplicate/);
assert.equal(store.getDraft().revision,2);
});

test('rejects unknown patch operations without changing the draft', () => {
  const store = new ApplicationStore({id:'demo',schemaVersion:1,revision:0,pages:[]});
  assert.throws(() => store.apply(0,[{op:'unknown'}]), /Unknown patch operation/);
  assert.equal(store.getDraft().revision, 0);
});


test('in-memory store retrieves the requested published version', () => {
  const store = new ApplicationStore({id:'demo', schemaVersion:1, revision:0, pages:[]});
  store.publish(0);
  store.apply(0, [{op:'addPage',page:{id:'home',title:'Home',route:'/',components:[]}}]);
  store.publish(1);
  assert.equal(store.getPublished(1).definition.pages.length, 0);
  assert.equal(store.getPublished().version, 2);
  assert.equal(store.getPublished(3), undefined);
});
