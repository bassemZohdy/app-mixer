import React, {useCallback, useState} from 'react';
import {SafeAreaView, Text, TextInput, View, Pressable, Platform} from 'react-native';
import {APP_MIXER_CATALOG, createReactNativeA2UIComponent, NativeComponentRegistry} from './app-mixer';

let mountCount=0;
function IdentityProbe(){const [instance]=useState(()=>++mountCount);return <Text>{`Mount ${instance}`}</Text>;}
const extensions=new NativeComponentRegistry();extensions.register('identity-probe',IdentityProbe,component=>Object.keys(component).every(key=>['id','component'].includes(key)));
const Renderer = createReactNativeA2UIComponent(React, {View, Text, TextInput, Pressable, Platform},extensions);
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
const layoutLabels=['A long nested column label needs to wrap','A long nested card label needs to wrap','A long nested row label needs to wrap'];
const subscribeLayout=receive=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'layout',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'layout',components:[
    {id:'root',component:'Row',children:['column','card','row']},
    {id:'column',component:'Column',children:['one']},{id:'one',component:'Text',text:layoutLabels[0]},
    {id:'card',component:'Card',child:'two'},{id:'two',component:'Text',text:layoutLabels[1]},
    {id:'row',component:'Row',children:['three']},{id:'three',component:'Text',text:layoutLabels[2]}
  ]}});
};
let identityReceive;
const createIdentity=receive=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'identity',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'identity',components:[{id:'root',component:'identity-probe'}]}});
};
const subscribeIdentity=receive=>{identityReceive=receive;createIdentity(receive);return ()=>{if(identityReceive===receive)identityReceive=undefined;};};
const subscribeMultiline=receive=>{
  receive({version:'v0.9.1',createSurface:{surfaceId:'multiline',catalogId:APP_MIXER_CATALOG}});
  receive({version:'v0.9.1',updateDataModel:{surfaceId:'multiline',value:{note:''}}});
  receive({version:'v0.9.1',updateComponents:{surfaceId:'multiline',components:[
    {id:'root',component:'Column',children:['field','button']},
    {id:'field',component:'TextField',label:'Notes',variant:'longText',value:{path:'/note'}},
    {id:'button',component:'Button',child:'label',action:{event:{name:'submit-note',context:{note:{path:'/note'}}}}},
    {id:'label',component:'Text',text:'Save note'}
  ]}});
};
export default function App(){
  const [result,setResult]=useState('Waiting');
  const [rejection,setRejection]=useState('');
  const [phase,setPhase]=useState(0);
  const [layout,setLayout]=useState(false);
  const [identity,setIdentity]=useState(false);
  const [multiline,setMultiline]=useState(false);
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
  if(multiline)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Renderer subscribe={subscribeMultiline} onError={onError} onAction={event=>setResult(event?.action?.name==='submit-note'&&event.action.context.note==='First\nSecond'?'Saved multiline note':'FAIL multiline action')}/><Text>{result}</Text></SafeAreaView>;
  if(identity)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Renderer subscribe={subscribeIdentity} onError={onError}/><Pressable accessibilityRole="button" onPress={()=>{if(identityReceive){identityReceive({version:'v0.9.1',deleteSurface:{surfaceId:'identity'}});createIdentity(identityReceive);}}}><Text>Replace test surface</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>setMultiline(true)}><Text>Check multiline input</Text></Pressable><Text>{result}</Text></SafeAreaView>;
  if(layout)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><View style={{width:240}}><Renderer subscribe={subscribeLayout} onError={onError}/></View><Pressable accessibilityRole="button" onPress={()=>setIdentity(true)}><Text>Check surface identity</Text></Pressable><Text>{result}</Text></SafeAreaView>;
  return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><View style={{flexDirection:'row',justifyContent:'space-between'}}><Pressable accessibilityRole="button" style={{padding:8}} onPress={update}><Text>Update data</Text></Pressable><Pressable accessibilityRole="button" style={{padding:8}} onPress={reject}><Text>Reject invalid</Text></Pressable></View><Renderer subscribe={subscribe} onError={onError} onAction={result==='Waiting'?onAction:undefined}/><Text>{rejection}</Text><Text>{result}</Text>{result==='Saved Grace'&&phase<3&&<Pressable accessibilityRole="button" style={{padding:8}} onPress={advance}><Text>Advance surface</Text></Pressable>}{phase===3&&<Pressable accessibilityRole="button" style={{padding:8}} onPress={()=>setLayout(true)}><Text>Check narrow layout</Text></Pressable>}</SafeAreaView>;
}
