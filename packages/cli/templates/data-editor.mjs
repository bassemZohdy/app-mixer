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
function resolveFormSchema(root){
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);let count=0;
  const pointer=ref=>{
    if(ref==='#')return root;
    if(typeof ref!=='string'||!ref.startsWith('#/')||ref.includes('%'))throw Error('Unsupported record JSON Schema form');
    let value=root;for(const raw of ref.slice(2).split('/')){if(/~(?![01])/.test(raw))throw Error('Unsupported record JSON Schema form');const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');if(!object(value)||!Object.hasOwn(value,key))throw Error('Unsupported record JSON Schema form');value=value[key];}return value;
  };
  const visit=(schema,stack,depth)=>{
    if(++count>1000||depth>30)throw Error('Unsupported record JSON Schema form');
    if(!object(schema))return schema;
    if(Object.hasOwn(schema,'$ref')){
      if(Object.keys(schema).some(key=>!['$ref','title'].includes(key))||typeof schema.$ref!=='string'||stack.includes(schema.$ref))throw Error('Unsupported record JSON Schema form');
      const resolved=visit(pointer(schema.$ref),[...stack,schema.$ref],depth+1);if(!object(resolved))throw Error('Unsupported record JSON Schema form');
      return Object.hasOwn(schema,'title')?{...resolved,title:schema.title}:resolved;
    }
    if(Object.hasOwn(schema,'$defs')&&!object(schema.$defs))throw Error('Unsupported record JSON Schema form');
    const result=Object.create(null);for(const [key,value] of Object.entries(schema)){
      if(key==='$defs')continue;
      if(key==='properties'&&object(value)){const properties=Object.create(null);for(const [name,child] of Object.entries(value))properties[name]=visit(child,stack,depth+1);result[key]=properties;}
      else if(key==='items')result[key]=visit(value,stack,depth+1);
      else result[key]=value;
    }return result;
  };
  return visit(root,[],0);
}

function fieldsFromJsonSchema(jsonSchema) {
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value), keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
  const fields=[],groups=[];
  const itemTree=(node,depth=0)=>depth<=5&&object(node)&&object(node.properties)&&Object.values(node.properties).every(child=>object(child)&&(child.type==='object'?itemTree(child,depth+1):child.type==='array'?object(child.items)&&['string','number','integer','boolean'].includes(child.items.type):['string','number','integer','boolean'].includes(child.type)));
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
          if(!keys(property,['type','title','items','minItems','maxItems'])||!keys(spec,['type','title','properties','required','additionalProperties'])||!itemTree(spec)||!Number.isSafeInteger(minItems)||!Number.isSafeInteger(maxItems)||minItems<0||maxItems<minItems||maxItems>50||(property.title!==undefined&&(typeof property.title!=='string'||!property.title.trim()||property.title.length>120))||(spec.title!==undefined&&(typeof spec.title!=='string'||!spec.title.trim()||spec.title.length>120)))throw Error('Unsupported record JSON Schema form');
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

