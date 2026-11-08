// Boundary tests for the shared extension approval store, using a scripted query function instead of a database. A mutation run
// (scripts/mutate.mjs) found that 58 of 155 small changes to the store went unnoticed: single bad arguments and decisions, the
// exact edges of an expiry, and the checks on the rows read back (a tampered or damaged table must fail closed). Every case below
// fails when its condition is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresExtensionApprovals} from '../dist/index.js';

const admin={tenantId:'tenant',principalId:'admin'},scope={tenantId:'tenant',applicationId:'demo'},reference={id:'example.report',version:'1.0.0',scope:'application'},operation={extensionId:'example.report',kind:'tool',name:'lookup'};
const YEAR=365*86_400_000;

/** A store whose query function returns what the test scripts; `rows` is a list of results, the last one repeats. */
function store(results,{clock=()=>100,authorize=()=>true}={}){
 const calls=[];let i=0;
 const instance=new PostgresExtensionApprovals({query:async(sql,args)=>{calls.push({sql,args});const next=results[Math.min(i++,results.length-1)];if(next instanceof Error)throw next;return next;},authorize,clock});
 return {instance,calls};
}
const row=(overrides={})=>({revision:1,allowed:true,expires_at:500,...overrides});
const read=(...rows)=>({rows});

test('options are validated one at a time',()=>{
 const ok={query:async()=>({rows:[]}),authorize:()=>true};
 new PostgresExtensionApprovals(ok);new PostgresExtensionApprovals({...ok,clock:()=>1});
 for(const [label,options] of Object.entries({'no options':undefined,'no query':{...ok,query:undefined},'query not a function':{...ok,query:'sql'},'no authorize':{...ok,authorize:undefined},'authorize not a function':{...ok,authorize:true},'clock not a function':{...ok,clock:'now'}}))assert.throws(()=>new PostgresExtensionApprovals(options),/Invalid extension approval configuration/,label);
});

test('every argument is checked before anything is read or authorized',async()=>{
 const {instance,calls}=store([read()]),good=[admin,scope,reference,operation];
 const bad={
  'no actor':[undefined,scope,reference,operation],'actor tenant invalid':[{...admin,tenantId:''},scope,reference,operation],'actor principal invalid':[{...admin,principalId:''},scope,reference,operation],'actor principal with a space':[{...admin,principalId:'a b'},scope,reference,operation],
  'no scope':[admin,undefined,reference,operation],'scope tenant invalid':[admin,{...scope,tenantId:''},reference,operation],'scope application invalid':[admin,{...scope,applicationId:''},reference,operation],'another tenant than the actor':[admin,{...scope,tenantId:'other'},reference,operation],
  'no reference':[admin,scope,undefined,operation],'reference id invalid':[admin,scope,{...reference,id:''},operation],'reference version invalid':[admin,scope,{...reference,version:'one'},operation],'reference scope invalid':[admin,scope,{...reference,scope:'galaxy'},operation],
  'no operation':[admin,scope,reference,undefined],'operation kind invalid':[admin,scope,reference,{...operation,kind:'magic'}],'operation name invalid':[admin,scope,reference,{...operation,name:''}],'operation of another extension':[admin,scope,reference,{...operation,extensionId:'other.report'}]
 };
 for(const [label,args] of Object.entries(bad)){
  await assert.rejects(instance.isAllowed(...args),undefined,'isAllowed: '+label);await assert.rejects(instance.inspect(...args),undefined,'inspect: '+label);await assert.rejects(instance.history(...args),undefined,'history: '+label);
  await assert.rejects(instance.decide(...args,{allowed:false,expiresAt:0,expectedRevision:0}),undefined,'decide: '+label);
 }
 assert.equal(calls.length,0,'nothing was queried for a bad argument');
 assert.equal(await instance.isAllowed(...good),false,'the same call with valid arguments is read');
});

test('a decision is validated one part at a time',async()=>{
 const grant={allowed:true,expiresAt:200,expectedRevision:0};
 const {instance,calls}=store([read({revision:1})]);
 for(const [label,decision] of Object.entries({
  'no decision':undefined,'allowed not a boolean':{...grant,allowed:'yes'},'allowed missing':{expiresAt:200,expectedRevision:0},'expiry fractional':{...grant,expiresAt:200.5},'expiry text':{...grant,expiresAt:'200'},'revision fractional':{...grant,expectedRevision:0.5},'revision negative':{...grant,expectedRevision:-1},
  'revision at the largest safe integer':{...grant,expectedRevision:Number.MAX_SAFE_INTEGER},'revision missing':{allowed:true,expiresAt:200},'approval with expiry 0':{...grant,expiresAt:0},'approval with negative expiry':{...grant,expiresAt:-5},
  'revocation with an expiry':{allowed:false,expiresAt:1,expectedRevision:0},'revocation with a negative expiry':{allowed:false,expiresAt:-1,expectedRevision:0}
 }))await assert.rejects(instance.decide(admin,scope,reference,operation,decision),/Invalid extension approval decision/,label);
 assert.equal(calls.length,0);
});

