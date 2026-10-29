import {invokeCapability} from './capabilities.mjs';

export function createStagedEditor({stageOperation,getOperation,submitOperation}) {
  const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(![stageOperation,getOperation,submitOperation].every(valid))throw Error('Invalid staged editor capabilities');
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid staged editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),payloadLabel=document.createElement('label'),payload=document.createElement('textarea'),stage=document.createElement('button'),idLabel=document.createElement('label'),id=document.createElement('input'),check=document.createElement('button'),submit=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Staged transaction';payloadLabel.textContent='Transaction data (JSON object)';payload.value='{}';payloadLabel.appendChild(payload);
    stage.type='button';stage.textContent='Stage';idLabel.textContent='Staged operation ID';idLabel.appendChild(id);check.type='button';check.textContent='Check status';submit.type='button';submit.textContent='Submit';submit.disabled=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Enter transaction data and stage it.';
    root.append(heading,payloadLabel,stage,idLabel,check,submit,status);
    let busy=false,loadedId='',loadedStatus='',requestKey='',requestBody='';
    const busyState=active=>{busy=active;payload.disabled=active;id.disabled=active;stage.disabled=active;check.disabled=active;submit.disabled=active||!loadedId||loadedStatus!=='staged';};
    id.addEventListener('input',()=>{loadedId='';loadedStatus='';submit.disabled=true;status.textContent='Check this operation before submitting.';});
    const accept=(result,expected)=>{
      if(!result||typeof result!=='object'||typeof result.id!=='string'||!result.id||result.id.length>256||!['staged','submitting','uncertain','succeeded'].includes(result.status)||(expected&&result.id!==expected))throw Error('Invalid staged operation response');
      id.value=result.id;loadedId=result.id;loadedStatus=result.status;status.textContent='Operation '+result.status+'.';
    };
    stage.addEventListener('click',async()=>{
      if(busy)return;let value;try{value=JSON.parse(payload.value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected an object');}catch{status.textContent='Enter a valid JSON object.';return;}
      const body=JSON.stringify(value);
      if(!requestKey||requestBody!==body){
        if(!document.defaultView?.crypto?.randomUUID){status.textContent='Secure request IDs are unavailable.';return;}
        requestKey=document.defaultView.crypto.randomUUID();requestBody=body;
      }
      busyState(true);loadedId='';loadedStatus='';
      try{accept(await invokeCapability(stageOperation,{payload:value,requestKey}));}
      catch(error){status.textContent=error.message||'Could not stage operation. Retry with the same data.';}
      finally{busyState(false);}
    });
    check.addEventListener('click',async()=>{
      const operationId=id.value.trim();if(busy||!operationId){status.textContent='Enter a staged operation ID.';return;}
      busyState(true);loadedId='';loadedStatus='';
      try{accept(await invokeCapability(getOperation,{id:operationId}),operationId);}
      catch(error){status.textContent=error.message||'Could not check operation.';}
      finally{busyState(false);}
    });
    submit.addEventListener('click',async()=>{
      if(busy||!loadedId||loadedStatus!=='staged'||id.value.trim()!==loadedId)return;
      const operationId=loadedId;busyState(true);loadedStatus='';
      try{await invokeCapability(submitOperation,{id:operationId});loadedStatus='succeeded';status.textContent='Operation succeeded.';}
      catch(error){loadedId='';status.textContent='Submission outcome may be uncertain. Check status before taking further action.';}
      finally{busyState(false);}
    });
    return root;
  };
  return {render,validate};
}
