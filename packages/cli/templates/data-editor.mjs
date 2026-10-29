import {invokeCapability} from './capabilities.mjs';

// The host chooses the capabilities; application definitions only supply a label.
export function createRecordEditor({getOperation,putOperation}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation))throw Error('Invalid record editor capabilities');
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid record editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),idLabel=document.createElement('label'),id=document.createElement('input'),valueLabel=document.createElement('label'),value=document.createElement('textarea'),load=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Record';idLabel.textContent='Record ID';valueLabel.textContent='Record data (JSON object)';
    idLabel.appendChild(id);valueLabel.appendChild(value);load.type='button';load.textContent='Load';save.type='button';save.textContent='Save';save.disabled=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Enter a record ID and load it.';
    root.append(heading,idLabel,load,valueLabel,save,status);
    let revision=null,loadedId='',busy=false;
    const setBusy=active=>{busy=active;id.disabled=active;value.disabled=active;load.disabled=active;save.disabled=active||!loadedId;};
    id.addEventListener('input',()=>{loadedId='';save.disabled=true;status.textContent='Load this record before saving.';});
    load.addEventListener('click',async()=>{
      const recordId=id.value.trim();if(busy||!recordId){status.textContent='Enter a record ID.';return;}
      setBusy(true);loadedId='';
      try {
        const result=await invokeCapability(getOperation,{id:recordId});
        if(result!==null&&(!result||typeof result!=='object'||result.id!==recordId||!Number.isSafeInteger(result.revision)||result.revision<1||!result.value||typeof result.value!=='object'||Array.isArray(result.value)))throw Error('Invalid record response');
        revision=result===null?null:result.revision;value.value=JSON.stringify(result===null?{}:result.value,null,2);loadedId=recordId;
        status.textContent=result===null?'New record. Enter data and save.':'Record loaded.';
      } catch(error){status.textContent=error.message||'Could not load record.';}
      finally {setBusy(false);}
    });
    save.addEventListener('click',async()=>{
      if(busy||!loadedId||id.value.trim()!==loadedId)return;
      let parsed;try{parsed=JSON.parse(value.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Expected an object');}catch{status.textContent='Enter a valid JSON object.';return;}
      setBusy(true);
      try {
        const result=await invokeCapability(putOperation,{id:loadedId,expectedRevision:revision,value:parsed});
        if(!result||result.id!==loadedId||!Number.isSafeInteger(result.revision)||result.revision<1)throw Error('Invalid save response');
        revision=result.revision;status.textContent='Record saved.';
      } catch(error){
        if(error.status===409){loadedId='';status.textContent='Record changed elsewhere. Copy your edits, then load the latest version.';}
        else status.textContent=error.message||'Could not save record.';
      } finally {setBusy(false);}
    });
    return root;
  };
  return {render,validate};
}
