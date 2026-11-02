import React, {useCallback, useState} from 'react';
import {SafeAreaView, Text, TextInput, View, Pressable, Platform} from 'react-native';
import {APP_MIXER_CATALOG, createReactNativeA2UIComponent} from './app-mixer';

const Renderer = createReactNativeA2UIComponent(React, {View, Text, TextInput, Pressable, Platform});
let publish,expectingRejection=false;
const subscribe = receive => {
  publish=receive;
  receive({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'main',value:{profile:{name:'Ada'}}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[
    {id:'root',component:'Column',children:['title','card','field','mirror','echo','button']},
    {id:'title',component:'Text',text:'Device heading',variant:'h1'},
    {id:'card',component:'Card',child:'row'},
    {id:'row',component:'Row',children:['first','second'],justify:'spaceBetween'},
    {id:'first',component:'Text',text:'First item'},
    {id:'second',component:'Text',text:'Second item'},
    {id:'field',component:'TextField',label:'Name',value:{path:'/profile/name'}},
    {id:'mirror',component:'TextField',label:'Name copy',value:{path:'/profile/name'}},
    {id:'echo',component:'Text',text:{path:'/profile/name'}},
    {id:'button',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/profile/name'}}}}},
    {id:'label',component:'Text',text:'Save'}
  ]}});
  return ()=>{if(publish===receive)publish=undefined;};
};
export default function App(){
  const [result,setResult]=useState('Waiting');
  const [rejection,setRejection]=useState('');
  const [phase,setPhase]=useState(0);
  const onAction=useCallback(event=>{const name=event?.action?.context?.name;setResult(event?.action?.name==='save'&&name==='Grace'?'Saved Grace':'FAIL action');},[]);
  const onError=useCallback(()=>{if(expectingRejection)setRejection('Rejected safely');else setResult('FAIL renderer');},[]);
  const update=()=>publish?.({version:'v0.9.1',updateDataModel:{surfaceId:'main',path:'/profile/name',value:'Lin'}});
  const reject=()=>{expectingRejection=true;try{publish?.({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'title',component:'Text',text:'Wrong heading'},{id:'bad',component:'Text',text:42}]}});}finally{expectingRejection=false;}};
  const advance=()=>{
    if(!publish)return;
    if(phase===1){publish({version:'v0.9.1',deleteSurface:{surfaceId:'secondary'}});setPhase(2);return;}
    publish({version:'v0.9.1',createSurface:{surfaceId:'secondary',catalogId:APP_MIXER_CATALOG}});
    publish({version:'v0.9.1',updateDataModel:{surfaceId:'secondary',value:{profile:{name:phase===0?'Secondary Ada':'Secondary Grace'}}}});
    publish({version:'v0.9.1',updateComponents:{surfaceId:'secondary',components:[{id:'root',component:'Text',text:{path:'/profile/name'}}]}});
    setPhase(phase===0?1:3);
  };
  return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><View style={{flexDirection:'row',justifyContent:'space-between'}}><Pressable accessibilityRole="button" style={{padding:8}} onPress={update}><Text>Update data</Text></Pressable><Pressable accessibilityRole="button" style={{padding:8}} onPress={reject}><Text>Reject invalid</Text></Pressable></View><Renderer subscribe={subscribe} onError={onError} onAction={result==='Waiting'?onAction:undefined}/><Text>{rejection}</Text><Text>{result}</Text>{result==='Saved Grace'&&phase<3&&<Pressable accessibilityRole="button" style={{padding:8}} onPress={advance}><Text>Advance surface</Text></Pressable>}</SafeAreaView>;
}
