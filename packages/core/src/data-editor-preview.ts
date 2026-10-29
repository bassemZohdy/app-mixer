/** Inert control-plane counterpart to the generated host-owned record editor. */
export const RECORD_EDITOR_PREVIEW = `

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

export function createRecordEditor({getOperation,putOperation,listOperation,fields}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation)||(listOperation!==undefined&&!validOperation(listOperation)))throw Error('Invalid record editor capabilities');
  const schema=normalizeFields(fields);
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid record editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),idLabel=document.createElement('label'),id=document.createElement('input'),valueLabel=document.createElement('label'),value=document.createElement('textarea'),load=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Record';idLabel.textContent='Record ID';valueLabel.textContent='Record data (JSON object)';
    id.disabled=true;value.disabled=true;idLabel.appendChild(id);valueLabel.appendChild(value);
    load.type='button';load.textContent='Load';load.disabled=true;save.type='button';save.textContent='Save';save.disabled=true;
    status.setAttribute('role','status');status.textContent='Preview only. Data operations are disabled.';
    root.append(heading);if(listOperation){const browse=document.createElement('button'),next=document.createElement('button');browse.type='button';browse.textContent='Browse records';browse.disabled=true;next.type='button';next.textContent='Next page';next.disabled=true;root.append(browse,next);}root.append(idLabel,load);if(schema)for(const field of schema){const item=fieldControl(document,field);item.control.disabled=true;root.appendChild(item.control.parentElement);}else root.appendChild(valueLabel);root.append(save,status);return root;
  };
  return {render,validate};
}
`;
