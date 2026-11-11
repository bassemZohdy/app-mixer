// A real browser provisions itself from a grant carried to it out of band: it verifies the grant and the signed
// release with its own WebCrypto Ed25519, seeds the encrypted publication cache and queue, and after a browser
// restart still has both, without the grant or any server call. Opt-in: APP_MIXER_TEST_BROWSER=1 with headless
// Chrome or Edge (CHROME_BIN, or found in the usual install location).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createGrant,startProvisioningServer} from './support/provisioning-fixture.mjs';

const browserBinary=process.env.CHROME_BIN||['/usr/bin/google-chrome','/usr/bin/chromium','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path=>existsSync(path));
const enabled=process.env.APP_MIXER_TEST_BROWSER==='1',dist=fileURLToPath(new URL('../dist/',import.meta.url));

test('a real browser provisions itself offline and keeps its publication and queue across a restart',{skip:!enabled?'set APP_MIXER_TEST_BROWSER=1 to run in a real browser':browserBinary?false:'no Chrome or Edge found; set CHROME_BIN',timeout:300000},async t=>{
 const {keys,carried}=createGrant(),fixture=await startProvisioningServer({dist,keys,carried}),server=fixture.server;
 const dir=await mkdtemp(join(tmpdir(),'browser-provisioning-')),profile=join(dir,'profile');
 const visit=()=>new Promise((resolve,reject)=>execFile(browserBinary,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--user-data-dir='+profile,'--dump-dom',`http://127.0.0.1:${server.address().port}/app.html`],{timeout:90000,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
 try{
  let dom=await visit();assert.ok(fixture.report,dom.slice(0,500));assert.equal(fixture.report.fatal,undefined,fixture.report.fatal);
  assert.equal(fixture.report.tampered,'Invalid offline provisioning','the browser rejects an altered grant');
  assert.deepEqual([fixture.report.principal,fixture.report.version,fixture.report.queued,fixture.report.requests],['field-worker',5,['site-1','site-2'],0],JSON.stringify(fixture.report));
  // Restart the browser with the same profile and without the grant: everything comes from local storage.
  fixture.withGrant=false;dom=await visit();assert.ok(fixture.report,dom.slice(0,500));assert.equal(fixture.report.fatal,undefined,fixture.report.fatal);
  assert.deepEqual([fixture.report.version,fixture.report.queued,fixture.report.requests],[5,['site-1','site-2'],0],JSON.stringify(fixture.report));
  t.diagnostic(`browser verified the grant with WebCrypto Ed25519 and kept ${fixture.report.queued.length} queued operations across a restart; modules served: ${[...new Set(fixture.modules)].join(', ')}`);
 }finally{server.close();await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
});
