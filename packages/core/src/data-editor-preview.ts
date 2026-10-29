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
function fieldsFromJsonSchema(jsonSchema) {
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value), keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
  const fields=[],groups=[];
  function visit(node,path,labels,needed,depth){
    if(depth>5||!object(node)||!keys(node,depth===0?['$schema','type','properties','required','additionalProperties']:['type','title','properties','required','additionalProperties'])||node.type!=='object'||!object(node.properties)||(node.title!==undefined&&(typeof node.title!=='string'||!node.title.trim()||node.title.length>120))||(node.additionalProperties!==undefined&&typeof node.additionalProperties!=='boolean')||(depth===0&&node.$schema!==undefined&&node.$schema!=='https://json-schema.org/draft/2020-12/schema'))throw Error('Unsupported record JSON Schema form');
    const required=node.required===undefined?[]:node.required;if(!Array.isArray(required)||required.some(key=>typeof key!=='string'||!Object.hasOwn(node.properties,key))||new Set(required).size!==required.length)throw Error('Unsupported record JSON Schema form');
    if(depth){groups.push({path, label:labels.join(' / '), required:needed});if(groups.length>40)throw Error('Unsupported record JSON Schema form');}
    for(const [key,property] of Object.entries(node.properties)){
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||['constructor','prototype','__proto__'].includes(key)||!object(property))throw Error('Unsupported record JSON Schema form');
      const next=[...path,key],name=property.title??key,requiredField=required.includes(key);
      if(property.type==='object'){visit(property,next,[...labels,name],requiredField,depth+1);continue;}
      if(property.type==='array'){
        if(object(property.items)&&property.items.type==='object'){
          const spec=property.items,minItems=property.minItems===undefined?0:property.minItems,maxItems=property.maxItems===undefined?50:property.maxItems;
          if(!keys(property,['type','title','items','minItems','maxItems'])||!keys(spec,['type','title','properties','required','additionalProperties'])||!object(spec.properties)||Object.values(spec.properties).some(child=>!object(child)||!['string','number','integer','boolean'].includes(child.type))||!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120))||(spec.title!==undefined&&(typeof spec.title!=='string'||!spec.title.trim()||spec.title.length>120)))throw Error('Unsupported record JSON Schema form');
          const {title:unused,...itemSchema}=spec,itemFields=fieldsFromJsonSchema(itemSchema),label=[...labels,name].join(' / ');if(label.length>120)throw Error('Unsupported record JSON Schema form');fields.push({key,label,type:'objectArray',path:next,required:requiredField,itemFields,minItems,maxItems});if(fields.length>40)throw Error('Unsupported record JSON Schema form');continue;
        }
        if(!keys(property,['type','title','items','minItems','maxItems'])||!object(property.items)||!keys(property.items,['type','enum','minimum','maximum','minLength','maxLength'])||!['string','number','integer','boolean'].includes(property.items.type)||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120)))throw Error('Unsupported record JSON Schema form');
        const spec=property.items,numeric=spec.type==='number'||spec.type==='integer',minItems=property.minItems===undefined?0:property.minItems,maxItems=property.maxItems===undefined?50:property.maxItems;
        if(!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||(spec.enum!==undefined&&spec.type!=='string')||((spec.minimum!==undefined||spec.maximum!==undefined)&&!numeric)||(spec.minLength!==undefined&&(spec.type!=='string'||!Number.isSafeInteger(spec.minLength)||spec.minLength<0||spec.minLength>1048576))||(spec.maxLength!==undefined&&(spec.type!=='string'||!Number.isSafeInteger(spec.maxLength)||spec.maxLength<0||spec.maxLength>1048576))||(spec.minLength!==undefined&&spec.maxLength!==undefined&&spec.minLength>spec.maxLength))throw Error('Unsupported record JSON Schema form');
        let item;try{item=normalizeFields([{key,label:'Item',type:spec.type,required:true,...(spec.enum===undefined?{}:{options:spec.enum}),...(spec.minimum===undefined?{}:{min:spec.minimum}),...(spec.maximum===undefined?{}:{max:spec.maximum})}])[0];}catch{throw Error('Unsupported record JSON Schema form');}
        if(spec.type==='string')item={...item,jsonString:true,...(spec.minLength===undefined?{}:{jsonMinLength:spec.minLength}),...(spec.maxLength===undefined?{}:{jsonMaxLength:spec.maxLength})};
        const label=[...labels,name].join(' / ');if(label.length>120)throw Error('Unsupported record JSON Schema form');fields.push({key,label,type:'array',path:next,required:requiredField,item,minItems,maxItems});if(fields.length>40)throw Error('Unsupported record JSON Schema form');continue;
      }
      if(!keys(property,['type','title','enum','minimum','maximum','minLength','maxLength'])||!['string','number','integer','boolean'].includes(property.type)||(property.title!==undefined&&typeof property.title!=='string'))throw Error('Unsupported record JSON Schema form');
      const numeric=property.type==='number'||property.type==='integer';if((property.enum!==undefined&&property.type!=='string')||((property.minimum!==undefined||property.maximum!==undefined)&&!numeric)||(property.minLength!==undefined&&(property.type!=='string'||!Number.isSafeInteger(property.minLength)||property.minLength<0||property.minLength>1048576))||(property.maxLength!==undefined&&(property.type!=='string'||!Number.isSafeInteger(property.maxLength)||property.maxLength<0||property.maxLength>1048576))||(property.minLength!==undefined&&property.maxLength!==undefined&&property.minLength>property.maxLength))throw Error('Unsupported record JSON Schema form');
      const field={key,label:[...labels,name].join(' / '),type:property.type,required:requiredField,...(property.enum===undefined?{}:{options:property.enum}),...(property.minimum===undefined?{}:{min:property.minimum}),...(property.maximum===undefined?{}:{max:property.maximum})};
      try{fields.push({...normalizeFields([field])[0],path:next,...(property.type==='string'?{jsonString:true,...(property.minLength===undefined?{}:{jsonMinLength:property.minLength}),...(property.maxLength===undefined?{}:{jsonMaxLength:property.maxLength})}:{})});}catch{throw Error('Unsupported record JSON Schema form');}
      if(fields.length>40)throw Error('Unsupported record JSON Schema form');
    }
  }
  visit(jsonSchema,[],[],true,0);if(!fields.length)throw Error('Unsupported record JSON Schema form');fields.groups=groups;return fields;
}

