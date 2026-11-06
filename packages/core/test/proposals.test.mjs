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

test('only pending proposals count toward the limit and settled ones are evicted beyond their bound',()=>{
 const repo=new ApplicationStore(initial),proposals=new DevelopmentProposals(repo,2,2);
 const patch=n=>[{op:'addPage',page:{...page,id:'p'+n,route:'/p'+n}}];
 const a=proposals.propose(0,patch(1)),b=proposals.propose(0,patch(2));
 assert.throws(()=>proposals.propose(0,patch(3)),/limit/,'two pending proposals fill the limit');
 proposals.reject(a.id);const c=proposals.propose(0,patch(3));assert.equal(c.status,'pending','a settled proposal frees its slot');
 proposals.reject(b.id);proposals.reject(c.id);
 // Three settled proposals with a bound of two: the oldest settled one is gone, the newest two stay readable.
 assert.equal(proposals.get(a.id),undefined);assert.equal(proposals.get(b.id).status,'rejected');assert.equal(proposals.get(c.id).status,'rejected');
 assert.throws(()=>proposals.approve(a.id),/not found/);
 for(let n=4;n<20;n++){const p=proposals.propose(0,patch(n));proposals.reject(p.id);}
 const pending=proposals.propose(0,patch(99));assert.equal(proposals.get(pending.id).status,'pending','a long history never blocks new proposals');
 assert.throws(()=>new DevelopmentProposals(repo,1,-1),/Invalid proposal limit/);
});

test('SQLite proposals survive a restart and keep the in-memory contract',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{SqliteDevelopmentProposals}=await import('../dist/index.js');
 const dir=mkdtempSync(join(tmpdir(),'sqlite-proposals-')),path=join(dir,'proposals.sqlite'),repo=new ApplicationStore(initial);let store=new SqliteDevelopmentProposals(path,repo,2,2),reopened;
 try{
  const patch=n=>[{op:'addPage',page:{...page,id:'p'+n,route:'/p'+n}}];
  const a=store.propose(0,patch(1));assert.equal(a.status,'pending');assert.equal(a.preview.pages[0].id,'p1');assert.equal(repo.getDraft().pages.length,0,'a proposal does not touch the draft');
  const b=store.propose(0,patch(2));assert.throws(()=>store.propose(0,patch(3)),/limit/,'two pending proposals fill the limit');
  store.close();store=undefined;reopened=new SqliteDevelopmentProposals(path,repo,2,2);
  assert.deepEqual(reopened.get(a.id),a,'a pending proposal survives a restart unchanged');assert.equal(reopened.get('missing'),undefined);
  const approved=reopened.approve(a.id);assert.equal(approved.status,'approved');assert.equal(approved.approvedRevision,1);assert.equal(repo.getDraft().pages[0].id,'p1');
  assert.throws(()=>reopened.approve(a.id),/not pending/);assert.throws(()=>reopened.reject(a.id),/not pending/);assert.throws(()=>reopened.approve('missing'),/not found/);
  // b was proposed against revision 0: the repository is at revision 1 now, so a stale approval fails and applies nothing.
  assert.throws(()=>reopened.approve(b.id),/conflict/i);assert.equal(reopened.get(b.id).status,'pending');assert.equal(repo.getDraft().pages.length,1);
  assert.equal(reopened.reject(b.id).status,'rejected');
  const c=reopened.propose(1,[{op:'addPage',page:{...page,id:'p3',route:'/p3'}}]),d=reopened.propose(1,[{op:'addPage',page:{...page,id:'p4',route:'/p4'}}]);reopened.reject(c.id);reopened.reject(d.id);
  assert.equal(reopened.get(a.id),undefined,'the oldest settled proposals were evicted beyond settledLimit');assert.equal(reopened.get(b.id),undefined);assert.equal(reopened.get(c.id).status,'rejected');assert.equal(reopened.get(d.id).status,'rejected');
  assert.throws(()=>reopened.propose(0,[]),/Invalid proposal/);assert.throws(()=>new SqliteDevelopmentProposals(path,repo,0),/Invalid proposal limit/);
 }finally{store?.close();reopened?.close();rmSync(dir,{recursive:true,force:true});}
});

test('the proposal and control planes accept a durable proposal store',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{once}=await import('node:events'),{SqliteDevelopmentProposals,createDevelopmentPlanes}=await import('../dist/index.js');
 const dir=mkdtempSync(join(tmpdir(),'plane-proposals-')),path=join(dir,'proposals.sqlite'),repo=new ApplicationStore(initial),developer='d'.repeat(32),agent='a'.repeat(32);let first,second,planes1,planes2;
 const start=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;};
 try{
  first=new SqliteDevelopmentProposals(path,repo);planes1=createDevelopmentPlanes(repo,developer,agent,undefined,undefined,undefined,first);
  const proposalUrl=await start(planes1.proposal),created=await fetch(proposalUrl+'/proposals',{method:'POST',headers:{authorization:'Bearer '+agent,'content-type':'application/json'},body:JSON.stringify({baseRevision:0,patches:[{op:'addPage',page}]})});assert.equal(created.status,201);const proposal=await created.json();
  planes1.proposal.close();planes1.control.close();first.close();first=undefined;
  // A new process: the pending proposal is still there to approve.
  second=new SqliteDevelopmentProposals(path,repo);planes2=createDevelopmentPlanes(repo,developer,agent,undefined,undefined,undefined,second);
  const controlUrl=await start(planes2.control),approved=await fetch(`${controlUrl}/proposals/${proposal.id}/approve`,{method:'POST',headers:{authorization:'Bearer '+developer}});
  assert.equal(approved.status,200);assert.equal(repo.getDraft().pages[0].id,'home');assert.equal((await approved.json()).status,'approved');
 }finally{planes1?.proposal.close();planes1?.control.close();planes2?.proposal.close();planes2?.control.close();first?.close();second?.close();rmSync(dir,{recursive:true,force:true});}
});
