import {dataCopy} from './data-provider.js';

export type RecordField={key:string;label:string;type:'string'|'number'|'integer'|'boolean';required?:boolean;min?:number;max?:number;maxLength?:number;options?:string[]};
type Options={allowAdditionalFields?:boolean};
/** Validate the bounded host-defined form schema and snapshot it for server-side use. */
export function createRecordFieldValidator(fields:RecordField[],options:Options={}):(value:unknown)=>boolean {
 if(!Array.isArray(fields)||fields.length<1||fields.length>40||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='allowAdditionalFields')||(options.allowAdditionalFields!==undefined&&typeof options.allowAdditionalFields!=='boolean'))throw Error('Invalid record fields');
 const seen=new Set<string>(),schema=fields.map(field=>{
  if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).some(key=>!['key','label','type','required','min','max','maxLength','options'].includes(key))||typeof field.key!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key)||['constructor','prototype','__proto__'].includes(field.key)||seen.has(field.key)||typeof field.label!=='string'||!field.label.trim()||field.label.length>120||!['string','number','integer','boolean'].includes(field.type)||(field.required!==undefined&&typeof field.required!=='boolean'))throw Error('Invalid record fields');
  seen.add(field.key);const numeric=field.type==='number'||field.type==='integer';
  if((field.min!==undefined&&(!numeric||!Number.isFinite(field.min)))||(field.max!==undefined&&(!numeric||!Number.isFinite(field.max)))||(field.min!==undefined&&field.max!==undefined&&field.min>field.max)||(field.maxLength!==undefined&&(field.type!=='string'||!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>4096))||(field.options!==undefined&&(field.type!=='string'||!Array.isArray(field.options)||field.options.length<1||field.options.length>100||field.options.some(value=>typeof value!=='string'||!value||value.length>120)||new Set(field.options).size!==field.options.length)))throw Error('Invalid record fields');
  return {key:field.key,type:field.type,required:field.required===true,...(field.min===undefined?{}:{min:field.min}),...(field.max===undefined?{}:{max:field.max}),...(field.maxLength===undefined?{}:{maxLength:field.maxLength}),...(field.options===undefined?{}:{options:[...field.options]})};
 });
 const allowAdditional=options.allowAdditionalFields??true;
 return (value:unknown):boolean=>{
  let safe:Record<string,unknown>;try{safe=dataCopy(value);}catch{return false;}
  if(!allowAdditional&&Object.keys(safe).some(key=>!seen.has(key)))return false;
  for(const field of schema){if(!Object.hasOwn(safe,field.key)){if(field.required)return false;continue;}const current=safe[field.key];
   if(field.type==='string'){if(typeof current!=='string'||(field.required&&current==='')||(field.maxLength!==undefined&&current.length>field.maxLength)||(field.options&&!field.options.includes(current)))return false;}
   else if(field.type==='boolean'){if(typeof current!=='boolean')return false;}
   else if(typeof current!=='number'||!Number.isFinite(current)||(field.type==='integer'&&!Number.isSafeInteger(current))||(field.min!==undefined&&current<field.min)||(field.max!==undefined&&current>field.max))return false;
  }return true;
 };
}
export type {Options as RecordFieldValidatorOptions};
