// Runs the offline provisioning scenario in Chrome on an Android emulator (or device) reached through adb:
// the page verifies a signed grant with WebCrypto, seeds the encrypted cache and queue, and must still have both after
// Chrome is killed and started again. Then Android clears the browser's data (what a user or the system's storage
// management does) and the app must report that its state is gone, and recover when re-provisioned.
// Backup and restore are not covered: Chrome's data is excluded from Android backup.
// Needs a Chrome build (com.android.chrome, a google_apis system image), adb on the PATH and the built web package.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createGrant,startProvisioningServer} from '../test/support/provisioning-fixture.mjs';

const run=promisify(execFile),adb=async(...args)=>(await run('adb',args,{timeout:60000,maxBuffer:8*1024*1024})).stdout;
const chrome='com.android.chrome',dist=fileURLToPath(new URL('../dist/',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const {keys,carried}=createGrant(),fixture=await startProvisioningServer({dist,keys,carried}),url=`http://127.0.0.1:${fixture.port}/app.html`;
const visit=async(label,seconds=120)=>{
 fixture.report=undefined;
 await adb('shell','am','start','-a','android.intent.action.VIEW','-d',url,'-n',`${chrome}/com.google.android.apps.chrome.Main`);
 const deadline=Date.now()+seconds*1000;
 while(fixture.report===undefined&&Date.now()<deadline)await pause(500);
 if(fixture.report===undefined){
  const log=await adb('logcat','-d','-t','200').catch(()=>'');
  throw Error(`${label}: Chrome did not report within ${seconds} s\n${log.split('\n').filter(line=>/chromium|Console|AndroidRuntime/i.test(line)).slice(-40).join('\n')}`);
 }
 console.log(label,JSON.stringify(fixture.report));
 return fixture.report;
};

try{
 await adb('wait-for-device');
 await adb('reverse',`tcp:${fixture.port}`,`tcp:${fixture.port}`);
 // Skip the first-run screens so the page loads straight away (the emulator image is a debuggable build).
 await adb('shell','pm','clear',chrome);
 await adb('shell',"echo 'chrome --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line");
 await adb('shell','am','set-debug-app','--persistent',chrome);

 let report=await visit('first start with the grant');
 assert.equal(report.fatal,undefined,report.fatal);
 assert.equal(report.tampered,'Invalid offline provisioning','the device rejects an altered grant');
 assert.deepEqual([report.principal,report.version,report.queued,report.requests],['field-worker',5,['site-1','site-2'],0],JSON.stringify(report));

 await adb('shell','am','force-stop',chrome);
 fixture.withGrant=false;
 report=await visit('after Chrome was killed, without the grant');
 assert.equal(report.fatal,undefined,report.fatal);
 assert.deepEqual([report.version,report.queued,report.requests],[5,['site-1','site-2'],0],JSON.stringify(report));

 // Android clears the browser's data: nothing may be served from storage that is gone.
 await adb('shell','pm','clear',chrome);
 await adb('shell',"echo 'chrome --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line");
 report=await visit('after Android cleared the browser data, without the grant');
 assert.notEqual(report.fatal,undefined,'the app reports that its provisioned state is gone');
 assert.equal(report.queued,undefined,'no queue is served from cleared storage');

 fixture.withGrant=true;
 report=await visit('re-provisioned with the grant');
 assert.equal(report.fatal,undefined,report.fatal);
 assert.deepEqual([report.principal,report.version,report.queued],['field-worker',5,['site-1','site-2']],JSON.stringify(report));
 console.log('Chrome on Android kept the encrypted queue and publication across a kill, reported cleared storage and recovered when re-provisioned; modules served: '+[...new Set(fixture.modules)].join(', '));
}finally{
 fixture.server.close();
 await adb('shell','am','force-stop',chrome).catch(()=>{});
 await adb('shell','rm','-f','/data/local/tmp/chrome-command-line').catch(()=>{});
}
