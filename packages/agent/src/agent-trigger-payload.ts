import {AgentError} from './errors.js';
export function canonicalTriggerPayload(value:unknown):string {
 let count=0;const ancestors=new Set<object>();
 const copy=(x:unknown,depth:number):unknown=>{
  if(++count>10000||depth>40)throw new AgentError('invalid','Invalid trigger payload');
  if(x===null||typeof x==='boolean'||typeof x==='string'||(typeof x==='number'&&Number.isFinite(x)))return x;
  if(!x||typeof x!=='object'||ancestors.has(x))throw new AgentError('invalid','Invalid trigger payload');ancestors.add(x);let result:unknown;
  if(Array.isArray(x)){if(x.length>10000||Object.keys(x).length!==x.length||Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)).some(v=>!v))throw new AgentError('invalid','Invalid trigger payload');result=x.map(y=>copy(y,depth+1));}
  else{if(![Object.prototype,null].includes(Object.getPrototypeOf(x)))throw new AgentError('invalid','Invalid trigger payload');const obj:Record<string,unknown>={};for(const key of Object.keys(x).sort()){if(['__proto__','constructor','prototype'].includes(key))throw new AgentError('invalid','Invalid trigger payload');obj[key]=copy((x as Record<string,unknown>)[key],depth+1);}result=obj;}
  ancestors.delete(x);return result;
 };
 const text=JSON.stringify(copy(value,0));if(Buffer.byteLength(text)>256*1024)throw new AgentError('invalid','Invalid trigger payload');return text;
}
