import React from 'react';
import {createRoot} from 'react-dom/client';
import {View, Text, TextInput, Pressable, Platform} from 'react-native-web';
import {createReactNativeA2UIComponent, APP_MIXER_CATALOG} from '../../packages/native/dist/index.js';

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
const fail=error=>{document.body.dataset.error=String(error?.stack??error);document.body.dataset.result='fail';};
try {
  createRoot(document.getElementById('host')).render(React.createElement(Renderer,{subscribe,onError:fail}));
  const check=()=>{
    try {
      const host=document.getElementById('host'), bounds=host.getBoundingClientRect();
      const texts=labels.map(label=>[...host.querySelectorAll('*')].find(element=>element.childElementCount===0&&element.textContent===label));
      if(texts.some(text=>!text)){requestAnimationFrame(check);return;}
      for(const text of texts){
        const child=text.parentElement.getBoundingClientRect(), box=text.getBoundingClientRect();
        if(child.left<bounds.left-1||child.right>bounds.right+1||box.left<bounds.left-1||box.right>bounds.right+1||child.width<=0||box.height<30)throw Error(`Nested row child is not contained and wrapped: ${JSON.stringify({child:child.toJSON(),box:box.toJSON(),host:bounds.toJSON()})}`);
      }
      document.body.dataset.result='pass';
    }catch(error){fail(error);}
  };
  requestAnimationFrame(check);
}catch(error){fail(error);}
