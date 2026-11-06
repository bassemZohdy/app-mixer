import test from 'node:test';
import assert from 'node:assert/strict';
import {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry} from '../dist/index.js';

class Element {
  constructor(doc){this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.textContent='';this.listeners={};this.value='';}
  appendChild(child){this.children.push(child);return child;}
  replaceChildren(...children){this.children=children;}
  addEventListener(event,fn){this.listeners[event]=fn;}
  remove(){}
}
const snapshot=element=>JSON.stringify({text:element.textContent,value:element.value,style:element.style,dataset:element.dataset,children:element.children.map(child=>JSON.parse(snapshot(child)))});
const version='v0.9.1',surfaceId='main';
const base=[
 {version,createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}},
 {version,updateDataModel:{surfaceId,value:{form:{name:'Ada'}}}},
 {version,updateComponents:{surfaceId,components:[{id:'root',component:'Column',children:['title','field','go']},{id:'title',component:'Text',text:{path:'/form/name'}},{id:'field',component:'TextField',label:'Name',value:{path:'/form/name'}},{id:'go',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/form/name'}}}}},{id:'label',component:'Text',text:'Save'}]}}
];
const junk=['',' ','x',0,-1,1e308,true,false,null,[],{},{a:1},['root'],'__proto__','constructor','/__proto__/x','/a/b/c','root',{path:'/nope'},{path:1},[[]],'\u0000','a'.repeat(5000)];
function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
function mutate(value,random){
 const copy=structuredClone(value),paths=[];(function walk(node,path){if(node&&typeof node==='object')for(const key of Object.keys(node)){paths.push([...path,key]);walk(node[key],[...path,key]);}})(copy,[]);
 const count=1+Math.floor(random()*3);
 for(let i=0;i<count&&paths.length;i++){const path=paths[Math.floor(random()*paths.length)];let node=copy;for(const key of path.slice(0,-1)){if(node==null||typeof node!=='object')break;node=node[key];}
  if(node&&typeof node==='object'){const last=path.at(-1),roll=random();if(roll<0.15)delete node[last];else node[last]=structuredClone(junk[Math.floor(random()*junk.length)]);}}
 return copy;
}

test('fuzzed A2UI messages are either applied or rejected with an Error that leaves the rendered tree unchanged',()=>{
 const random=rng(20261101);let rejected=0,applied=0;
 for(let iteration=0;iteration<1500;iteration++){
  const doc={createElement:()=>new Element(doc)},host=doc.createElement(),renderer=new A2UIRenderer(host,basicRegistry(),()=>{});
  const index=Math.floor(random()*base.length);for(const message of base.slice(0,index))renderer.apply(structuredClone(message));
  const candidate=mutate(base[index],random),before=snapshot(host);
  try{renderer.apply(candidate);applied++;}
  catch(error){
   rejected++;assert.ok(error instanceof Error,`non-Error thrown for ${JSON.stringify(candidate)}`);
   assert.ok(!(error instanceof TypeError)&&!(error instanceof RangeError),`unguarded ${error.name}: ${error.message} for ${JSON.stringify(candidate).slice(0,300)}`);
   assert.equal(snapshot(host),before,`tree changed by rejected message ${JSON.stringify(candidate).slice(0,300)}`);
  }
 }
 assert.ok(rejected>100&&applied>100,`fuzz corpus too one-sided (applied ${applied}, rejected ${rejected})`);
});
