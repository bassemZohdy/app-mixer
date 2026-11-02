import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {DEVELOPMENT_UI} from '../../core/dist/development-ui.js';
import {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry} from '../../web/dist/index.js';
const wait=async predicate=>{for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
const id='00000000-0000-0000-0000-000000000000',proposal=title=>({id,status:'pending',patches:[],preview:{schemaVersion:1,pages:[{title,components:[]}]}}),ok=result=>({ok:true,json:async()=>result});
function setup(fetch){const dom=new JSDOM(DEVELOPMENT_UI),document=dom.window.document,script=DEVELOPMENT_UI.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import [^;]+;\s*/gm,'');runInNewContext(script,{document,A2UIRenderer,APP_MIXER_CATALOG,basicRegistry,installedExtensions:[],fetch});document.getElementById('token').value='operator';document.getElementById('proposal-id').value=id;return {dom,document};}

test('late proposal generation cannot replace a newer selection',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),s=setup(async path=>path==='/development/propose'?gate:ok(proposal('Selected')));try{const d=s.document;d.getElementById('instruction').value='Create';d.getElementById('generate').click();d.getElementById('load').click();await wait(()=>d.getElementById('rendered-preview').textContent.includes('Selected'));release(ok(proposal('Older generation')));await wait(()=>!d.getElementById('generate').disabled);assert.match(d.getElementById('rendered-preview').textContent,/Selected/);assert.doesNotMatch(d.getElementById('preview').textContent,/Older generation/);assert.equal(d.getElementById('approve').disabled,false);
 }finally{release?.();s.dom.window.close();}
});

test('late approval cannot enable publishing after the same proposal is reloaded',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),s=setup(async path=>path.endsWith('/approve')?gate:ok(proposal('Current')));try{const d=s.document;d.getElementById('load').click();await wait(()=>!d.getElementById('approve').disabled);d.getElementById('approve').click();d.getElementById('load').click();await wait(()=>!d.getElementById('approve').disabled);release(ok({id,status:'approved',approvedRevision:2}));await new Promise(resolve=>setImmediate(resolve));assert.equal(d.getElementById('publish').disabled,true);assert.equal(d.getElementById('approve').disabled,false);assert.equal(d.getElementById('status').textContent,'Proposal: pending');
 }finally{release?.();s.dom.window.close();}
});

test('changing the token invalidates pending proposal loads and errors',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),s=setup(()=>gate);try{const d=s.document;d.getElementById('load').click();d.getElementById('token').value='different';d.getElementById('token').dispatchEvent(new s.dom.window.Event('input'));release({ok:false,json:async()=>({error:'Old error'})});await new Promise(resolve=>setImmediate(resolve));assert.equal(d.getElementById('approve').disabled,true);assert.equal(d.getElementById('preview').textContent,'No proposal loaded.');assert.notEqual(d.getElementById('status').textContent,'Old error');
 }finally{release?.();s.dom.window.close();}
});
