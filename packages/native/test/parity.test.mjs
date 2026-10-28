import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NativeSurfaceStore,APP_MIXER_CATALOG} from '../dist/index.js';
import {A2UIRenderer} from '../../web/dist/index.js';

class Element {
 constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.parent=null;this.listeners={};this.value='';}
 appendChild(child){child.parent=this;this.children.push(child);return child;}
 replaceChildren(...children){this.children=[];for(const child of children)this.appendChild(child);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
 addEventListener(event,fn){this.listeners[event]=fn;}
}
const doc={createElement:tag=>new Element(tag,doc)};
const domTree=node=>{
 if(node.tagName==='span'&&!node.children.length&&!node.textContent)return undefined;
 const kind=node.tagName==='section'?'Card':node.tagName==='div'?(node.style.flexDirection==='row'?'Row':'Column'):'Text';
 return {kind,...(kind==='Text'?{text:node.textContent}:{}),...(kind==='Row'||kind==='Column'?{justify:node.style.justifyContent??null,align:node.style.alignItems??null}:{}),children:node.children.map(domTree).filter(Boolean)};
};
const styleValues={start:'flex-start',center:'center',end:'flex-end',stretch:'stretch',spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'};
const nativeTree=node=>({kind:node.kind,...(node.kind==='Text'?{text:node.text}:{}),...(node.kind==='Row'||node.kind==='Column'?{justify:node.justify?styleValues[node.justify]:null,align:node.align?styleValues[node.align]:null}:{}),children:node.children.map(nativeTree)});
const message=(kind,payload)=>({version:'v0.9.1',[kind]:payload});

test('web and native render the same supported static component hierarchy across updates',()=>{
 const host=doc.createElement('main'),web=new A2UIRenderer(host),native=new NativeSurfaceStore();
 const apply=value=>{web.apply(value);native.apply(value);};
 apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Column',children:['heading','card','later'],align:'center'},{id:'heading',component:'Text',text:'Literal <tag>',variant:'h1'},{id:'card',component:'Card',child:'row'},{id:'row',component:'Row',children:['one','two'],justify:'spaceBetween'},{id:'one',component:'Text',text:'One'},{id:'two',component:'Text',text:'Two'}]}));
 const compare=()=>assert.deepEqual(domTree(host.children[0].children[0]),nativeTree(native.snapshot()[0].root));
 compare();apply(message('updateComponents',{surfaceId:'main',components:[{id:'later',component:'Text',text:'Loaded'},{id:'two',component:'Text',text:'Updated'}]}));compare();
 const cyclic=message('updateComponents',{surfaceId:'main',components:[{id:'row',component:'Row',children:['root']}]});
 assert.throws(()=>web.apply(cyclic),/Cyclic/);assert.throws(()=>native.apply(cyclic),/Cyclic/);compare();
 apply(message('deleteSurface',{surfaceId:'main'}));assert.equal(host.children.length,0);assert.deepEqual(native.snapshot(),[]);
});

test('web and native agree on data-bound text and nested updates',()=>{
 const host=doc.createElement('main'),web=new A2UIRenderer(host),native=new NativeSurfaceStore();
 const apply=value=>{web.apply(value);native.apply(value);};
 apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Text',text:{path:'/form/a~1b'}}]}));
 for(const value of ['Ada','Grace',42]){apply(message('updateDataModel',{surfaceId:'main',path:'/form/a~1b',value}));assert.equal(host.children[0].children[0].textContent,native.snapshot()[0].root.text);}
 apply(message('updateDataModel',{surfaceId:'main',path:'/form/a~1b'}));assert.equal(host.children[0].children[0].textContent,native.snapshot()[0].root.text);
});

test('web and native text fields update the same bound data',()=>{
 const host=doc.createElement('main'),web=new A2UIRenderer(host),native=new NativeSurfaceStore();
 const apply=value=>{web.apply(value);native.apply(value);};
 apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
 apply(message('updateDataModel',{surfaceId:'main',value:{form:{name:'Ada'}}}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Column',children:['field','display']},{id:'field',component:'TextField',label:'Name',value:{path:'/form/name'}},{id:'display',component:'Text',text:{path:'/form/name'}}]}));
 const input=host.children[0].children[0].children[0].children[1];input.value='Grace';input.listeners.input();
 const snapshot=native.snapshot()[0];native.writeField('main','field',snapshot.revision,'Grace');
 assert.equal(host.children[0].children[0].children[1].textContent,native.snapshot()[0].root.children[1].text);
 assert.equal(native.snapshot()[0].root.children[0].value,'Grace');
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'field',component:'TextField',label:'Name',value:{path:'/form/other'}}]}));
 assert.throws(()=>native.writeField('main','field',snapshot.revision,'stale'),/Stale/);
 assert.equal(native.snapshot()[0].root.children[1].text,'Grace');
});

