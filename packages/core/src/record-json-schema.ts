import {Ajv2020} from 'ajv/dist/2020.js';
import {dataCopy} from './data-provider.js';

// Compare the canonical decimal forms of JavaScript numbers, without rounding the quotient.
function decimalMultiple(value:number,divisor:number):boolean {
 const parts=(number:number):[bigint,number]=>{const [mantissa,exp='0']=number.toString().split('e'),[whole,fraction='']=mantissa.split('.');return [BigInt(whole+fraction),Number(exp)-fraction.length];};
 const [numerator,numeratorExponent]=parts(value),[denominator,denominatorExponent]=parts(divisor),difference=numeratorExponent-denominatorExponent;
 return difference>=0?(numerator*10n**BigInt(difference))%denominator===0n:numerator%(denominator*10n**BigInt(-difference))===0n;
}

/** Compile trusted draft 2020-12 schemas for bounded JSON-object records. */
export function createRecordJsonSchemaValidator(schema:unknown):(value:unknown)=>boolean {
 let snapshot:Record<string,unknown>|boolean;
 try{snapshot=typeof schema==='boolean'?schema:dataCopy(schema);}catch{throw Error('Invalid record JSON Schema');}
 try{
  if(typeof snapshot==='object'&&snapshot.$async===true)throw Error('Async schema unsupported');
  const ajv=new Ajv2020({strict:true,strictTypes:false,strictRequired:false,allowUnionTypes:true,allErrors:false,validateFormats:true,ownProperties:true});
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({keyword:'multipleOf',type:'number',schemaType:'number',metaSchema:{type:'number',exclusiveMinimum:0},validate:(divisor:number,value:number)=>decimalMultiple(value,divisor)});
  const validate=ajv.compile(snapshot);
  return (value:unknown):boolean=>{try{return validate(dataCopy(value))===true;}catch{return false;}};
 }catch{throw Error('Invalid record JSON Schema');}
}
