import { importOpenAPI, type CapabilityCandidate } from './capabilities.js';

type PolicyContext = {tenantId:string;principalId:string};
type Parameter = {name:string; location:'path'|'query'; required:boolean; type:'string'|'integer'|'number'|'boolean'; minimum?:number; maximum?:number; minLength?:number; maxLength?:number};
type Input = {path?:Record<string,unknown>;query?:Record<string,unknown>};
type Options = {baseURL:string; authorize:(context:PolicyContext)=>boolean|Promise<boolean>; headers?:Record<string,string>};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);

/** Bind one OpenAPI 3.x GET operation to a trusted, fixed base URL. */
export function createOpenAPIGetBinding(document:unknown, operationId:string, options:Options):{candidate:CapabilityCandidate;binding:{authorize:Options['authorize'];validate:(input:unknown)=>boolean;execute:(input:unknown)=>Promise<unknown>}} {
  if(!options || typeof options.authorize!=='function') throw Error('Authorization policy is required');
  const candidates=importOpenAPI(document),candidate=candidates.find(c=>c.operationId===operationId);
  if(!candidate || candidate.method!=='GET') throw Error('GET operation not found');
  let base:URL;try{base=new URL(options.baseURL);}catch{throw Error('Invalid base URL');}
  if(base.username||base.password||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','localhost'].includes(base.hostname)))) throw Error('Untrusted base URL');
  if(!/^\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9_-]+\})(?:\/(?:[A-Za-z0-9._~-]+|\{[A-Za-z0-9_-]+\}))*\/?$/.test(candidate.path) || candidate.path.split('/').some(part=>part==='.'||part==='..')) throw Error('Unsupported operation path');
  const root=document as Record<string,unknown>, paths=root.paths as Record<string,unknown>, pathItem=paths[candidate.path] as Record<string,unknown>, operation=pathItem.get as Record<string,unknown>;
  if(operation.requestBody!==undefined) throw Error('GET request bodies are unsupported');
  const all=[...(Array.isArray(pathItem.parameters)?pathItem.parameters:[]),...(Array.isArray(operation.parameters)?operation.parameters:[])];
  if((pathItem.parameters!==undefined&&!Array.isArray(pathItem.parameters))||(operation.parameters!==undefined&&!Array.isArray(operation.parameters))||all.length>50) throw Error('Invalid parameters');
  const params:Parameter[]=[],seen=new Set<string>();
  for(const item of all){
    if(!object(item)||'$ref' in item||typeof item.name!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.name)||!['path','query'].includes(item.in as string)||!object(item.schema)) throw Error('Unsupported parameter');
    const loc=item.in as 'path'|'query',schema=item.schema;
    if(item.style!==undefined && item.style!==(loc==='path'?'simple':'form')) throw Error('Unsupported parameter style');
    if(item.explode!==undefined && item.explode!==(loc==='query')) throw Error('Unsupported parameter encoding');
    if(!['string','integer','number','boolean'].includes(schema.type as string) || Object.keys(schema).some(key=>!['type','minimum','maximum','minLength','maxLength','description'].includes(key))) throw Error('Unsupported parameter schema');
    if(item.required!==undefined && typeof item.required!=='boolean') throw Error('Invalid parameter');
    if(loc==='path' && item.required!==true) throw Error('Path parameters must be required');
    const key=loc+':'+item.name;if(seen.has(key))throw Error('Duplicate parameter');seen.add(key);
    const p:Parameter={name:item.name,location:loc,required:item.required===true,type:schema.type as Parameter['type']};
    for(const field of ['minimum','maximum','minLength','maxLength'] as const){if(schema[field]!==undefined){if(typeof schema[field]!=='number'||!Number.isFinite(schema[field])||((field==='minLength'||field==='maxLength')&&(!Number.isSafeInteger(schema[field])||schema[field]<0||schema[field]>2048)))throw Error('Invalid parameter constraint');p[field]=schema[field] as number;}}
    if((p.minLength!==undefined||p.maxLength!==undefined)&&p.type!=='string')throw Error('Invalid string constraint');
    if((p.minimum!==undefined||p.maximum!==undefined)&&!['integer','number'].includes(p.type))throw Error('Invalid numeric constraint');
    if((p.minLength??0)>(p.maxLength??2048)||(p.minimum??-Infinity)>(p.maximum??Infinity))throw Error('Invalid parameter constraint');
    params.push(p);
  }
  const placeholders=Array.from(candidate.path.matchAll(/\{([^}]+)\}/g),match=>match[1]);
  if(new Set(placeholders).size!==placeholders.length || placeholders.some(name=>!seen.has('path:'+name)) || params.some(p=>p.location==='path'&&!placeholders.includes(p.name))) throw Error('Path parameter mismatch');
  const headers=new Headers(options.headers);for(const name of ['host','content-length','connection'])if(headers.has(name))throw Error('Forbidden upstream header');
  function validate(input:unknown):boolean {
    if(!object(input)||Object.keys(input).some(key=>!['path','query'].includes(key)))return false;
    for(const loc of ['path','query'] as const){
      const values=input[loc];if(values!==undefined&&!object(values))return false;
      const entries=(values??{}) as Record<string,unknown>, allowed=params.filter(p=>p.location===loc);
      if(Object.keys(entries).some(key=>!allowed.some(p=>p.name===key)))return false;
      for(const p of allowed){
        const present=Object.hasOwn(entries,p.name),value=entries[p.name];if(!present){if(p.required)return false;continue;}
        if(p.type==='string'){if(typeof value!=='string'||value.length<(p.minLength??0)||value.length>(p.maxLength??2048)||(loc==='path'&&!/^[A-Za-z0-9_-]{1,128}$/.test(value)))return false;}
        else if(p.type==='boolean'){if(typeof value!=='boolean')return false;}
        else if(typeof value!=='number'||!Number.isFinite(value)||(p.type==='integer'&&!Number.isSafeInteger(value))||value<(p.minimum??-Infinity)||value>(p.maximum??Infinity))return false;
      }
    }
    return true;
  }
  return {candidate,binding:{authorize:options.authorize,validate,async execute(raw){
    if(!validate(raw))throw Error('Invalid capability input');
    const input=raw as Input,target=new URL(base.href);
    const path=candidate.path.replace(/\{([^}]+)\}/g,(_match,name:string)=>encodeURIComponent(String(input.path![name])));
    target.pathname=base.pathname.replace(/\/$/,'')+path;
    for(const p of params.filter(p=>p.location==='query'))if(input.query && Object.hasOwn(input.query,p.name))target.searchParams.set(p.name,String(input.query[p.name]));
    const response=await fetch(target,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok||!response.body||!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw Error('Upstream request failed');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw Error('Upstream response too large');chunks.push(value);}}finally{await reader.cancel();}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw Error('Invalid upstream JSON');}
  }}};
}
