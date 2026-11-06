import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
import {createRecordJsonSchemaValidator,RECORD_FORMATS} from '../../core/dist/index.js';
import {RECORD_EDITOR_PREVIEW} from '../../core/dist/data-editor-preview.js';

const wait=async predicate=>{for(let n=0;n<200&&!predicate();n++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate());};
async function setup(){const dir=await mkdtemp(join(tmpdir(),'schema-keywords-')),target=await createProject('sample-app',dir),runtime=await import(pathToFileURL(join(target,'data-editor.mjs')).href),preview=await import('data:text/javascript;base64,'+Buffer.from(RECORD_EDITOR_PREVIEW).toString('base64'));return {dir,runtime,preview};}
const options=jsonSchema=>({getOperation:'items.get',putOperation:'items.put',jsonSchema});
const labelled=(root,prefix)=>{const label=[...root.querySelectorAll('label')].find(x=>x.textContent.startsWith(prefix));assert.ok(label,prefix);return label.querySelector('input,select,textarea');};
// Drives the generated editor: load a record id (stored is null for a new record), then return helpers.
async function open(s,jsonSchema,stored,onSave){
 const dom=new JSDOM('<!doctype html>'),document=dom.window.document,root=s.runtime.createRecordEditor(options(jsonSchema)).render({},null,null,document);document.body.appendChild(root);
 globalThis.fetch=async(path,request)=>{const input=JSON.parse(request.body);if(path.endsWith('items.get'))return {ok:true,json:async()=>({result:stored===null?null:{id:input.id,revision:3,value:structuredClone(stored)}})};onSave(input.value);return {ok:true,json:async()=>({result:{id:input.id,revision:4}})};};
 const id=root.querySelector('input'),buttons=[...root.querySelectorAll('button')],save=buttons.find(x=>x.textContent==='Save'),status=root.querySelector('[role=status]');
 id.value='one';id.dispatchEvent(new dom.window.Event('input'));buttons.find(x=>x.textContent==='Load').click();
 await wait(()=>stored===null?status.textContent.startsWith('New record'):!save.disabled||/cannot edit/.test(status.textContent));
 const set=(control,value)=>{control.value=value;control.dispatchEvent(new dom.window.Event('input'));control.dispatchEvent(new dom.window.Event('change'));};
 return {dom,root,save,status,set};
}

test('the generated editor checks formats exactly as the server does',async()=>{const s=await setup();try{
 const {RECORD_FORM_FORMATS}=s.runtime;assert.deepEqual(Object.keys(RECORD_FORM_FORMATS).sort(),Object.keys(RECORD_FORMATS).sort());
 const corpus={
  date:['2024-02-29','2023-02-29','2023-02-28','2024-13-01','2024-00-10','2024-04-31','2024-12-31','24-01-01','2024-1-01','2024-01-01T00:00:00Z',' 2024-01-01','1900-02-29','2000-02-29',''],
  'date-time':['2026-01-31T09:30:00Z','2026-01-31t09:30:00Z','2026-01-31T09:30:00','2026-01-31T09:30:00.123456789+05:30','2026-01-31T09:30:00.1234567890Z','2026-01-31T24:00:00Z','2026-01-31T23:59:60Z','2026-02-30T00:00:00Z','2026-01-31T09:30:00-23:59','2026-01-31T09:30:00+24:00','2026-01-31 09:30:00Z','2026-01-31T09:30Z'],
  email:['a@example.com','first.last+tag@sub.example.org','a@b.c','a@localhost','.a@example.com','a..b@example.com','a@-example.com','a@example-.com','a@example.123','@example.com','a@','a b@example.com','x'.repeat(64)+'@example.com','x'.repeat(65)+'@example.com','a@'+'b'.repeat(64)+'.com','a@'+('b'.repeat(60)+'.').repeat(5)+'com','"quoted"@example.com','a@example.com.']};
 for(const [name,values] of Object.entries(corpus))for(const value of values)assert.equal(RECORD_FORM_FORMATS[name](value),RECORD_FORMATS[name](value),name+' '+JSON.stringify(value));
 for(const [name,valid,invalid] of [['date','2024-02-29','2023-02-29'],['date-time','2026-01-31T09:30:00+01:00','2026-01-31T09:30:00'],['email','a@example.com','a@localhost']]){
  const validate=createRecordJsonSchemaValidator({type:'object',properties:{value:{type:'string',format:name}}});
  assert.equal(validate({value:valid}),true,name);assert.equal(validate({value:invalid}),false,name);
 }
}finally{await rm(s.dir,{recursive:true,force:true});}});

