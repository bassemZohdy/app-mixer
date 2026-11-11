// Runs the offline provisioning scenario (browser-storage-scenario.mjs) in Safari on an iOS Simulator (macOS with
// Xcode). The simulator shares the host's network, so the page reaches the test server at 127.0.0.1. The platform
// clears the browser's data by erasing the simulator, the strongest form of what a user's "Clear History and Website
// Data" does. Eviction under storage pressure and backup/restore are not covered.
// SIMULATOR_NAME picks the device (default: the first available iPhone on the newest iOS runtime).
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createGrant,startProvisioningServer} from '../test/support/provisioning-fixture.mjs';
import {runBrowserStorageScenario} from './browser-storage-scenario.mjs';

const run=promisify(execFile),simctl=async(...args)=>(await run('xcrun',['simctl',...args],{timeout:300000,maxBuffer:16*1024*1024})).stdout;
const dist=fileURLToPath(new URL('../dist/',import.meta.url)),safari='com.apple.mobilesafari';

const devices=JSON.parse(await simctl('list','devices','available','-j')).devices;
const candidates=Object.entries(devices)
 .filter(([runtime])=>/iOS/.test(runtime))
 .sort(([a],[b])=>b.localeCompare(a,undefined,{numeric:true}))
 .flatMap(([runtime,list])=>list.filter(device=>/iPhone/.test(device.name)).map(device=>({...device,runtime})));
const device=process.env.SIMULATOR_NAME?candidates.find(item=>item.name===process.env.SIMULATOR_NAME):candidates[0];
if(!device)throw Error('No available iPhone simulator');
console.log('simulator',device.name,device.runtime,device.udid);

const {keys,carried}=createGrant(),fixture=await startProvisioningServer({dist,keys,carried});
const boot=async()=>{
 await simctl('boot',device.udid).catch(error=>{if(!/current state: Booted/.test(String(error.stderr)))throw error;});
 await simctl('bootstatus',device.udid,'-b');
};
try{
 await boot();
 await runBrowserStorageScenario({
  fixture,url:`http://127.0.0.1:${fixture.port}/app.html`,name:'Safari on iOS',allowUnsupported:process.env.ALLOW_UNSUPPORTED==='1',
  open:url=>simctl('openurl',device.udid,url),
  kill:()=>simctl('terminate',device.udid,safari).catch(()=>{}),
  clearData:async()=>{await simctl('shutdown',device.udid).catch(()=>{});await simctl('erase',device.udid);await boot();}
 });
}finally{
 fixture.server.close();
 await simctl('shutdown',device.udid).catch(()=>{});
}
