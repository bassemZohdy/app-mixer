import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteRemoteRollout,RemoteRolloutPoller} from '../dist/index.js';

function stub(){const rollout=Object.create(SqliteRemoteRollout.prototype);rollout.runs=0;rollout.fail=false;rollout.runOnce=async()=>{rollout.runs++;if(rollout.fail)throw Error('source unavailable');return {status:'unchanged',sourceVersion:1,targetVersion:1};};rollout.getState=async()=>({phase:'idle'});return rollout;}
const waits=async(options,count,failing=false)=>{const delays=[],real=globalThis.setTimeout,rollout=stub();rollout.fail=failing;
 globalThis.setTimeout=(fn,ms,...rest)=>{delays.push(ms);return real(fn,0,...rest);};
 const poller=new RemoteRolloutPoller({rollout,intervalMs:1000,maxBackoffMs:8000,onResult:()=>{},onError:()=>{},...options});
 try{poller.start();while(delays.length<count)await new Promise(resolve=>real(resolve,5));}finally{await poller.stop();globalThis.setTimeout=real;}return delays.slice(0,count);};

test('rollout poller jitter shortens waits within the configured ratio and never exceeds the backoff cap',async()=>{
 assert.deepEqual(await waits({},3),[1000,1000,1000]);
 assert.deepEqual(await waits({jitterRatio:0.2,random:()=>0},2),[1000,1000]);
 assert.deepEqual(await waits({jitterRatio:0.2,random:()=>0.5},2),[900,900]);
 const spread=await waits({jitterRatio:0.5},40);assert.ok(spread.every(ms=>ms>=500&&ms<=1000));assert.ok(new Set(spread).size>10);
 const failures=await waits({jitterRatio:0.25,random:()=>0.999},8,true);assert.ok(failures.every(ms=>ms<=8000));assert.ok(failures.at(-1)>=6000,'backoff still grows toward the cap');
 assert.deepEqual(await waits({jitterRatio:0.3,random:()=>NaN},2),[1000,1000]);
 assert.deepEqual(await waits({jitterRatio:0.3,random:()=>{throw Error('entropy unavailable');}},3),[1000,1000,1000]);
 assert.deepEqual(await waits({random:()=>{throw Error('unused without jitter');}},2),[1000,1000]);
 for(const bad of [{jitterRatio:-0.1},{jitterRatio:0.51},{jitterRatio:'0.1'},{jitterRatio:NaN},{random:1}])assert.throws(()=>new RemoteRolloutPoller({rollout:stub(),intervalMs:1000,maxBackoffMs:2000,onResult:()=>{},onError:()=>{},...bad}),/Invalid rollout poller/);
});
