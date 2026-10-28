import test from 'node:test';
import assert from 'node:assert/strict';
import {A2UIRenderer,APP_MIXER_CATALOG} from '../dist/index.js';
import {createReactA2UIComponent} from '@app-mixer/web/react';

class Element {
  constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.listeners={};}
  appendChild(child){child.parent=this;this.children.push(child);return child;}
  replaceChildren(...children){this.children=[];for(const child of children)this.appendChild(child);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  addEventListener(type,callback){this.listeners[type]=callback;}
}
const doc={createElement:tag=>new Element(tag,doc)};
const makeReact=()=>{const effects=[];return {createElement:(type,props)=>({type,props}),useRef:value=>({current:value}),useEffect:callback=>{effects.push(callback);},mount:element=>{element.props.ref.current=doc.createElement('div');const cleanups=effects.map(effect=>effect());return {host:element.props.ref.current,cleanup:()=>{for(const fn of cleanups)if(fn)fn();}};}};};
const create={version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}};
const tree={version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Column',children:['message','button']},{id:'message',component:'Text',text:{path:'/name'}},{id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/name'}}}}},{id:'label',component:'Text',text:'Save'}]}};
const data={version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{name:'Ada'}}};
const view=node=>({tag:node.tagName,text:node.textContent,style:node.style,children:node.children.map(view)});

test('React host bridge matches DOM rendering, forwards events and cleans up',()=>{
  let receive,unsubscribed=false;const actions=[],errors=[];
  const react=makeReact(),Component=createReactA2UIComponent(react);
  const element=Component({subscribe:send=>{receive=send;return ()=>{unsubscribed=true;};},onAction:x=>actions.push(x),onError:x=>errors.push(x)});
  const {host,cleanup}=react.mount(element);
  const nativeHost=doc.createElement('div'),native=new A2UIRenderer(nativeHost,undefined,()=>{});
  for(const message of [create,data,tree]){receive(message);native.apply(message);}
  assert.deepEqual(view(host),view(nativeHost));
  host.children[0].children[0].children[1].listeners.click();assert.equal(actions[0].action.name,'save');assert.deepEqual(actions[0].action.context,{name:'Ada'});
  receive({version:'invalid'});assert.equal(errors.length,1);assert.deepEqual(view(host),view(nativeHost));
  cleanup();assert.equal(unsubscribed,true);assert.equal(host.children.length,0);receive(create);assert.equal(host.children.length,0);
});

test('React host bridge cleans up after a synchronous subscription failure',()=>{
 const react=makeReact(),errors=[],Component=createReactA2UIComponent(react);
 const element=Component({subscribe:()=>{throw Error('connect failed');},onAction:()=>{},onError:e=>errors.push(e.message)});
 const {host,cleanup}=react.mount(element);assert.deepEqual(errors,['connect failed']);cleanup();assert.equal(host.children.length,0);
});