test('an approval expires in the future and within a year; revocation takes no expiry',async()=>{
 const stored=store([read({revision:1})],{clock:()=>100});
 const decide=(allowed,expiresAt,expectedRevision=0)=>stored.instance.decide(admin,scope,reference,operation,{allowed,expiresAt,expectedRevision});
 assert.equal(await decide(true,101),1,'expires one millisecond from now');assert.equal(await decide(true,100+YEAR),1,'expires in exactly a year');assert.equal(await decide(false,0),1,'revoked');
 await assert.rejects(decide(true,100),/Invalid extension approval expiration/,'expires now');await assert.rejects(decide(true,99),/Invalid extension approval expiration/,'expired already');await assert.rejects(decide(true,100+YEAR+1),/Invalid extension approval expiration/,'more than a year');
 const queries=stored.calls.length;await assert.rejects(decide(true,100),undefined);assert.equal(stored.calls.length,queries,'a refused expiry is not written');
 // The revision to expect and the revision written differ by one; anything else is a conflict.
 for(const [label,result] of Object.entries({'no row':read(),'two rows':read({revision:1},{revision:1}),'a different revision':read({revision:5}),'revision not a number':read({revision:'x'}),'rows missing':{},'rows not a list':{rows:'x'}}))await assert.rejects(store([result]).instance.decide(admin,scope,reference,operation,{allowed:true,expiresAt:200,expectedRevision:0}),label==='no row'?/revision conflict/:/outcome uncertain/,label);
 assert.equal(await store([read({revision:8})]).instance.decide(admin,scope,reference,operation,{allowed:true,expiresAt:200,expectedRevision:7}),8);
 // The clock must be a non-negative whole number.
 for(const bad of [()=>-1,()=>1.5,()=>NaN,()=>'now'])await assert.rejects(store([read()],{clock:bad}).instance.decide(admin,scope,reference,operation,{allowed:true,expiresAt:200,expectedRevision:0}),/Invalid clock/);
 await assert.rejects(store([read(row()),read(row())],{clock:()=>-1}).instance.isAllowed(admin,scope,reference,operation),/Invalid clock/,'the clock is read when a row exists');
 assert.equal(await store([read({revision:1})],{clock:()=>0}).instance.decide(admin,scope,reference,operation,{allowed:true,expiresAt:5,expectedRevision:0}),1,'time zero is valid');
});

test('isAllowed answers from the stored row and fails closed on damage',async()=>{
 const allowed=(results,clock=()=>100)=>store(results,{clock}).instance.isAllowed(admin,scope,reference,operation);
 assert.equal(await allowed([read()]),false,'no row');
 assert.equal(await allowed([read(row()),read(row())]),true,'an active approval');
 assert.equal(await allowed([read(row({allowed:false})),read(row({allowed:false}))]),false,'a revoked one');
 assert.equal(await allowed([read(row({expires_at:100})),read(row({expires_at:100}))]),false,'expiring exactly now');assert.equal(await allowed([read(row({expires_at:101})),read(row({expires_at:101}))]),true,'expiring one millisecond from now');
 assert.equal(await allowed([read(row({expires_at:0})),read(row({expires_at:0}))]),false,'expiry zero');
 // The approval is read twice; a revision that changed in between denies.
 assert.equal(await allowed([read(row({revision:1})),read(row({revision:2}))]),false,'changed between the two reads');
 assert.equal(await allowed([read(row()),read()]),false,'removed between the two reads');
 // Anything that does not look like a row this store wrote is an error, not an answer.
 for(const [label,bad] of Object.entries({'revision 0':row({revision:0}),'negative revision':row({revision:-1}),'revision not a number':row({revision:'x'}),'revision fractional':row({revision:1.5}),'allowed as text':row({allowed:'true'}),'allowed as a number':row({allowed:1}),'allowed missing':{revision:1,expires_at:500},'expiry negative':row({expires_at:-1}),'expiry fractional':row({expires_at:1.5}),'expiry not a number':row({expires_at:'later'})}))await assert.rejects(allowed([read(bad),read(bad)]),/Invalid extension approval result/,label);
 await assert.rejects(allowed([read(row(),row())]),/Invalid extension approval result/,'two rows on the first read');await assert.rejects(allowed([read(row()),read(row(),row())]),/Invalid extension approval result/,'two rows on the second read');
 await assert.rejects(allowed([{rows:'x'}]),/Invalid extension approval result/,'rows not a list on the first read');await assert.rejects(allowed([read(row()),{rows:'x'}]),/Invalid extension approval result/,'rows not a list on the second read');
 await assert.rejects(allowed([new Error('database unavailable')]),/database unavailable/,'an unreachable database');
 // Authorization is asked before and between the reads, and a refusal at any point stops the answer.
 const asked=[];const probe=new PostgresExtensionApprovals({query:async()=>read(row()),authorize:(_actor,action)=>{asked.push(action);return true;},clock:()=>100});
 assert.equal(await probe.isAllowed(admin,scope,reference,operation),true);assert.deepEqual(asked,['invoke','invoke','invoke'],'checked before and after each read');
 for(const refuse of [1,2,3]){let count=0;const refusing=new PostgresExtensionApprovals({query:async()=>read(row()),authorize:()=>++count!==refuse,clock:()=>100});await assert.rejects(refusing.isAllowed(admin,scope,reference,operation),/forbidden/,'refused at check '+refuse);}
 await assert.rejects(new PostgresExtensionApprovals({query:async()=>read(row()),authorize:()=>'yes',clock:()=>100}).isAllowed(admin,scope,reference,operation),/forbidden/,'only true authorizes');
});