function fieldControl(document,field) {
  if(field.type==='array'||field.type==='objectArray'){
    const wrapper=document.createElement('div'),control=document.createElement('fieldset'),title=document.createElement('legend'),error=document.createElement('small'),list=document.createElement('div'),add=document.createElement('button');
    title.textContent=field.label+(field.required?' (required)':' (optional)');control.appendChild(title);let include;
    if(!field.required){const label=document.createElement('label');include=document.createElement('input');include.type='checkbox';label.append(include,document.createTextNode(' Include '+field.label));control.appendChild(label);}
    add.type='button';add.textContent='Add '+field.label+' item';error.setAttribute('role','alert');control.append(list,add,error);wrapper.appendChild(control);const rows=[];
    const refresh=()=>{for(let i=0;i<rows.length;i++){if(rows[i].item)rows[i].item.control.parentElement.firstChild.textContent=field.label+' item '+(i+1)+' (required)';else rows[i].legend.textContent=field.label+' item '+(i+1);}add.disabled=control.disabled||(!field.required&&!include.checked)||rows.length>=field.maxItems;for(const row of rows){for(const item of row.items??[row.item]){item.control.disabled=control.disabled||(!field.required&&!include.checked);item.setDisabled?.(item.control.disabled);}row.remove.disabled=control.disabled||(!field.required&&!include.checked);}};
    const append=value=>{const remove=document.createElement('button'),row=document.createElement('div');remove.type='button';remove.textContent='Remove '+field.label+' item';let entry;
      if(field.type==='objectArray'){const box=document.createElement('fieldset'),legend=document.createElement('legend'),original=value===undefined?{}:JSON.parse(JSON.stringify(value)),items=field.itemFields.map(child=>{const item=fieldControl(document,child),initial=original[child.key];if(item.setValue)item.setValue(initial);else item.control.value=initial===undefined?'':String(initial);item.control.addEventListener('input',()=>{item.dirty=true});item.control.addEventListener('change',()=>{item.dirty=true});return item;});box.appendChild(legend);for(const item of items)box.appendChild(item.wrapper??item.control.parentElement);row.append(box,remove);entry={items,legend,original,remove,row};}
      else {const item=fieldControl(document,field.item);if(item.setValue)item.setValue(value);else if(value!==undefined)item.control.value=String(value);row.append(item.wrapper??item.control.parentElement,remove);entry={item,remove,row};}
      list.appendChild(row);rows.push(entry);remove.addEventListener('click',()=>{rows.splice(rows.indexOf(entry),1);row.remove();refresh();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});refresh();};
    add.addEventListener('click',()=>{append(undefined);control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});if(include)include.addEventListener('change',refresh);
    return {field,control,error,dirty:false,rows,include,refresh,setValue(value){list.replaceChildren();rows.length=0;if(include)include.checked=value!==undefined;if(value!==undefined)for(const item of value)append(item);refresh();}};
  }
  const label=document.createElement('label'),title=document.createElement('span'),error=document.createElement('small'),control=field.type==='boolean'||field.options?document.createElement('select'):document.createElement('input');
  label.style.display='block';label.style.margin='0.75rem 0';title.style.display='block';control.style.display='block';control.style.width='100%';control.style.maxWidth='28rem';control.style.boxSizing='border-box';error.style.display='block';
  title.textContent=field.label+(field.required?' (required)':' (optional)');label.appendChild(title);
  if(control.tagName==='SELECT'){const choices=field.type==='boolean'?['true','false']:field.options;const blank=document.createElement('option');blank.value='';blank.textContent='Select an option';control.appendChild(blank);for(const choice of choices){const option=document.createElement('option');option.value=choice;option.textContent=field.type==='boolean'?(choice==='true'?'Yes':'No'):choice;control.appendChild(option);}}
  else {control.type=field.type==='string'?'text':'number';if(field.type==='number')control.step='any';if(field.type==='integer')control.step='1';if(field.maxLength!==undefined)control.maxLength=field.maxLength;}
  control.required=field.required;error.setAttribute('role','alert');label.append(control,error);
  if(field.jsonString){let include,wrapper;if(!field.required){wrapper=document.createElement('div');const includeLabel=document.createElement('label');include=document.createElement('input');include.type='checkbox';includeLabel.append(include,document.createTextNode(' Include '+field.label));wrapper.append(includeLabel,label);include.addEventListener('change',()=>{control.disabled=!include.checked;control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});}return {field,control,error,dirty:false,include,wrapper,setDisabled(disabled){if(include)include.disabled=disabled;control.disabled=disabled||(include&&!include.checked);},setValue(value){if(include)include.checked=value!==undefined;control.value=value===undefined?'':value;}};}
  return {field,control,error,dirty:false};
}

