import React, {useCallback, useState} from 'react';
import {SafeAreaView, Text, TextInput, View, Pressable} from 'react-native';
import {APP_MIXER_CATALOG, createReactNativeA2UIComponent} from './app-mixer';

const Renderer = createReactNativeA2UIComponent(React, {View, Text, TextInput, Pressable});
const subscribe = receive => {
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{name:'Ada'}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
    {id:'root',component:'Column',children:['title','field','button']},
    {id:'title',component:'Text',text:'Device heading',variant:'h1'},
    {id:'field',component:'TextField',label:'Name',value:{path:'/name'}},
    {id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/name'}}}}},
    {id:'label',component:'Text',text:'Save'}
  ]}});
};
export default function App(){
  const [result,setResult]=useState('Waiting');
  const onAction=useCallback(event=>{const name=event?.action?.context?.name;setResult(event?.action?.name==='save'&&name==='Grace'?'Saved Grace':'FAIL action');},[]);
  const onError=useCallback(()=>setResult('FAIL renderer'),[]);
  return <SafeAreaView><Renderer subscribe={subscribe} onError={onError} onAction={result==='Waiting'?onAction:undefined}/><Text>{result}</Text></SafeAreaView>;
}
