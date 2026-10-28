import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {createReactA2UIComponent} from '../../packages/web/dist/react.js';
import {APP_MIXER_CATALOG} from '../../packages/web/dist/index.js';

if(!process.env.REACT_SMOKE_DEPS)throw Error('REACT_SMOKE_DEPS is required');
const require=createRequire(resolve(process.env.REACT_SMOKE_DEPS,'package.json'));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'http://localhost/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');const {createRoot}=require('react-dom/client');
const A2UI=createReactA2UIComponent(React);const root=createRoot(document.getElementById('app'));
let receive,unsubscribed=0;const errors=[],actions=[];
const subscribe=callback=>{receive=callback;return ()=>{unsubscribed++;};};
const onError=error=>errors.push(error);
const render=(onAction,source=subscribe)=>React.createElement(React.StrictMode,null,React.createElement(A2UI,{subscribe:source,onAction,onError}));
try{
 await React.act(()=>root.render(render(message=>actions.push(['first',message]))));
 await React.act(()=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save'}}},{id:'label',component:'Text',text:'Save'}]}});
 });
 assert.equal(document.querySelector('button').textContent,'Save');
 await React.act(()=>root.render(render(message=>actions.push(['updated',message]))));
 await React.act(()=>document.querySelector('button').click());
 assert.equal(actions[0][0],'updated');assert.equal(actions[0][1].action.name,'save');assert.deepEqual(errors,[]);
 const oldReceive=receive;let newReceive;
 const newSubscribe=callback=>{newReceive=callback;return ()=>{unsubscribed++;};};
 await React.act(()=>root.render(render(message=>actions.push(['updated',message]),newSubscribe)));
 assert.equal(unsubscribed,2);assert.equal(document.querySelector('button'),null);
 oldReceive({version:'invalid'});assert.deepEqual(errors,[]);
 await React.act(()=>{newReceive({version:'v0.9.1',createSurface:{surfaceId:'new',catalogId:APP_MIXER_CATALOG}});newReceive({version:'v0.9.1',updateComponents:{surfaceId:'new',components:[{id:'root',component:'Text',text:'New source'}]}});});
 assert.match(document.getElementById('app').textContent,/New source/);
 await React.act(()=>root.unmount());assert.equal(unsubscribed,3);newReceive({version:'invalid'});assert.deepEqual(errors,[]);
 const root2=createRoot(document.getElementById('app'));let next;const failures=[];
 const broken=()=>()=>{throw Error('cleanup failed');},replacement=callback=>{next=callback;};
 await React.act(()=>root2.render(React.createElement(A2UI,{subscribe:broken,onAction:()=>{},onError:error=>failures.push(error.message)})));
 await React.act(()=>root2.render(React.createElement(A2UI,{subscribe:replacement,onAction:()=>{},onError:error=>failures.push(error.message)})));
 assert.deepEqual(failures,['cleanup failed']);
 await React.act(()=>{next({version:'v0.9.1',createSurface:{surfaceId:'after',catalogId:APP_MIXER_CATALOG}});next({version:'v0.9.1',updateComponents:{surfaceId:'after',components:[{id:'root',component:'Text',text:'Connected'}]}});});
 assert.match(document.getElementById('app').textContent,/Connected/);await React.act(()=>root2.unmount());
}finally{dom.window.close();}
