#!/usr/bin/env node
// Renderer benchmark: a 1,000-component surface (bound Text and TextField nodes) receiving data-only updates, the way
// every keystroke does. The same surface is measured with the incremental path and, by adding a custom component that
// forces a rebuild, with a full re-render per update. `node scripts/bench-renderer.mjs [updates=200]`.
import {JSDOM} from 'jsdom';
import {A2UIRenderer,APP_MIXER_CATALOG,basicRegistry} from '../packages/web/dist/index.js';

const updates=Number(process.argv[2]??200),dom=new JSDOM('<!doctype html><main id="host"></main>'),document=dom.window.document;
function messages(){
 const components=[{id:'root',component:'Column',children:[]}],texts=798,fields=199;
 for(let n=0;n<texts;n++){components.push({id:'t'+n,component:'Text',text:{path:'/t/'+n}});components[0].children.push('t'+n);}
 for(let n=0;n<fields;n++){components.push({id:'f'+n,component:'TextField',label:'Field '+n,value:{path:'/f/'+n}});components[0].children.push('f'+n);}
 const data={t:Object.fromEntries(Array.from({length:texts},(_,n)=>[n,'text '+n])),f:Object.fromEntries(Array.from({length:fields},(_,n)=>[n,'value '+n]))};
 return {components,data,total:components.length};
}
function measure(forceRebuild){
 const host=document.createElement('main'),registry=basicRegistry().register('Badge',(c,_child,_data,doc)=>doc.createElement('span')),renderer=new A2UIRenderer(host,registry);
 const {components,data,total}=messages();if(forceRebuild){components.push({id:'badge',component:'Badge'});components[0].children.push('badge');}
 renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:data}});renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components}});
 const started=performance.now();
 for(let n=0;n<updates;n++)renderer.apply({version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/f/'+(n%199),value:'typed '+n}});
 const ms=performance.now()-started;return {mode:forceRebuild?'rebuild':'incremental',components:total,updates,totalMs:Number(ms.toFixed(1)),perUpdateMs:Number((ms/updates).toFixed(2))};
}
for(const force of [false,true])console.log(JSON.stringify(measure(force)));