test('inspect reports the state and rejects damaged or changing rows',async()=>{
 const inspect=(results,clock=()=>100)=>store(results,{clock}).instance.inspect(admin,scope,reference,operation);
 assert.equal(await inspect([read()]),undefined,'no row');
 assert.deepEqual(await inspect([read(row()),read(row())]),{revision:1,allowed:true,expiresAt:500,active:true});
 assert.deepEqual(await inspect([read(row({expires_at:100})),read(row({expires_at:100}))]),{revision:1,allowed:true,expiresAt:100,active:false},'expiring now is not active');
 assert.equal((await inspect([read(row({expires_at:101})),read(row({expires_at:101}))])).active,true);assert.equal((await inspect([read(row({allowed:false})),read(row({allowed:false}))])).active,false);
 await assert.rejects(inspect([read(row({revision:1})),read(row({revision:2}))]),/changed/,'changed between the reads');await assert.rejects(inspect([read(row()),read()]),/changed/,'removed between the reads');
 for(const [label,bad] of Object.entries({'revision 0':row({revision:0}),'revision fractional':row({revision:1.5}),'allowed as text':row({allowed:'true'}),'expiry negative':row({expires_at:-1}),'expiry fractional':row({expires_at:0.5})}))await assert.rejects(inspect([read(bad),read(bad)]),/Invalid extension approval result/,label);
 await assert.rejects(inspect([read(row(),row())]),/Invalid extension approval result/);await assert.rejects(inspect([read(row()),read(row(),row())]),/Invalid extension approval result/);
});

test('history paginates and rejects damaged audit rows',async()=>{
 const entry=(overrides={})=>({id:1,actor_id:'admin',revision:1,allowed:true,expires_at:500,observed_at:100,...overrides});
 const history=(rows,options)=>store([{rows}]).instance.history(admin,scope,reference,operation,options);
 assert.deepEqual(await history([entry()]),{items:[{id:1,actorId:'admin',revision:1,allowed:true,expiresAt:500,observedAt:100}]});
 // One row beyond the limit means there is another page, starting after the last row returned.
 const three=[entry({id:1}),entry({id:2}),entry({id:3})];
 const page=await history(three,{limit:2});assert.equal(page.items.length,2);assert.equal(page.nextAfter,2);assert.equal((await history(three.slice(0,2),{limit:2})).nextAfter,undefined,'exactly a full page has no next page');
 const {instance,calls}=store([{rows:[]}]);await instance.history(admin,scope,reference,operation,{after:7,limit:100});assert.equal(calls[0].args.at(-2),7);assert.equal(calls[0].args.at(-1),101,'the query asks for one more than the limit');
 for(const [label,options] of Object.entries({'after negative':{after:-1},'after fractional':{after:1.5},'after text':{after:'1'},'limit 0':{limit:0},'limit 101':{limit:101},'limit fractional':{limit:1.5},'limit text':{limit:'5'},'limit negative':{limit:-1},'null options':null}))await assert.rejects(history([],options),/Invalid extension approval (history|result)/,label);
 await history([],{after:0,limit:1});await history([],{limit:100});
 for(const [label,bad] of Object.entries({'id 0':entry({id:0}),'id fractional':entry({id:1.5}),'actor invalid':entry({actor_id:''}),'actor not text':entry({actor_id:7}),'revision 0':entry({revision:0}),'revision fractional':entry({revision:1.5}),'allowed as text':entry({allowed:'true'}),'expiry negative':entry({expires_at:-1}),'expiry fractional':entry({expires_at:1.5}),'observed negative':entry({observed_at:-1}),'observed fractional':entry({observed_at:0.5})}))await assert.rejects(history([bad]),/Invalid extension approval (history|result)/,label);
 assert.equal((await history([entry({expires_at:0,observed_at:0})])).items[0].observedAt,0,'zero is valid for the times');
 await assert.rejects(history('x'),/Invalid extension approval (history|result)/,'rows not a list');await assert.rejects(history(Array.from({length:52},(_,i)=>entry({id:i+1}))),/Invalid extension approval (history|result)/,'more rows than the query asked for');
});
