import {invokeCapability} from './capabilities.mjs';

function normalizeFields(fields) {
  if(fields===undefined)return undefined;
  if(!Array.isArray(fields)||fields.length<1||fields.length>40)throw Error('Invalid record fields');
  const seen=new Set();return fields.map(field=>{
    if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(key=>!['key','label','type','required','min','max','maxLength','options'].includes(key))||typeof field.key!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key)||['constructor','prototype','__proto__'].includes(field.key)||seen.has(field.key)||typeof field.label!=='string'||!field.label.trim()||field.label.length>120||!['string','number','integer','boolean'].includes(field.type)||(field.required!==undefined&&typeof field.required!=='boolean'))throw Error('Invalid record fields');
    seen.add(field.key);const numeric=field.type==='number'||field.type==='integer';
    if((field.min!==undefined&&(!numeric||!Number.isFinite(field.min)))||(field.max!==undefined&&(!numeric||!Number.isFinite(field.max)))||(field.min!==undefined&&field.max!==undefined&&field.min>field.max)||(field.maxLength!==undefined&&(field.type!=='string'||!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>4096))||(field.options!==undefined&&(field.type!=='string'||!Array.isArray(field.options)||field.options.length<1||field.options.length>100||field.options.some(value=>typeof value!=='string'||!value||value.length>120)||new Set(field.options).size!==field.options.length)))throw Error('Invalid record fields');
    return {key:field.key,label:field.label,type:field.type,required:field.required===true,...(field.min===undefined?{}:{min:field.min}),...(field.max===undefined?{}:{max:field.max}),...(field.maxLength===undefined?{}:{maxLength:field.maxLength}),...(field.options===undefined?{}:{options:[...field.options]})};
  });
}
function fieldControl(document,field) {
  const label=document.createElement('label'),title=document.createElement('span'),error=document.createElement('small'),control=field.type==='boolean'||field.options?document.createElement('select'):document.createElement('input');
  label.style.display='block';label.style.margin='0.75rem 0';title.style.display='block';control.style.display='block';control.style.width='100%';control.style.maxWidth='28rem';control.style.boxSizing='border-box';error.style.display='block';
  title.textContent=field.label+(field.required?' (required)':' (optional)');label.appendChild(title);
  if(control.tagName==='SELECT'){const choices=field.type==='boolean'?['true','false']:field.options;const blank=document.createElement('option');blank.value='';blank.textContent='Select an option';control.appendChild(blank);for(const choice of choices){const option=document.createElement('option');option.value=choice;option.textContent=field.type==='boolean'?(choice==='true'?'Yes':'No'):choice;control.appendChild(option);}}
  else {control.type=field.type==='string'?'text':'number';if(field.type==='number')control.step='any';if(field.type==='integer')control.step='1';if(field.maxLength!==undefined)control.maxLength=field.maxLength;}
  control.required=field.required;error.setAttribute('role','alert');label.append(control,error);return {field,control,error,dirty:false};
}