export function createRecordEditor({getOperation,putOperation,listOperation,fields,jsonSchema,expectedSchemaVersion}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation)||(listOperation!==undefined&&!validOperation(listOperation)))throw Error('Invalid record editor capabilities');
  if(expectedSchemaVersion!==undefined&&(!Number.isSafeInteger(expectedSchemaVersion)||expectedSchemaVersion<0))throw Error('Invalid record schema version');
  if(fields!==undefined&&jsonSchema!==undefined)throw Error('Invalid record editor schema');
  const schema=jsonSchema===undefined?normalizeFields(fields):fieldsFromJsonSchema(jsonSchema);
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
    root.append(heading);if(listOperation){const browse=document.createElement('button'),next=document.createElement('button');browse.type='button';browse.textContent='Browse records';browse.disabled=true;next.type='button';next.textContent='Next page';next.disabled=true;root.append(browse,next);}root.append(idLabel,load);if(schema){for(const group of schema.groups??[]){if(!group.required){const label=document.createElement('label'),control=document.createElement('input');control.type='checkbox';control.disabled=true;label.append(control,document.createTextNode(' Include '+group.label+' (clearing removes this object)'));root.appendChild(label);}}for(const field of schema){const item=fieldControl(document,field);item.control.disabled=true;item.setDisabled?.(true);item.refresh?.();for(const child of item.control.querySelectorAll('button,input,select'))child.disabled=true;root.appendChild(item.wrapper??item.control.parentElement);}}else root.appendChild(valueLabel);root.append(save,status);return root;
  };
  return {render,validate};
}
`;
