// Runs the offline provisioning scenario (browser-storage-scenario.mjs) in a browser on an Android emulator or device
// reached through adb. Android clears the browser's data with `pm clear`, what a user or the system's storage
// management does. Backup and restore are not covered: Chrome's data is excluded from Android backup.
// Needs adb on the PATH, the built web package and a Chromium-based browser on the device: Chrome from a google_apis system
// image by default, or ANDROID_BROWSER_PACKAGE (with ANDROID_BROWSER_APK to install it). ALLOW_UNSUPPORTED=1 lets a
// browser without WebCrypto Ed25519 pass by reporting that clearly.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createGrant,startProvisioningServer} from '../test/support/provisioning-fixture.mjs';
import {runBrowserStorageScenario} from './browser-storage-scenario.mjs';

const run=promisify(execFile),adb=async(...args)=>(await run('adb',args,{timeout:60000,maxBuffer:8*1024*1024})).stdout;
const chrome=process.env.ANDROID_BROWSER_PACKAGE||'com.android.chrome',apk=process.env.ANDROID_BROWSER_APK,dist=fileURLToPath(new URL('../dist/',import.meta.url));
const commandLine="echo 'chrome --disable-fre --no-first-run --no-default-browser-check' > /data/local/tmp/chrome-command-line";

const {keys,carried}=createGrant(),fixture=await startProvisioningServer({dist,keys,carried});
try{
 await adb('wait-for-device');
 await adb('reverse',`tcp:${fixture.port}`,`tcp:${fixture.port}`);
 if(apk)await adb('install','-r','-g',apk);
 console.log('browser',chrome,((await adb('shell','dumpsys','package',chrome)).match(/versionName=\S+/)??['unknown version'])[0]);
 // Skip the first-run screens so the page loads straight away (the emulator image is a debuggable build).
 await adb('shell','pm','clear',chrome);
 await adb('shell',commandLine);
 await adb('shell','am','set-debug-app','--persistent',chrome);
 await runBrowserStorageScenario({
  fixture,url:`http://127.0.0.1:${fixture.port}/app.html`,name:'Chrome on Android',allowUnsupported:process.env.ALLOW_UNSUPPORTED==='1',
  open:url=>adb('shell','am','start','-a','android.intent.action.VIEW','-d',url,'-p',chrome),
  kill:()=>adb('shell','am','force-stop',chrome),
  clearData:async()=>{await adb('shell','pm','clear',chrome);await adb('shell',commandLine);},
  diagnostics:async()=>(await adb('logcat','-d','-t','200')).split('\n').filter(line=>/chromium|Console|AndroidRuntime/i.test(line)).slice(-40).join('\n')
 });
}finally{
 fixture.server.close();
 await adb('shell','am','force-stop',chrome).catch(()=>{});
 await adb('shell','rm','-f','/data/local/tmp/chrome-command-line').catch(()=>{});
}