// The host chooses the capabilities; application definitions only supply a label.
export function createRecordEditor({getOperation,putOperation,fields}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation))throw Error('Invalid record editor capabilities');
  const schema=normalizeFields(fields);
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid record editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),idLabel=document.createElement('label'),id=document.createElement('input'),valueLabel=document.createElement('label'),value=document.createElement('textarea'),load=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Record';idLabel.textContent='Record ID';valueLabel.textContent='Record data (JSON object)';
    idLabel.appendChild(id);valueLabel.appendChild(value);load.type='button';load.textContent='Load';save.type='button';save.textContent='Save';save.disabled=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Enter a record ID and load it.';
    const controls=schema?.map(field=>fieldControl(document,field))??[];root.append(heading,idLabel,load);if(schema)for(const item of controls)root.appendChild(item.control.parentElement);else root.appendChild(valueLabel);root.append(save,status);
    let revision=null,loadedId='',busy=false,preserveEdits=false,original={};
    const setBusy=active=>{busy=active;id.disabled=active;value.disabled=active;load.disabled=active;save.disabled=active||!loadedId;for(const item of controls)item.control.disabled=active||(!loadedId&&!preserveEdits);};
    const readField=item=>{const {field,control}=item,raw=control.value;if(control.validity.badInput)throw Error('Enter a valid number.');if(raw===''){if(field.required)throw Error('This field is required.');return undefined;}if(field.type==='boolean')return raw==='true';if(field.type==='string'){if(field.maxLength!==undefined&&raw.length>field.maxLength)throw Error('Enter no more than '+field.maxLength+' characters.');if(field.options&&!field.options.includes(raw))throw Error('Choose a valid option.');return raw;}const parsed=Number(raw);if(!Number.isFinite(parsed)||(field.type==='integer'&&!Number.isSafeInteger(parsed)))throw Error(field.type==='integer'?'Enter a whole number.':'Enter a valid number.');if(field.min!==undefined&&parsed<field.min)throw Error('Enter a value of at least '+field.min+'.');if(field.max!==undefined&&parsed>field.max)throw Error('Enter a value of at most '+field.max+'.');return parsed;};
    const checkField=item=>{try{readField(item);item.error.textContent='';item.control.removeAttribute('aria-invalid');return true}catch(error){item.error.textContent=error.message;item.control.setAttribute('aria-invalid','true');return false;}};
    for(const item of controls){item.control.disabled=true;item.control.addEventListener('input',()=>{item.dirty=true});item.control.addEventListener('change',()=>{item.dirty=true});item.control.addEventListener('blur',()=>checkField(item));}

    id.addEventListener('input',()=>{loadedId='';preserveEdits=false;save.disabled=true;for(const item of controls)item.control.disabled=true;status.textContent='Load this record before saving.';});
    load.addEventListener('click',async()=>{
      const recordId=id.value.trim();if(busy||!recordId){status.textContent='Enter a record ID.';return;}
      preserveEdits=false;setBusy(true);loadedId='';
      try {
        const result=await invokeCapability(getOperation,{id:recordId});
        if(result!==null&&(!result||typeof result!=='object'||result.id!==recordId||!Number.isSafeInteger(result.revision)||result.revision<1||!result.value||typeof result.value!=='object'||Array.isArray(result.value)))throw Error('Invalid record response');
        const data=result===null?{}:result.value;
        if(schema)for(const item of controls){const field=item.field;if(!Object.hasOwn(data,field.key))continue;const current=data[field.key];if((field.type==='string'&&(typeof current!=='string'||(field.options&&!field.options.includes(current))))||(field.type==='boolean'&&typeof current!=='boolean')||((field.type==='number'||field.type==='integer')&&(typeof current!=='number'||!Number.isFinite(current)||(field.type==='integer'&&!Number.isSafeInteger(current)))))throw Error('Record contains values this form cannot edit.');}
        revision=result===null?null:result.revision;original=JSON.parse(JSON.stringify(data));value.value=JSON.stringify(data,null,2);for(const item of controls){item.control.value=Object.hasOwn(data,item.field.key)?String(data[item.field.key]):'';item.dirty=false;item.error.textContent='';item.control.removeAttribute('aria-invalid');}loadedId=recordId;
        status.textContent=result===null?'New record. Enter data and save.':'Record loaded.';
      } catch(error){status.textContent=error.message||'Could not load record.';}
      finally {setBusy(false);}
    });
    save.addEventListener('click',async()=>{
      if(busy||!loadedId||id.value.trim()!==loadedId)return;
      let parsed;if(schema){let valid=true;for(const item of controls)if(!checkField(item))valid=false;if(!valid){status.textContent='Check the fields marked above.';return;}parsed=JSON.parse(JSON.stringify(original));for(const item of controls){const next=readField(item);if(next===undefined){if(item.dirty||!Object.hasOwn(original,item.field.key))delete parsed[item.field.key];}else parsed[item.field.key]=next;}}else try{parsed=JSON.parse(value.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Expected an object');}catch{status.textContent='Enter a valid JSON object.';return;}
      setBusy(true);
      try {
        const result=await invokeCapability(putOperation,{id:loadedId,expectedRevision:revision,value:parsed});
        if(!result||result.id!==loadedId||!Number.isSafeInteger(result.revision)||result.revision<1)throw Error('Invalid save response');
        revision=result.revision;if(schema){original=JSON.parse(JSON.stringify(parsed));for(const item of controls)item.dirty=false;}status.textContent='Record saved.';
      } catch(error){
        if(error.status===409){loadedId='';preserveEdits=true;status.textContent='Record changed elsewhere. Copy your edits, then load the latest version.';}
        else status.textContent=error.message||'Could not save record.';
      } finally {setBusy(false);}
    });
    return root;
  };
  return {render,validate};
}