function pathValue(value,path){for(const key of path){if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
function pathParent(value,path){for(const key of path.slice(0,-1))value=value[key];return value;}
function pathActive(groups,path){return groups.filter(group=>group.path.length<path.length&&group.path.every((key,i)=>key===path[i])).every(group=>group.control.checked);}

function fieldControl(document,field) {
  if(field.type==='array'||field.type==='objectArray'){
    const wrapper=document.createElement('div'),control=document.createElement('fieldset'),title=document.createElement('legend'),error=document.createElement('small'),list=document.createElement('div'),add=document.createElement('button');
    title.textContent=field.label+(field.required?' (required)':' (optional)');control.appendChild(title);let include;
    if(!field.required){const label=document.createElement('label');include=document.createElement('input');include.type='checkbox';label.append(include,document.createTextNode(' Include '+field.label));control.appendChild(label);}
    add.type='button';add.textContent='Add '+field.label+' item';error.setAttribute('role','alert');control.append(list,add,error);wrapper.appendChild(control);const rows=[];
    const refresh=()=>{for(let i=0;i<rows.length;i++){if(rows[i].item)rows[i].item.control.parentElement.firstChild.textContent=field.label+' item '+(i+1)+' (required)';else rows[i].legend.textContent=field.label+' item '+(i+1);}add.disabled=control.disabled||(!field.required&&!include.checked)||rows.length>=field.maxItems;for(const row of rows){const disabled=control.disabled||(!field.required&&!include.checked);for(const group of row.groups??[])group.control.disabled=disabled||!pathActive(row.groups,group.path);for(const item of row.items??[row.item]){item.control.disabled=disabled||(row.groups&&!pathActive(row.groups,item.field.path));item.setDisabled?.(item.control.disabled);item.refresh?.();}row.remove.disabled=disabled;}};
    const append=value=>{const remove=document.createElement('button'),row=document.createElement('div');remove.type='button';remove.textContent='Remove '+field.label+' item';let entry;
      if(field.type==='objectArray'){const box=document.createElement('fieldset'),legend=document.createElement('legend'),original=value===undefined?{}:JSON.parse(JSON.stringify(value)),groups=field.itemFields.groups.map(group=>{const label=document.createElement('label'),control=document.createElement('input');control.type='checkbox';control.checked=group.required||pathValue(original,group.path)!==undefined;label.append(control,document.createTextNode(' Include '+group.label+' (clearing removes this object)'));return {...group,control,label};}),items=field.itemFields.map(child=>{const item=fieldControl(document,child),initial=pathValue(original,child.path);if(item.setValue)item.setValue(initial);else item.control.value=initial===undefined?'':String(initial);item.control.addEventListener('input',()=>{item.dirty=true});item.control.addEventListener('change',()=>{item.dirty=true});return item;});box.appendChild(legend);for(const group of groups){if(!group.required)box.appendChild(group.label);group.control.addEventListener('change',()=>{refresh();control.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));});}for(const item of items)box.appendChild(item.wrapper??item.control.parentElement);row.append(box,remove);entry={items,groups,legend,original,remove,row};}
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


// The host chooses the capabilities; application definitions only supply a label.
export function createRecordEditor({getOperation,putOperation,listOperation,fields,jsonSchema,expectedSchemaVersion}) {
  const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
  if(!validOperation(getOperation)||!validOperation(putOperation)||(listOperation!==undefined&&!validOperation(listOperation)))throw Error('Invalid record editor capabilities');
  if(expectedSchemaVersion!==undefined&&(!Number.isSafeInteger(expectedSchemaVersion)||expectedSchemaVersion<0))throw Error('Invalid record schema version');
  if(fields!==undefined&&jsonSchema!==undefined)throw Error('Invalid record editor schema');
  const schema=jsonSchema===undefined?normalizeFields(fields):fieldsFromJsonSchema(resolveFormSchema(jsonSchema));
  const validate=component=>{
    if(!component||Object.keys(component).some(key=>!['id','component','label'].includes(key))||
       (component.label!==undefined&&(typeof component.label!=='string'||component.label.length>120)))throw Error('Invalid record editor');
  };
  const render=(component,_child,_data,document)=>{
    const root=document.createElement('section'),heading=document.createElement('h3'),idLabel=document.createElement('label'),id=document.createElement('input'),valueLabel=document.createElement('label'),value=document.createElement('textarea'),load=document.createElement('button'),save=document.createElement('button'),status=document.createElement('p');
    heading.textContent=component.label||'Record';idLabel.textContent='Record ID';valueLabel.textContent='Record data (JSON object)';
    idLabel.appendChild(id);valueLabel.appendChild(value);load.type='button';load.textContent='Load';save.type='button';save.textContent='Save';save.disabled=true;
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Enter a record ID and load it.';
    const browse=listOperation?document.createElement('button'):null,next=listOperation?document.createElement('button'):null,results=listOperation?document.createElement('ul'):null,listStatus=listOperation?document.createElement('p'):null;let cursor;
    if(browse){browse.type='button';browse.textContent='Browse records';next.type='button';next.textContent='Next page';next.disabled=true;listStatus.setAttribute('role','status');listStatus.setAttribute('aria-live','polite');}
    const controls=schema?.map(field=>fieldControl(document,field))??[],groups=(schema?.groups??[]).map(group=>{const label=document.createElement('label'),control=document.createElement('input');control.type='checkbox';label.append(control,document.createTextNode(' Include '+group.label+' (clearing removes this object)'));return {...group,control,label,dirty:false};});root.append(heading);if(browse)root.append(browse,results,next,listStatus);root.append(idLabel,load);if(schema){for(const group of groups)if(!group.required)root.appendChild(group.label);for(const item of controls)root.appendChild(item.wrapper??item.control.parentElement);}else root.appendChild(valueLabel);root.append(save,status);
    const parentActive=path=>groups.filter(group=>group.path.length<path.length&&group.path.every((key,i)=>key===path[i])).every(group=>group.control.checked);
    const groupActive=path=>groups.filter(group=>group.path.length<path.length&&group.path.every((key,i)=>key===path[i])).every(group=>group.control.checked);
    const compatible=(field,value)=>(field.type==='string'&&typeof value==='string'&&(!field.options||field.options.includes(value)))||(field.type==='boolean'&&typeof value==='boolean')||((field.type==='number'||field.type==='integer')&&typeof value==='number'&&Number.isFinite(value)&&(field.type!=='integer'||Number.isSafeInteger(value)));
    const at=(data,path)=>{let value=data;for(const key of path){if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;};
    const parent=(data,path)=>{let value=data;for(const key of path.slice(0,-1))value=value[key];return value;};
    let revision=null,loadedId='',busy=false,preserveEdits=false,original={},lastSavedJSON='';
    const setBusy=active=>{busy=active;id.disabled=active;value.disabled=active;load.disabled=active;save.disabled=active||!loadedId;for(const group of groups)group.control.disabled=active||(!loadedId&&!preserveEdits)||!parentActive(group.path);for(const item of controls){item.control.disabled=active||(!loadedId&&!preserveEdits)||!groupActive(item.field.path??[item.field.key]);item.setDisabled?.(item.control.disabled);item.refresh?.();}if(browse){browse.disabled=active;next.disabled=active||!cursor;for(const button of results.querySelectorAll('button'))button.disabled=active;}};
    const readField=item=>{const {field,control}=item;if(field.type==='array'||field.type==='objectArray'){if(item.include&&!item.include.checked)return undefined;if(item.rows.length<field.minItems||item.rows.length>field.maxItems)throw Error('Enter between '+field.minItems+' and '+field.maxItems+' items.');return item.rows.map(row=>{if(row.item)return readField(row.item);const value=JSON.parse(JSON.stringify(row.original));for(const group of row.groups){if(!pathActive(row.groups,group.path))continue;const owner=pathParent(value,group.path),key=group.path.at(-1);if(group.control.checked){if(!Object.hasOwn(owner,key))owner[key]={};}else delete owner[key];}for(const child of row.items){const path=child.field.path;if(!pathActive(row.groups,path))continue;const next=readField(child),owner=pathParent(value,path),key=path.at(-1);if(next===undefined){if(child.dirty||pathValue(row.original,path)===undefined)delete owner[key];}else owner[key]=next;}return value;});}if(field.jsonString){if(item.include&&!item.include.checked)return undefined;const text=control.value;if(field.options&&!field.options.includes(text))throw Error('Choose a valid option.');const length=Array.from(text).length;if(field.jsonMinLength!==undefined&&length<field.jsonMinLength)throw Error('Enter at least '+field.jsonMinLength+' characters.');if(field.jsonMaxLength!==undefined&&length>field.jsonMaxLength)throw Error('Enter no more than '+field.jsonMaxLength+' characters.');return text;}const raw=control.value;if(control.validity.badInput)throw Error('Enter a valid number.');if(raw===''){if(field.required)throw Error('This field is required.');return undefined;}if(field.type==='boolean')return raw==='true';if(field.type==='string'){if(field.maxLength!==undefined&&raw.length>field.maxLength)throw Error('Enter no more than '+field.maxLength+' characters.');if(field.options&&!field.options.includes(raw))throw Error('Choose a valid option.');return raw;}const parsed=Number(raw);if(!Number.isFinite(parsed)||(field.type==='integer'&&!Number.isSafeInteger(parsed)))throw Error(field.type==='integer'?'Enter a whole number.':'Enter a valid number.');if(field.min!==undefined&&parsed<field.min)throw Error('Enter a value of at least '+field.min+'.');if(field.max!==undefined&&parsed>field.max)throw Error('Enter a value of at most '+field.max+'.');return parsed;};
    const checkField=item=>{try{readField(item);item.error.textContent='';item.control.removeAttribute('aria-invalid');return true}catch(error){item.error.textContent=error.message;item.control.setAttribute('aria-invalid','true');return false;}};
    for(const group of groups){group.control.checked=group.required;group.control.disabled=true;group.control.addEventListener('change',()=>{group.dirty=true;setBusy(false);});}
    for(const item of controls){item.control.disabled=true;item.setDisabled?.(true);item.control.addEventListener('input',()=>{item.dirty=true});item.control.addEventListener('change',()=>{item.dirty=true});item.control.addEventListener('blur',()=>checkField(item));}

    id.addEventListener('input',()=>{loadedId='';preserveEdits=false;save.disabled=true;for(const item of controls){item.control.disabled=true;item.setDisabled?.(true);}for(const group of groups)group.control.disabled=true;status.textContent='Load this record before saving.';});
    load.addEventListener('click',async()=>{
      const recordId=id.value;if(busy||!recordId.trim()){status.textContent='Enter a record ID.';return;}
      const hadEditorData=!!loadedId||preserveEdits;preserveEdits=false;setBusy(true);loadedId='';
      try {
        const result=await invokeCapability(getOperation,{id:recordId,...(expectedSchemaVersion===undefined?{}:{expectedSchemaVersion})});
        if(result!==null&&(!result||typeof result!=='object'||result.id!==recordId||!Number.isSafeInteger(result.revision)||result.revision<1||!result.value||typeof result.value!=='object'||Array.isArray(result.value)))throw Error('Invalid record response');
        const data=result===null?{}:result.value;
        if(schema){for(const group of groups){const current=at(data,group.path);if(current!==undefined&&(!current||typeof current!=='object'||Array.isArray(current)))throw Error('Record contains values this form cannot edit.');}for(const item of controls){const field=item.field,current=at(data,field.path??[field.key]);if(current===undefined)continue;if(field.type==='objectArray'){if(!Array.isArray(current)||current.length>field.maxItems||current.some(value=>!value||typeof value!=='object'||Array.isArray(value)||field.itemFields.groups.some(group=>{const nested=pathValue(value,group.path);return nested!==undefined&&(!nested||typeof nested!=='object'||Array.isArray(nested));})||field.itemFields.some(child=>{const nested=pathValue(value,child.path);return nested!==undefined&&(child.type==='array'?(!Array.isArray(nested)||nested.length>child.maxItems||nested.some(entry=>!compatible(child.item,entry))):!compatible(child,nested));})))throw Error('Record contains values this form cannot edit.');continue;}if(field.type==='array'){if(!Array.isArray(current)||current.length>field.maxItems||current.some(value=>(field.item.type==='string'&&(typeof value!=='string'||(field.item.options&&!field.item.options.includes(value))))||(field.item.type==='boolean'&&typeof value!=='boolean')||((field.item.type==='number'||field.item.type==='integer')&&(typeof value!=='number'||!Number.isFinite(value)||(field.item.type==='integer'&&!Number.isSafeInteger(value))))))throw Error('Record contains values this form cannot edit.');continue;}if((field.type==='string'&&(typeof current!=='string'||(field.options&&!field.options.includes(current))))||(field.type==='boolean'&&typeof current!=='boolean')||((field.type==='number'||field.type==='integer')&&(typeof current!=='number'||!Number.isFinite(current)||(field.type==='integer'&&!Number.isSafeInteger(current)))))throw Error('Record contains values this form cannot edit.');}}
        revision=result===null?null:result.revision;original=JSON.parse(JSON.stringify(data));value.value=JSON.stringify(data,null,2);lastSavedJSON=value.value;for(const group of groups){group.control.checked=group.required||at(data,group.path)!==undefined;group.dirty=false;}for(const item of controls){const current=at(data,item.field.path??[item.field.key]);if(item.setValue)item.setValue(current);else item.control.value=current===undefined?'':String(current);item.dirty=false;item.error.textContent='';item.control.removeAttribute('aria-invalid');}loadedId=recordId;
        status.textContent=result===null?'New record. Enter data and save.':'Record loaded.';
      } catch(error){if(error.message==='Data schema version conflict'){preserveEdits=hadEditorData;status.textContent='Data schema changed. Copy any edits and update the editor configuration before loading.';}else status.textContent=error.message||'Could not load record.';}
      finally {setBusy(false);}
    });
    save.addEventListener('click',async()=>{
      if(busy||!loadedId||id.value!==loadedId)return;
      let parsed;if(schema){let valid=true;for(const item of controls)if(groupActive(item.field.path??[item.field.key])&&!checkField(item))valid=false;if(!valid){status.textContent='Check the fields marked above.';return;}parsed=JSON.parse(JSON.stringify(original));for(const group of groups){if(!parentActive(group.path))continue;const owner=parent(parsed,group.path),key=group.path.at(-1);if(group.control.checked){if(!Object.hasOwn(owner,key))owner[key]={};}else delete owner[key];}for(const item of controls){const path=item.field.path??[item.field.key];if(!groupActive(path))continue;const owner=parent(parsed,path),key=path.at(-1),next=readField(item);if(next===undefined){if(item.dirty||at(original,path)===undefined)delete owner[key];}else owner[key]=next;}}else try{parsed=JSON.parse(value.value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Expected an object');}catch{status.textContent='Enter a valid JSON object.';return;}
      setBusy(true);
      try {
        const result=await invokeCapability(putOperation,{id:loadedId,expectedRevision:revision,value:parsed,...(expectedSchemaVersion===undefined?{}:{expectedSchemaVersion})});
        if(!result||result.id!==loadedId||!Number.isSafeInteger(result.revision)||result.revision<1)throw Error('Invalid save response');
        revision=result.revision;original=JSON.parse(JSON.stringify(parsed));lastSavedJSON=value.value;if(schema){for(const item of controls){item.dirty=false;if(item.field.type==='objectArray'){const saved=at(parsed,item.field.path??[item.field.key]);item.rows.forEach((row,index)=>{row.original=Array.isArray(saved)&&saved[index]?JSON.parse(JSON.stringify(saved[index])):{};for(const child of row.items)child.dirty=false;});}}for(const group of groups)group.dirty=false;}status.textContent='Record saved.';
      } catch(error){
        if(error.status===409){loadedId='';preserveEdits=true;status.textContent=error.message==='Data schema version conflict'?'Data schema changed. Copy your edits and update the editor configuration before reloading.':'Record changed elsewhere. Copy your edits, then load the latest version.';}
        else status.textContent=error.message||'Could not save record.';
      } finally {setBusy(false);}
    });
    if(browse){
      const hasEdits=()=>preserveEdits||!!loadedId&&(schema?(controls.some(item=>item.dirty)||groups.some(group=>group.dirty)):value.value!==lastSavedJSON);
      const getPage=async(pageCursor)=>{if(busy)return;setBusy(true);listStatus.textContent='Loading records...';try{const page=await invokeCapability(listOperation,{limit:50,...(pageCursor?{cursor:pageCursor}:{}),...(expectedSchemaVersion===undefined?{}:{expectedSchemaVersion})});if(!page||typeof page!=='object'||!Array.isArray(page.items)||page.items.length>50||(page.nextCursor!==undefined&&(typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor.length>3000))||page.items.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||!item.id.trim()||item.id.length>256||/[\u0000-\u001f]/.test(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1))throw Error('Invalid record list');results.replaceChildren();for(const item of page.items){const row=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=item.id;button.addEventListener('click',()=>{if(busy||!button.isConnected||!root.contains(button))return;if(hasEdits()){listStatus.textContent='Save or copy your edits before selecting another record.';return;}id.value=item.id;id.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));load.click();});row.appendChild(button);results.appendChild(row);}cursor=page.nextCursor;listStatus.textContent=page.items.length?String(page.items.length)+' record(s) on this page.':cursor?'No visible records on this page. More may be available.':'No records on this page.';}catch(error){if(error.message==='Data schema version conflict'){results.replaceChildren();cursor=undefined;listStatus.textContent='Data schema changed. Update the editor configuration before browsing.';}else listStatus.textContent=error.message||'Could not load records.';}finally{setBusy(false);}};
      browse.addEventListener('click',()=>getPage(undefined));next.addEventListener('click',()=>{if(cursor)getPage(cursor);});
    }
    return root;
  };
  return {render,validate};
}