test('format, deprecated and examples shape scalar controls in runtime and preview',async()=>{const s=await setup(),originalFetch=globalThis.fetch;let dom;try{
 const jsonSchema={type:'object',$comment:'internal note',properties:{born:{type:'string',format:'date',title:'Born'},mail:{type:'string',format:'email',title:'Mail',examples:['ada@example.com']},seen:{type:['string','null'],format:'date-time',title:'Seen'},code:{type:'string',title:'Code',deprecated:true,examples:['GB','FR'],$comment:'legacy'},size:{type:'integer',title:'Size',examples:[12]}},required:['born','mail']},validate=createRecordJsonSchemaValidator(jsonSchema);
 for(const factory of [s.runtime.createRecordEditor,s.preview.createRecordEditor]){
  dom=new JSDOM('<!doctype html>');const root=factory(options(jsonSchema)).render({},null,null,dom.window.document);dom.window.document.body.appendChild(root);
  assert.equal(labelled(root,'Born (required)').type,'date');const mail=labelled(root,'Mail (required)');assert.equal(mail.type,'email');assert.equal(mail.placeholder,'Example: ada@example.com');
  assert.equal(labelled(root,'Seen (optional)').placeholder,'Example: 2026-01-31T09:30:00Z');assert.equal(labelled(root,'Code (optional) (deprecated)').placeholder,'Example: GB');assert.equal(labelled(root,'Size (optional)').placeholder,'Example: 12');
  assert.doesNotMatch(root.textContent,/internal note|legacy/);dom.window.close();dom=undefined;
 }
 let saved;const page=await open(s,jsonSchema,null,value=>{saved=value;});dom=page.dom;
 page.set(labelled(page.root,'Born'),'2023-02-29');page.set(labelled(page.root,'Mail'),'not-an-address');page.save.click();
 assert.match(page.root.textContent,/Enter a valid date\./);assert.match(page.root.textContent,/Enter a valid email address\./);assert.equal(saved,undefined);
 page.set(labelled(page.root,'Born'),'2024-02-29');page.set(labelled(page.root,'Mail'),'ada@example.com');const include=labelled(page.root,' Include Seen');include.checked=true;include.dispatchEvent(new page.dom.window.Event('change'));page.set(labelled(page.root,'Seen'),'2026-01-31 09:30');page.save.click();
 assert.match(page.root.textContent,/Enter a date and time such as 2026-01-31T09:30:00Z\./);assert.equal(saved,undefined);
 page.set(labelled(page.root,'Seen'),'2026-01-31T09:30:00Z');page.save.click();await wait(()=>saved!==undefined);
 assert.deepEqual(saved,{born:'2024-02-29',mail:'ada@example.com',seen:'2026-01-31T09:30:00Z'});assert.equal(validate(saved),true);
}finally{dom?.window.close();globalThis.fetch=originalFetch;await rm(s.dir,{recursive:true,force:true});}});

test('a stored value with an invalid format is not loaded into a format field',async()=>{const s=await setup(),originalFetch=globalThis.fetch;let dom;try{
 const page=await open(s,{type:'object',properties:{born:{type:'string',format:'date',title:'Born'}}},{born:'31/01/2026'},()=>{});dom=page.dom;
 assert.match(page.status.textContent,/cannot edit/);assert.equal(page.save.disabled,true);
}finally{dom?.window.close();globalThis.fetch=originalFetch;await rm(s.dir,{recursive:true,force:true});}});

