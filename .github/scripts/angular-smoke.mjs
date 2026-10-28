import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

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
TestBed.initTestEnvironment(BrowserDynamicTestingModule,platformBrowserDynamicTesting());
TestBed.configureTestingModule({imports:[A2UIComponent]});
const fixture=TestBed.createComponent(A2UIComponent);let receive,late,unsubscribed=0;const actions=[],errors=[];
fixture.componentInstance.action.subscribe(message=>actions.push(message));fixture.componentInstance.error.subscribe(error=>errors.push(error));
const subscribe=fn=>{receive=fn;return ()=>{unsubscribed++;};};
try {
 fixture.componentRef.setInput('subscribe',subscribe);fixture.detectChanges();await fixture.whenStable();
 assert.equal(typeof receive,'function');
 receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
 receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save'}}},{id:'label',component:'Text',text:'Save'}]}});
 const button=fixture.nativeElement.querySelector('button');assert.equal(button.textContent,'Save');button.click();assert.equal(actions[0].action.name,'save');
 receive({version:'invalid'});assert.equal(errors.length,1);
 late=receive;fixture.componentRef.setInput('subscribe',fn=>{receive=fn;return ()=>{unsubscribed++;};});fixture.detectChanges();await fixture.whenStable();
 assert.equal(unsubscribed,1);assert.equal(fixture.nativeElement.querySelector('button'),null);late({version:'invalid'});assert.equal(errors.length,1);
 fixture.destroy();assert.equal(unsubscribed,2);receive({version:'invalid'});assert.equal(errors.length,1);
}finally{TestBed.resetTestingModule();dom.window.close();}
