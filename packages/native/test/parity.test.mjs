import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSurfaceStore,APP_MIXER_CATALOG} from '../dist/index.js';
import {A2UIRenderer} from '../../web/dist/index.js';

class Element {
 constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.parent=null;}
 appendChild(child){child.parent=this;this.children.push(child);return child;}
 replaceChildren(...children){this.children=[];for(const child of children)this.appendChild(child);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
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