test('defaults prefill new records only and read-only values are shown but preserved',async()=>{const s=await setup(),originalFetch=globalThis.fetch;let dom;try{
 const jsonSchema={type:'object',properties:{status:{type:'string',enum:['draft','live'],default:'draft',title:'Status'},count:{type:'integer',minimum:0,default:3,title:'Count'},active:{type:'boolean',default:true,title:'Active'},note:{type:['string','null'],default:null,title:'Note'},created:{type:'string',format:'date',readOnly:true,title:'Created'}},required:['status']},validate=createRecordJsonSchemaValidator(jsonSchema);
 let saved;let page=await open(s,jsonSchema,null,value=>{saved=value;});dom=page.dom;
 assert.equal(labelled(page.root,'Count').value,'3');const created=labelled(page.root,'Created');assert.equal(created.disabled,true);
 page.save.click();await wait(()=>saved!==undefined);assert.deepEqual(saved,{status:'draft',count:3,active:true,note:null});assert.equal(validate(saved),true);
 dom.window.close();saved=undefined;
 page=await open(s,jsonSchema,{status:'live',created:'2025-05-01',extra:'kept'},value=>{saved=value;});dom=page.dom;
 assert.equal(labelled(page.root,'Count').value,'');assert.equal(labelled(page.root,'Created').value,'2025-05-01');assert.equal(labelled(page.root,'Created').disabled,true);
 page.set(labelled(page.root,'Count'),'5');page.save.click();await wait(()=>saved!==undefined);
 assert.deepEqual(saved,{status:'live',created:'2025-05-01',extra:'kept',count:5});
}finally{dom?.window.close();globalThis.fetch=originalFetch;await rm(s.dir,{recursive:true,force:true});}});

test('discriminated unions enable only the chosen variant and drop the others on save',async()=>{const s=await setup(),originalFetch=globalThis.fetch;let dom;try{
 const jsonSchema={type:'object',properties:{label:{type:'string',title:'Label'},method:{type:'string',enum:['card','bank'],title:'Method'}},required:['method'],oneOf:[{title:'Card',properties:{method:{const:'card'},cardNumber:{type:'string',pattern:'^[0-9]{12,19}$',title:'Card number'}},required:['cardNumber']},{title:'Bank',properties:{method:{const:'bank'},iban:{type:'string',title:'IBAN'},reference:{type:'string',title:'Reference'}},required:['iban']}]},validate=createRecordJsonSchemaValidator(jsonSchema);
 dom=new JSDOM('<!doctype html>');const preview=s.preview.createRecordEditor(options(jsonSchema)).render({},null,null,dom.window.document);
 assert.ok(labelled(preview,'Card number (required)'));assert.ok(labelled(preview,'IBAN (required)'));assert.ok(labelled(preview,'Reference (optional)'));dom.window.close();
 let saved;const page=await open(s,jsonSchema,{method:'bank',iban:'GB00',reference:'old'},value=>{saved=value;});dom=page.dom;
 const method=labelled(page.root,'Method'),card=labelled(page.root,'Card number'),iban=labelled(page.root,'IBAN');
 assert.equal(card.disabled,true);assert.equal(iban.disabled,false);assert.equal(iban.value,'GB00');
 const cardOption=[...method.options].find(x=>x.textContent.includes('card'));page.set(method,cardOption.value);
 assert.equal(card.disabled,false);assert.equal(iban.disabled,true);
 page.save.click();assert.equal(saved,undefined);assert.match(page.root.textContent,/required/i);
 page.set(card,'4111111111111111');page.save.click();await wait(()=>saved!==undefined);
 assert.deepEqual(saved,{method:'card',cardNumber:'4111111111111111'});assert.equal(validate(saved),true);
}finally{dom?.window.close();globalThis.fetch=originalFetch;await rm(s.dir,{recursive:true,force:true});}});

test('annotations describe groups and arrays and title scalar array items',async()=>{const s=await setup();let dom;try{
 const jsonSchema={type:'object',properties:{address:{type:'object',title:'Address',description:'Where letters go.',properties:{city:{type:'string',title:'City'}},required:['city']},tags:{type:'array',title:'Tags',description:'Short labels.',items:{type:'string',title:'Tag'}}},required:['address']};
 for(const factory of [s.runtime.createRecordEditor,s.preview.createRecordEditor]){
  dom=new JSDOM('<!doctype html>');const document=dom.window.document,root=factory(options(jsonSchema)).render({},null,null,document);document.body.appendChild(root);
  assert.match(root.textContent,/Address: Where letters go\./);assert.match(root.textContent,/Short labels\./);
  dom.window.close();dom=undefined;
 }
 const originalFetch=globalThis.fetch;try{const page=await open(s,jsonSchema,{address:{city:'Leeds'},tags:['a','b']},()=>{});dom=page.dom;
  const labels=[...page.root.querySelectorAll('label')].map(x=>x.textContent);assert.ok(labels.some(x=>x.startsWith('Tag 1 (required)')),labels.join('|'));assert.ok(labels.some(x=>x.startsWith('Tag 2 (required)')));
 }finally{globalThis.fetch=originalFetch;}
}finally{dom?.window.close();await rm(s.dir,{recursive:true,force:true});}});