test('web and native emit matching button action context',()=>{
 const host=doc.createElement('main'),events=[],web=new A2UIRenderer(host,undefined,event=>events.push(event)),native=new NativeSurfaceStore();
 const apply=value=>{web.apply(value);native.apply(value);};
 apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
 apply(message('updateDataModel',{surfaceId:'main',value:{form:{name:'Ada',secret:'private'}}}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/form/name'},source:'screen'}}}},{id:'label',component:'Text',text:'Save'}]}));
 host.children[0].children[0].listeners.click();const nativeAction=native.action('main','root',native.snapshot()[0].revision);
 assert.deepEqual({...events[0].action,timestamp:''},{...nativeAction.action,timestamp:''});
});

test('shared Flutter fixture matches web and native bindings',async()=>{
 const steps=JSON.parse(await readFile(new URL('../../../adapters/flutter/test/fixtures/bindings.json',import.meta.url),'utf8'));
 const host=doc.createElement('main'),web=new A2UIRenderer(host),native=new NativeSurfaceStore();
 for(const step of steps){web.apply(step.message);native.apply(step.message);assert.equal(native.snapshot()[0].root?.text??null,step.text);assert.equal(host.children[0].children[0]?.textContent??null,step.text);}
});

test('shared Flutter fixture matches web and native action context',async()=>{
 const fixture=JSON.parse(await readFile(new URL('../../../adapters/flutter/test/fixtures/actions.json',import.meta.url),'utf8'));
 const host=doc.createElement('main'),events=[],web=new A2UIRenderer(host,undefined,event=>events.push(event)),native=new NativeSurfaceStore();
 for(const step of fixture.messages){web.apply(step);native.apply(step);}
 host.children[0].children[0].listeners.click();
 const webAction={...events[0].action};delete webAction.timestamp;const nativeAction={...native.action('main','root',native.snapshot()[0].revision).action};delete nativeAction.timestamp;
 assert.deepEqual(webAction,fixture.action);assert.deepEqual(nativeAction,fixture.action);
});

test('shared Flutter fixture matches web and native layout trees',async()=>{
 const steps=JSON.parse(await readFile(new URL('../../../adapters/flutter/test/fixtures/layout.json',import.meta.url),'utf8'));
 const host=doc.createElement('main'),web=new A2UIRenderer(host),native=new NativeSurfaceStore();
 for(const step of steps){web.apply(step.message);native.apply(step.message);const webRoot=host.children[0].children[0];const nativeRoot=native.snapshot()[0].root;assert.deepEqual(webRoot?domTree(webRoot):null,step.tree);assert.deepEqual(nativeRoot?nativeTree(nativeRoot):null,step.tree);}
});

test('deleted array elements differ from null in action context on web and native',()=>{
 const host=doc.createElement('main'),events=[],web=new A2UIRenderer(host,undefined,event=>events.push(event)),native=new NativeSurfaceStore();
 const apply=value=>{web.apply(value);native.apply(value);};
 apply(message('createSurface',{surfaceId:'main',catalogId:APP_MIXER_CATALOG}));
 apply(message('updateDataModel',{surfaceId:'main',value:{items:[null,'gone']}}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save',context:{value:{path:'/items/0'}}}}},{id:'label',component:'Text',text:'Save'}]}));
 host.children[0].children[0].listeners.click();assert.equal(events[0].action.context.value,null);assert.equal(native.action('main','root',native.snapshot()[0].revision).action.context.value,null);
 apply(message('updateDataModel',{surfaceId:'main',path:'/items/1'}));
 apply(message('updateDataModel',{surfaceId:'main',path:'/other',value:'updated'}));
 apply(message('updateComponents',{surfaceId:'main',components:[{id:'root',component:'Button',child:'label',action:{event:{name:'save',context:{value:{path:'/items/1'}}}}}]}));
 assert.throws(()=>host.children[0].children[0].listeners.click(),/not found/);assert.throws(()=>native.action('main','root',native.snapshot()[0].revision),/not found/);
});
