import {Ajv2020} from 'ajv/dist/2020.js';
import {dataCopy} from './data-provider.js';
import {RECORD_FORMATS} from './record-formats.js';

/** Compile trusted draft 2020-12 schemas for bounded JSON-object records. */
export function createRecordJsonSchemaValidator(schema:unknown):(value:unknown)=>boolean {
 let snapshot:Record<string,unknown>|boolean;
 try{snapshot=typeof schema==='boolean'?schema:dataCopy(schema);}catch{throw Error('Invalid record JSON Schema');}
 try{
  if(typeof snapshot==='object'&&snapshot.$async===true)throw Error('Async schema unsupported');
  const ajv=new Ajv2020({strict:true,strictTypes:false,strictRequired:false,allowUnionTypes:true,allErrors:false,validateFormats:true,ownProperties:true});
  // Only these formats are known; any other format still fails compilation in strict mode.
  for(const [name,check] of Object.entries(RECORD_FORMATS))ajv.addFormat(name,{type:'string',validate:check});
  const validate=ajv.compile(snapshot);
  return (value:unknown):boolean=>{try{return validate(dataCopy(value))===true;}catch{return false;}};
 }catch{throw Error('Invalid record JSON Schema');}
}