test('unsupported uses of the new keywords are rejected in runtime and preview',async()=>{const s=await setup();try{
 const branch=(value,extra={})=>({properties:{kind:{const:value},...extra}});const kind={type:'string',enum:['a','b']};
 const bad=[
  {properties:{v:{type:'integer',format:'date'}}},{properties:{v:{type:'string',format:'uri'}}},{properties:{v:{type:'string',enum:['x'],format:'email'}}},
  {properties:{v:{type:'boolean',examples:[true]}}},{properties:{v:{type:'string',examples:[]}}},{properties:{v:{type:'string',examples:[1]}}},{properties:{v:{type:'string',enum:['x','y'],examples:['x']}}},
  {properties:{v:{type:'string',deprecated:'yes'}}},{properties:{v:{type:'string',readOnly:1}}},{properties:{v:{type:'array',items:{type:'object',properties:{w:{type:'string',readOnly:true}}}}}},
  {properties:{v:{type:'integer',minimum:5,default:2}}},{properties:{v:{type:'string',default:null}}},{properties:{v:{type:'string',pattern:'^a$',default:'b'}}},{properties:{v:{type:'string',enum:['x'],default:'y'}}},{properties:{v:{type:'string',format:'date',default:'soon'}}},{properties:{v:{type:'string',readOnly:true,default:'x'}}},
  {properties:{kind},required:['kind'],oneOf:[branch('a')]},
  {properties:{kind},required:['kind'],oneOf:[branch('a'),branch('b')],anyOf:[branch('a'),branch('b')]},
  {properties:{kind},oneOf:[branch('a'),branch('b')]},
  {properties:{kind},required:['kind'],oneOf:[branch('a'),branch('a')]},
  {properties:{kind:{type:'string',enum:['a','b','c']}},required:['kind'],oneOf:[branch('a'),branch('b')]},
  {properties:{kind,other:{type:'string',enum:['x','y']}},required:['kind','other'],oneOf:[branch('a'),{properties:{other:{const:'y'}}}]},
  {properties:{kind},required:['kind'],oneOf:[branch('a',{x:{type:'string'}}),branch('b',{x:{type:'string'}})]},
  {properties:{kind},required:['kind'],oneOf:[branch('a',{x:{type:'object',properties:{}}}),branch('b')]},
  {properties:{kind},required:['kind'],oneOf:[branch('a',{x:{type:'string',readOnly:true}}),branch('b')]},
  {properties:{kind},required:['kind'],oneOf:[{...branch('a'),required:['missing']},branch('b')]},
  {properties:{kind},required:['kind'],oneOf:[{...branch('a'),else:{}},branch('b')]},
  {properties:{list:{type:'array',items:{type:'object',properties:{kind},required:['kind'],oneOf:[branch('a'),branch('b')]}}}},
 ];
 for(const factory of [s.runtime.createRecordEditor,s.preview.createRecordEditor]){
  for(const shape of bad)assert.throws(()=>factory(options({type:'object',...shape})),/Unsupported/,JSON.stringify(shape));
  assert.doesNotThrow(()=>factory(options({type:'object',properties:{kind},required:['kind'],anyOf:[branch('a',{x:{type:'string'}}),branch('b')]})));
  assert.doesNotThrow(()=>factory(options({type:'object',properties:{v:{$ref:'#/$defs/d',$comment:'shared'}},$defs:{d:{type:'string',format:'email',default:'a@example.com'}}})));
 }
}finally{await rm(s.dir,{recursive:true,force:true});}});
