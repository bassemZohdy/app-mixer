import test from 'node:test';
import assert from 'node:assert/strict';
import {ApplicationStore,DevelopmentProposals,SqliteApplicationStore} from '../dist/index.js';
const initial={id:'demo',schemaVersion:1,revision:0,pages:[]};
const page={id:'home',title:'Home',route:'/',components:[]};

test('proposal preview is isolated until explicitly approved and published',()=>{
  const repo=new ApplicationStore(initial), proposals=new DevelopmentProposals(repo);
  const proposal=proposals.propose(0,[{op:'addPage',page}]);
  assert.equal(proposal.preview.pages[0].title,'Home');
  assert.equal(repo.getDraft().pages.length,0); assert.equal(repo.getPublished(),undefined);
  proposal.preview.pages[0].title='tampered'; proposal.patches[0].page.title='tampered';
  const approved=proposals.approve(proposal.id);
  assert.equal(approved.status,'approved');assert.equal(approved.approvedRevision,1);
  assert.equal(repo.getDraft().pages[0].title,'Home');assert.equal(repo.getPublished(),undefined);
  repo.publish(approved.approvedRevision);
  assert.equal(repo.getPublished().definition.pages[0].title,'Home');
  assert.throws(()=>proposals.approve(proposal.id),/not pending/);
});

test('invalid, rejected and stale proposals do not mutate the draft',()=>{
  const repo=new ApplicationStore(initial), proposals=new DevelopmentProposals(repo);
  assert.throws(()=>proposals.propose(0,[{op:'unknown'}]),/Invalid proposal/);
  assert.throws(()=>proposals.propose(0,[{op:'addPage',page:{...page,route:'bad'}}]),/invalid page/);
  const rejected=proposals.propose(0,[{op:'addPage',page}]);
  proposals.reject(rejected.id);assert.throws(()=>proposals.approve(rejected.id),/not pending/);
  const stale=proposals.propose(0,[{op:'addPage',page}]);
  repo.apply(0,[{op:'addPage',page:{...page,id:'other',route:'/other'}}]);
  assert.throws(()=>proposals.approve(stale.id),/Revision conflict/);
  assert.equal(repo.getDraft().pages[0].id,'other');
  assert.equal(proposals.get(stale.id).status,'pending');
});


test('proposal approval applies to SQLite without publishing',()=>{
  const repo=new SqliteApplicationStore(':memory:',initial);
  try {
    const proposals=new DevelopmentProposals(repo);
    const p=proposals.propose(0,[{op:'addPage',page}]);
    assert.equal(repo.getDraft().revision,0);
    proposals.approve(p.id);
    assert.equal(repo.getDraft().revision,1);
    assert.equal(repo.getPublished(),undefined);
    repo.publish(1);
    assert.equal(repo.getPublished().definition.pages[0].id,'home');
  } finally {repo.close();}
});
