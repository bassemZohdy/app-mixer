import React, {useCallback, useState} from 'react';
import nacl from 'tweetnacl';
import signedFixture from './signed-plan.json';
import {SafeAreaView, Text, TextInput, View, Pressable, Platform} from 'react-native';
import {APP_MIXER_CATALOG, createReactNativeA2UIComponent, NativeComponentRegistry} from './app-mixer';


// Test-only verifier and fixture; production hosts need independent key management and verification policy.
const decode64=value=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let bits=0,buffer=0;const bytes=[];for(const char of value){const index=chars.indexOf(char);if(index<0)throw Error('Invalid signature');buffer=(buffer<<6)|index;bits+=6;if(bits>=8){bits-=8;bytes.push((buffer>>>bits)&255);}}return Uint8Array.from(bytes);};
const utf8=value=>Uint8Array.from(encodeURIComponent(value).match(/%[0-9A-F]{2}|./g)??[],part=>part[0]==='%'?parseInt(part.slice(1),16):part.charCodeAt(0));
const verifyDevicePlan=({keyId,signingInput,signature})=>keyId==='device-test-key'&&nacl.sign.detached.verify(utf8(signingInput),decode64(signature),Uint8Array.from(signedFixture.publicKey));
const signedInstalled=[{id:'device-extension',version:'1.0.0',scope:'application',components:{'signed-probe':{render:()=> <Text>Verified signed extension</Text>,validate:component=>Object.keys(component).every(key=>['id','component'].includes(key))}}}];
const signedTarget={tenantId:'test-tenant',environment:'test',applicationId:'device-\u0627\u062e\u062a\u0628\u0627\u0631-\ud83d\ude00',revision:1,clock:()=>150};
const subscribeSigned=receive=>{receive({version:'v0.9.1',createSurface:{surfaceId:'signed',catalogId:APP_MIXER_CATALOG}});receive({version:'v0.9.1',updateComponents:{surfaceId:'signed',components:[{id:'root',component:'signed-probe'}]}});};

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
let repeatReceive;
const subscribeRepeated=receive=>{repeatReceive=receive;receive({version:'v0.9.1',createSurface:{surfaceId:'repeated',catalogId:APP_MIXER_CATALOG}});receive({version:'v0.9.1',updateDataModel:{surfaceId:'repeated',value:{value:'Ada'}}});receive({version:'v0.9.1',updateComponents:{surfaceId:'repeated',components:[{id:'root',component:'Column',children:['field','marker','field']},{id:'field',component:'TextField',label:'Repeated',value:{path:'/value'}},{id:'marker',component:'Text',text:'Reorder marker'}]}});return ()=>{if(repeatReceive===receive)repeatReceive=undefined;};};
export default function App(){
  const [result,setResult]=useState('Waiting');
  const [rejection,setRejection]=useState('');
  const [phase,setPhase]=useState(0);
  const [layout,setLayout]=useState(false);
  const [identity,setIdentity]=useState(false);
  const [multiline,setMultiline]=useState(false);
  const [repeated,setRepeated]=useState(false);
  const [signedRenderer,setSignedRenderer]=useState(null);
  const [signedStatus,setSignedStatus]=useState('');
  const checkSigned=async()=>{try{const registry=await NativeComponentRegistry.fromSignedPlan(signedFixture.envelope,signedInstalled,signedTarget,verifyDevicePlan);const rejected=async(envelope,target)=>{try{await NativeComponentRegistry.fromSignedPlan(envelope,signedInstalled,target,verifyDevicePlan);return false;}catch{return true;}};const changedSignature=(signedFixture.envelope.signature[0]==='A'?'B':'A')+signedFixture.envelope.signature.slice(1);if(!await rejected({...signedFixture.envelope,payload:signedFixture.envelope.payload+' '},signedTarget)||!await rejected({...signedFixture.envelope,signature:changedSignature},signedTarget)||!await rejected(signedFixture.envelope,{...signedTarget,tenantId:'other'})||!await rejected(signedFixture.envelope,{...signedTarget,clock:()=>200}))throw Error('Invalid plan accepted');const Signed=createReactNativeA2UIComponent(React,{View,Text,TextInput,Pressable,Platform},registry);setSignedRenderer(()=>Signed);setSignedStatus('Tampered plan rejected');}catch{setSignedStatus('FAIL signed plan');}};
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
  if(signedRenderer){const Signed=signedRenderer;return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Signed subscribe={subscribeSigned} onError={onError}/><Text>{signedStatus}</Text></SafeAreaView>;}
  if(repeated)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Renderer subscribe={subscribeRepeated} onError={onError}/><Pressable accessibilityRole="button" onPress={()=>repeatReceive?.({version:'v0.9.1',updateComponents:{surfaceId:'repeated',components:[{id:'root',component:'Column',children:['marker','field','field']}]}})}><Text>Reorder fields</Text></Pressable><Pressable accessibilityRole="button" onPress={checkSigned}><Text>Check signed extension</Text></Pressable><Text>{result}</Text></SafeAreaView>;
  if(multiline)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Renderer subscribe={subscribeMultiline} onError={onError} onAction={event=>setResult(event?.action?.name==='submit-note'&&event.action.context.note==='First\nSecond'?'Saved multiline note':'FAIL multiline action')}/><Text>{result}</Text><Pressable accessibilityRole="button" onPress={()=>setRepeated(true)}><Text>Check repeated fields</Text></Pressable><Text>{signedStatus}</Text></SafeAreaView>;
  if(identity)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><Renderer subscribe={subscribeIdentity} onError={onError}/><Pressable accessibilityRole="button" onPress={()=>{if(identityReceive){identityReceive({version:'v0.9.1',deleteSurface:{surfaceId:'identity'}});createIdentity(identityReceive);}}}><Text>Replace test surface</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>setMultiline(true)}><Text>Check multiline input</Text></Pressable><Text>{result}</Text></SafeAreaView>;
  if(layout)return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><View style={{width:240}}><Renderer subscribe={subscribeLayout} onError={onError}/></View><Pressable accessibilityRole="button" onPress={()=>setIdentity(true)}><Text>Check surface identity</Text></Pressable><Text>{result}</Text></SafeAreaView>;
  return <SafeAreaView style={{paddingTop:Platform.OS==='android'?32:0}}><View style={{flexDirection:'row',justifyContent:'space-between'}}><Pressable accessibilityRole="button" style={{padding:8}} onPress={update}><Text>Update data</Text></Pressable><Pressable accessibilityRole="button" style={{padding:8}} onPress={reject}><Text>Reject invalid</Text></Pressable></View><Renderer subscribe={subscribe} onError={onError} onAction={result==='Waiting'?onAction:undefined}/><Text>{rejection}</Text><Text>{result}</Text>{result==='Saved Grace'&&phase<3&&<Pressable accessibilityRole="button" style={{padding:8}} onPress={advance}><Text>Advance surface</Text></Pressable>}{phase===3&&<Pressable accessibilityRole="button" style={{padding:8}} onPress={()=>setLayout(true)}><Text>Check narrow layout</Text></Pressable>}</SafeAreaView>;
}
