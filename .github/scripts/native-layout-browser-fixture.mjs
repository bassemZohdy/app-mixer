import React from 'react';
import {createRoot} from 'react-dom/client';
import {View, Text, TextInput, Pressable, Platform} from 'react-native-web';
import {createReactNativeA2UIComponent, APP_MIXER_CATALOG} from '../../packages/native/dist/index.js';
import {A2UIRenderer} from '../../packages/web/dist/index.js';

const Renderer=createReactNativeA2UIComponent(React,{View,Text,TextInput,Pressable,Platform});
const labels=['A long column label that needs to wrap','A long card label that needs to wrap','A long nested row label that needs to wrap'];
const subscribe=receive=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
    {id:'root',component:'Row',children:['column','card','row']},
    {id:'column',component:'Column',children:['one']}, {id:'one',component:'Text',text:labels[0]},
    {id:'card',component:'Card',child:'two'}, {id:'two',component:'Text',text:labels[1]},
    {id:'row',component:'Row',children:['three']}, {id:'three',component:'Text',text:labels[2]}
  ]}});
};
const report=(result,detail='')=>{if(document.body.dataset.result)return;document.body.dataset.result=result;document.body.dataset.error=detail;void fetch('/result',{method:'POST',headers:{'content-type':'text/plain'},body:result+':'+detail});};
const fail=error=>report('fail',String(error?.stack??error));
try {
  createRoot(document.getElementById('host')).render(React.createElement(Renderer,{subscribe,onError:fail}));
  const modes=['start','center','end','spaceBetween','spaceAround','spaceEvenly'],comparisons=[];
  for(const [index,mode] of modes.entries()){
    const components=[{id:'root',component:'Row',align:'start',justify:mode,children:['left','right']},{id:'left',component:'Text',text:`Left ${index}`},{id:'right',component:'Text',text:`Right ${index}`}];
    const messages=[{version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}},{version:'v0.9.1',updateComponents:{surfaceId:'main',components}}];
    const nativeHost=document.createElement('div'),webHost=document.createElement('div');nativeHost.style.width=webHost.style.width='240px';document.body.append(nativeHost,webHost);
    const nativeSubscribe=receive=>messages.forEach(receive);createRoot(nativeHost).render(React.createElement(Renderer,{subscribe:nativeSubscribe,onError:fail}));
    const web=new A2UIRenderer(webHost);messages.forEach(message=>web.apply(message));comparisons.push({mode,index,nativeHost,webHost});
  }
  const alignmentComparisons=[];
  for(const [index,align] of ['start','center','end','stretch'].entries()){
    const components=[{id:'root',component:'Row',align,children:['tall','short']},{id:'tall',component:'Text',variant:'h1',text:`Tall ${index}`},{id:'short',component:'Text',variant:'caption',text:`Short ${index}`}];
    const messages=[{version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}},{version:'v0.9.1',updateComponents:{surfaceId:'main',components}}];
    const nativeHost=document.createElement('div'),webHost=document.createElement('div');nativeHost.style.width=webHost.style.width='240px';document.body.append(nativeHost,webHost);
    const nativeSubscribe=receive=>messages.forEach(receive);createRoot(nativeHost).render(React.createElement(Renderer,{subscribe:nativeSubscribe,onError:fail}));
    const web=new A2UIRenderer(webHost);messages.forEach(message=>web.apply(message));for(const text of webHost.querySelectorAll('h1,small'))text.style.margin='0';alignmentComparisons.push({align,index,nativeHost,webHost});
  }
  const columnComparisons=[];
  for(const [index,align] of ['start','center','end','stretch'].entries()){
    const components=[{id:'root',component:'Column',align,children:['first','second']},{id:'first',component:'Text',text:`First ${index}`},{id:'second',component:'Text',text:`Second ${index}`}];
    const messages=[{version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}},{version:'v0.9.1',updateComponents:{surfaceId:'main',components}}];
    const nativeHost=document.createElement('div'),webHost=document.createElement('div');nativeHost.style.width=webHost.style.width='240px';document.body.append(nativeHost,webHost);
    const nativeSubscribe=receive=>messages.forEach(receive);createRoot(nativeHost).render(React.createElement(Renderer,{subscribe:nativeSubscribe,onError:fail}));
    const web=new A2UIRenderer(webHost);messages.forEach(message=>web.apply(message));columnComparisons.push({align,index,nativeHost,webHost});
  }
  const check=()=>{
    try {
      const host=document.getElementById('host'), bounds=host.getBoundingClientRect();
      const texts=labels.map(label=>[...host.querySelectorAll('*')].find(element=>element.childElementCount===0&&element.textContent===label));
      if(texts.some(text=>!text)){requestAnimationFrame(check);return;}
      for(const text of texts){
        const child=text.parentElement.getBoundingClientRect(), box=text.getBoundingClientRect();
        if(child.left<bounds.left-1||child.right>bounds.right+1||box.left<bounds.left-1||box.right>bounds.right+1||child.width<=0||box.height<30)throw Error(`Nested row child is not contained and wrapped: ${JSON.stringify({child:child.toJSON(),box:box.toJSON(),host:bounds.toJSON()})}`);
      }
      for(const {mode,index,nativeHost,webHost} of comparisons){
        for(const [name,host] of [['native',nativeHost],['web',webHost]]){
          const leaf=label=>[...host.querySelectorAll('*')].find(element=>element.childElementCount===0&&element.textContent===label),leftNode=leaf(`Left ${index}`),rightNode=leaf(`Right ${index}`);
          if(!leftNode||!rightNode){requestAnimationFrame(check);return;}
          const bounds=host.getBoundingClientRect(),left=leftNode.getBoundingClientRect(),right=rightNode.getBoundingClientRect(),remaining=bounds.width-left.width-right.width;
          const expectedLeft=mode==='center'?remaining/2:mode==='end'?remaining:mode==='spaceAround'?remaining/4:mode==='spaceEvenly'?remaining/3:0;
          const expectedGap=mode==='spaceBetween'?remaining:mode==='spaceAround'?remaining/2:mode==='spaceEvenly'?remaining/3:0;
          if(Math.abs(left.left-bounds.left-expectedLeft)>1||Math.abs(right.left-left.right-expectedGap)>1)throw Error(`${name} ${mode} row spacing mismatch`);
        }
      }
      for(const {align,index,nativeHost,webHost} of alignmentComparisons){
        for(const [name,host] of [['native',nativeHost],['web',webHost]]){
          const leaf=label=>[...host.querySelectorAll('*')].find(element=>element.childElementCount===0&&element.textContent===label),tall=leaf(`Tall ${index}`),short=leaf(`Short ${index}`);
          if(!tall||!short){requestAnimationFrame(check);return;}
          const row=tall.parentElement.getBoundingClientRect(),small=short.getBoundingClientRect(),free=row.height-small.height;
          const expected=align==='center'?free/2:align==='end'?free:0;
          if(Math.abs(small.top-row.top-expected)>1||(align==='stretch'&&Math.abs(small.height-row.height)>1))throw Error(`${name} ${align} row alignment mismatch`);
        }
      }
      for(const {align,index,nativeHost,webHost} of columnComparisons){
        for(const [name,host] of [['native',nativeHost],['web',webHost]]){
          const child=[...host.querySelectorAll('*')].find(element=>element.childElementCount===0&&element.textContent===`First ${index}`);
          if(!child){requestAnimationFrame(check);return;}
          const column=child.parentElement.getBoundingClientRect(),box=child.getBoundingClientRect(),free=column.width-box.width;
          const expected=align==='center'?free/2:align==='end'?free:0;
          if(Math.abs(column.width-240)>1||box.width<=0||Math.abs(box.left-column.left-expected)>1||(align==='stretch'&&Math.abs(box.width-column.width)>1))throw Error(`${name} ${align} column alignment mismatch`);
        }
      }
      report('pass');
    }catch(error){fail(error);}
  };
  requestAnimationFrame(check);
}catch(error){fail(error);}
