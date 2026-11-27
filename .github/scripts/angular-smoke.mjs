import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {domTree,variantTree,textFieldState} from '../../packages/native/test/support/web-dom.mjs';

const dir=process.env.ANGULAR_SMOKE_DIR;if(!dir)throw Error('ANGULAR_SMOKE_DIR is required');
const require=createRequire(resolve(dir,'package.json'));
const {JSDOM}=require('jsdom');const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.Node=dom.window.Node;globalThis.HTMLElement=dom.window.HTMLElement;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const load=specifier=>import(pathToFileURL(require.resolve(specifier)).href);
await load('zone.js/node');await load('@angular/compiler');
const {TestBed}=await load('@angular/core/testing');
const {BrowserDynamicTestingModule,platformBrowserDynamicTesting}=await load('@angular/platform-browser-dynamic/testing');
const {A2UIComponent}=await import(pathToFileURL(resolve(dir,'dist/index.js')).href);
const {APP_MIXER_CATALOG}=await import(pathToFileURL(resolve('packages/web/dist/index.js')).href);
// TASK-049: the shared fixtures that the web, React Native and Flutter tests already run, each driven through a fresh bridge below.
const fixtures={};for(const name of ['layout','bindings','actions','text-field','variants','rejections'])fixtures[name]=JSON.parse(await readFile(new URL(`../../adapters/flutter/test/fixtures/${name}.json`,import.meta.url),'utf8'));
TestBed.initTestEnvironment(BrowserDynamicTestingModule,platformBrowserDynamicTesting());
TestBed.configureTestingModule({imports:[A2UIComponent]});
const fixture=TestBed.createComponent(A2UIComponent);let receive,late,unsubscribed=0,swaps=1;const actions=[],errors=[];
fixture.componentInstance.action.subscribe(message=>actions.push(message));fixture.componentInstance.error.subscribe(error=>errors.push(error));
const subscribe=fn=>{receive=fn;return ()=>{unsubscribed++;throw Error('cleanup failed');};};
try {
 fixture.componentRef.setInput('subscribe',subscribe);fixture.detectChanges();await fixture.whenStable();
 assert.equal(typeof receive,'function');
 receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save'}}},{id:'label',component:'Text',text:'Save'}]}});
 const button=fixture.nativeElement.querySelector('button');assert.equal(button.textContent,'Save');button.click();assert.equal(actions[0].action.name,'save');
 receive({version:'invalid'});assert.equal(errors.length,1);
 late=receive;fixture.componentRef.setInput('subscribe',fn=>{receive=fn;return ()=>{unsubscribed++;};});fixture.detectChanges();await fixture.whenStable();
 assert.equal(unsubscribed,1);assert.equal(fixture.nativeElement.querySelector('button'),null);late({version:'invalid'});assert.equal(errors.length,2);assert.equal(errors[1].message,'cleanup failed');
 receive({version:'v0.9.1',createSurface:{surfaceId:'new',catalogId:APP_MIXER_CATALOG}});
 receive({version:'v0.9.1',updateComponents:{surfaceId:'new',components:[{id:'root',component:'Text',text:'Connected'}]}});
 assert.match(fixture.nativeElement.textContent,/Connected/);
 // TASK-049: every shared fixture through a fresh bridge, the DOM read by the normalisers parity.test.mjs applies to the web renderer.
 // Each swap disconnects the previous source and clears its DOM, so the fixture's surface is always the host's first child.
 const fresh=async()=>{swaps++;fixture.componentRef.setInput('subscribe',fn=>{receive=fn;return ()=>{unsubscribed++;};});fixture.detectChanges();await fixture.whenStable();assert.equal(unsubscribed,swaps);assert.equal(fixture.nativeElement.children.length,0);};
 const root=()=>fixture.nativeElement.children[0]?.children[0];
 await fresh();
 fixtures.layout.forEach((step,index)=>{receive(step.message);assert.deepEqual(root()?domTree(root()):null,step.tree,'layout step '+index);});
 await fresh();
 fixtures.bindings.forEach(step=>{receive(step.message);assert.equal(root()?.textContent??null,step.text);});
 await fresh();
 for(const message of fixtures.actions.messages)receive(message);
 fixture.nativeElement.querySelector('button').click();const action={...actions.at(-1).action};delete action.timestamp;assert.deepEqual(action,fixtures.actions.action);
 await fresh();
 fixtures['text-field'].forEach((step,index)=>{
  if(step.message)receive(step.message);else{const input=root().children[0].children[1];input.value=step.input;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
  assert.deepEqual(textFieldState(root()),{field:step.field,text:step.text},'text-field step '+index);
 });
 await fresh();
 fixtures.variants.forEach((step,index)=>{receive(step.message);assert.deepEqual(root()?variantTree(root()):null,step.tree,'variants step '+index);});
 await fresh();
 receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Text',text:'Safe'}]}});
 // A rejected message is emitted as an error and leaves the surface as it was.
 for(const invalid of fixtures.rejections){const before=errors.length;receive(invalid);assert.equal(errors.length,before+1,JSON.stringify(invalid));assert.equal(root().textContent,'Safe');}
 assert.equal(errors.length,2+fixtures.rejections.length,'no other fixture emits an error');
 fixture.destroy();assert.equal(unsubscribed,swaps+1);receive({version:'invalid'});assert.equal(errors.length,2+fixtures.rejections.length);
}finally{TestBed.resetTestingModule();dom.window.close();}
