import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteAgentDefinitions} from '../dist/index.js';

const manifest={manifestVersion:1,tenantId:'tenant',agentId:'agent',name:'Agent',owner:{kind:'organization',id:'org'},administrators:['admin'],servicePrincipalId:'svc',model:{provider:'local',model:'test'},allowedCapabilities:[],lifecycle:{enabled:true,maxAttempts:2,runTimeoutMs:60000},quotas:{maxConcurrentRuns:1,maxTokensPerRun:100,maxRunsPerDay:10}};
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const junk=['',' ','x',0,-1,1e308,NaN,Infinity,true,false,null,[],{},{a:1},['x'],'__proto__','constructor','prototype','a'.repeat(5000),[...'abc'],{__proto__:null},'\u0000','../../etc/passwd',2**53,-0,0.5];
function paths(value){const found=[];(function walk(node,path){if(node&&typeof node==='object')for(const key of Object.keys(node)){found.push([...path,key]);walk(node[key],[...path,key]);}})(value,[]);return found;}
function mutate(random){
 const copy=structuredClone(manifest);
 for(let i=0;i<1+Math.floor(random()*3);i++){
  const list=paths(copy),path=pick(random,list);let node=copy;for(const key of path.slice(0,-1))node=node[key];const last=path.at(-1),roll=random();
  if(roll<0.2)delete node[last];
  else if(roll<0.3){node[pick(random,['__proto__','constructor','polluted','extra'])]=pick(random,junk);}
  else node[last]=typeof pick(random,junk)==='object'?structuredClone(pick(random,junk)):pick(random,junk);
 }
 if(random()<0.05)JSON.parse('{"__proto__":{"polluted":true}}');
 return copy;
}

test('hostile agent manifests are rejected with an Error, persist nothing and never pollute prototypes',()=>{
 const random=rng(2026);let accepted=0,rejected=0;
 for(let i=0;i<2000;i++){
  const definitions=new SqliteAgentDefinitions(':memory:'),candidate=mutate(random);
  try{
   try{definitions.save('tenant',candidate,0);accepted++;
    // An accepted manifest is stored as exactly one immutable, retrievable version for the right tenant and agent.
    const stored=definitions.get('tenant',candidate.agentId);assert.equal(stored.version,1);assert.equal(stored.manifest.tenantId,'tenant');assert.equal(definitions.get('other',candidate.agentId),undefined);
   }catch(error){
    if(error?.code==='ERR_ASSERTION')throw error;
    rejected++;assert.ok(error instanceof Error,'non-Error thrown');
    assert.equal(definitions.list('tenant').length,0,`rejected manifest left a stored version (${error.message})`);
   }
  }finally{definitions.close();}
  assert.equal(({}).polluted,undefined,'Object.prototype was polluted');assert.equal(Object.prototype.hasOwnProperty('polluted'),false);
 }
 assert.ok(rejected>500&&accepted>20,`fuzz corpus too one-sided (accepted ${accepted}, rejected ${rejected})`);
});

test('non-object, cyclic and oversized manifests are rejected without storing anything',()=>{
 const definitions=new SqliteAgentDefinitions(':memory:'),cyclic=structuredClone(manifest);cyclic.self=cyclic;
 try{
  for(const bad of [undefined,null,0,'x',[],[manifest],cyclic,{...manifest,name:'x'.repeat(100000)},{...manifest,administrators:Array.from({length:100000},(_,i)=>`a${i}`)},Object.create(manifest)]){
   assert.throws(()=>definitions.save('tenant',bad,0),(error)=>error instanceof Error);
  }
  // Inherited, accessor and non-plain values cannot satisfy validation, at the root or nested.
  class Owner{constructor(){this.kind='organization';this.id='org';}}
  const getter={...manifest};Object.defineProperty(getter,'name',{enumerable:true,get:()=>'Agent'});
  for(const bad of [{...manifest,owner:Object.create(manifest.owner)},{...manifest,owner:new Owner()},getter,{...manifest,administrators:Object.assign(Object.create(Array.prototype),{0:'admin',length:1})},{...manifest,model:Object.create({provider:'local',model:'test'})},{...manifest,[Symbol('x')]:1}])assert.throws(()=>definitions.save('tenant',bad,0),/Invalid agent manifest/);
  for(const tenant of [undefined,null,'',' ','a/b','x'.repeat(5000),{},[]])assert.throws(()=>definitions.save(tenant,manifest,0),(error)=>error instanceof Error);
  for(const expected of [-1,1.5,NaN,'0',null,undefined,2**53])assert.throws(()=>definitions.save('tenant',manifest,expected),(error)=>error instanceof Error);
  assert.equal(definitions.list('tenant').length,0);
  assert.equal(definitions.save('tenant',manifest,0).version,1);
 }finally{definitions.close();}
});
