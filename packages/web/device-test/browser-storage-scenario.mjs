// The offline provisioning scenario for a browser on a phone, shared by the Android (adb) and iOS (simctl) runs.
// A platform supplies how to open the page, kill the browser and clear its data. The page verifies a signed grant with
// WebCrypto, seeds the encrypted cache and queue, and must still have both after the browser is killed. After the
// platform clears the browser's data the app must report that its state is gone, and it must recover when
// provisioned again. Offline provisioning needs WebCrypto Ed25519; with allowUnsupported a browser without it passes
// by reporting that clearly.
import assert from 'node:assert/strict';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** @param {{fixture:any,url:string,open:(url:string)=>Promise<void>,kill:()=>Promise<void>,clearData:()=>Promise<void>,diagnostics?:()=>Promise<string>,name:string,allowUnsupported?:boolean,settleMs?:number}} platform */
export async function runBrowserStorageScenario({fixture,url,open,kill,clearData,diagnostics,name,allowUnsupported=false,settleMs=10000}){
 const visit=async(label,seconds=120)=>{
  fixture.report=undefined;
  await open(url);
  const deadline=Date.now()+seconds*1000;
  while(fixture.report===undefined&&Date.now()<deadline)await pause(500);
  if(fixture.report===undefined)throw Error(`${label}: ${name} did not report within ${seconds} s\n${await diagnostics?.().catch(()=>'')??''}`);
  console.log(label,JSON.stringify(fixture.report));
  return fixture.report;
 };
 let report=await visit('first start with the grant');
 if(allowUnsupported&&/requires WebCrypto Ed25519/.test(report.fatal??'')){
  console.log('This browser has no WebCrypto Ed25519 and says so; nothing was stored.');
  return 'unsupported';
 }
 assert.equal(report.fatal,undefined,report.fatal);
 assert.equal(report.tampered,'Invalid offline provisioning','the device rejects an altered grant');
 assert.deepEqual([report.principal,report.version,report.queued,report.requests],['field-worker',5,['site-1','site-2'],0],JSON.stringify(report));

 // Browsers commit localStorage a few seconds after a write, so a kill right after the first start can lose the page's
 // own marker (seen in Chrome on Android: the app then reports no provisioned state). Let the writes settle, as they do
 // in any session that lasts more than a moment.
 await pause(settleMs);
 await kill();
 fixture.withGrant=false;
 report=await visit('after the browser was killed, without the grant');
 assert.equal(report.fatal,undefined,report.fatal);
 assert.deepEqual([report.version,report.queued,report.requests],[5,['site-1','site-2'],0],JSON.stringify(report));

 // The platform clears the browser's data: nothing may be served from storage that is gone.
 await clearData();
 report=await visit('after the platform cleared the browser data, without the grant');
 assert.notEqual(report.fatal,undefined,'the app reports that its provisioned state is gone');
 assert.equal(report.queued,undefined,'no queue is served from cleared storage');

 fixture.withGrant=true;
 report=await visit('re-provisioned with the grant');
 assert.equal(report.fatal,undefined,report.fatal);
 assert.deepEqual([report.principal,report.version,report.queued],['field-worker',5,['site-1','site-2']],JSON.stringify(report));
 console.log(`${name} kept the encrypted queue and publication across a kill, reported cleared storage and recovered when re-provisioned; modules served: `+[...new Set(fixture.modules)].join(', '));
 return 'passed';
}
