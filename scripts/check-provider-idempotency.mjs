#!/usr/bin/env node
// Runs the idempotency conformance check against one HTTP provider's NON-PRODUCTION target.
//   node scripts/check-provider-idempotency.mjs <config.json>
// Needs `npm run build`. Credentials come from the environment, never from the config file:
//   PROVIDER_HEADERS='{"authorization":"Bearer ..."}'   (a JSON object of request headers)
// Config (JSON):
//   {
//     "environment": "sandbox",                               // must not be "production"
//     "dispatch": {"url": "https://sandbox.example/charges", "method": "POST", "idempotencyHeader": "Idempotency-Key"},
//     "countEffects": {"url": "https://sandbox.example/charges?key={key}", "path": "data.length"},   // an independent read; {key} is URL-encoded
//     "input": {"amount": 100, "currency": "USD"},
//     "conflictingInput": {"amount": 250, "currency": "USD"},
//     "concurrency": 5,
//     "allowHttp": false                                      // true only for a local emulator on 127.0.0.1 or localhost
//   }
// `path` names the number of effects in the read's JSON response: a dotted path to a number, or to an array whose length is used.
// Exit status 0 means every check passed, 1 means a finding or an error. The report is printed as JSON. A pass shows this provider
// honours idempotency keys on this target at this time; it is not proof of production behaviour.
import {readFileSync} from 'node:fs';
import {checkIdempotencyContract} from '../packages/agent/dist/index.js';

function pick(value,path){
 let current=value;for(const part of path.split('.')){if(current===null||typeof current!=='object'||!(part in current))throw Error(`The effects read has nothing at "${path}"`);current=current[part];}
 const count=Array.isArray(current)?current.length:current;
 if(!Number.isSafeInteger(count)||count<0)throw Error(`The effects read at "${path}" is not a count or an array`);return count;
}
function checkedUrl(text,allowHttp,what){
 let url;try{url=new URL(text);}catch{throw Error(`${what} is not a URL`);}
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(allowHttp&&local&&url.protocol==='http:'))throw Error(`${what} must use https (http is allowed only for 127.0.0.1 or localhost with allowHttp)`);
 if(url.username||url.password)throw Error(`${what} must not contain credentials`);return url;
}
export async function check(config,env=process.env,fetcher=fetch){
 if(!config||typeof config!=='object'||!config.dispatch||!config.countEffects)throw Error('The config needs dispatch and countEffects');
 if(String(config.environment??'').toLowerCase()==='production'||!config.environment)throw Error('Set "environment" to the non-production target being checked (not "production")');
 const allowHttp=config.allowHttp===true,header=config.dispatch.idempotencyHeader??'Idempotency-Key',method=String(config.dispatch.method??'POST').toUpperCase();
 if(!['POST','PUT','PATCH'].includes(method))throw Error('dispatch.method must be POST, PUT or PATCH');
 if(typeof header!=='string'||!/^[A-Za-z0-9-]{1,64}$/.test(header))throw Error('dispatch.idempotencyHeader is not a valid header name');
 const dispatchUrl=checkedUrl(config.dispatch.url,allowHttp,'dispatch.url');if(typeof config.countEffects.url!=='string'||!config.countEffects.url.includes('{key}'))throw Error('countEffects.url must contain {key}');
 checkedUrl(config.countEffects.url.replace('{key}','x'),allowHttp,'countEffects.url');if(typeof config.countEffects.path!=='string'||!config.countEffects.path)throw Error('countEffects.path is required');
 let extra={};if(env.PROVIDER_HEADERS){try{extra=JSON.parse(env.PROVIDER_HEADERS);}catch{throw Error('PROVIDER_HEADERS must be a JSON object');}if(!extra||typeof extra!=='object'||Array.isArray(extra)||Object.values(extra).some(value=>typeof value!=='string'))throw Error('PROVIDER_HEADERS must be a JSON object of strings');}
 const timeout=()=>AbortSignal.timeout(20000);
 return checkIdempotencyContract({
  input:config.input,conflictingInput:config.conflictingInput,...(config.concurrency!==undefined?{concurrency:config.concurrency}:{}),
  async dispatch(input,key){
   const response=await fetcher(dispatchUrl,{method,redirect:'error',signal:timeout(),headers:{...extra,'content-type':'application/json',[header]:key},body:JSON.stringify(input)});
   if(!response.ok)throw Error(`The provider answered ${response.status}`);
   const text=await response.text();try{return JSON.parse(text);}catch{return text;}
  },
  async countEffects(key){
   const response=await fetcher(config.countEffects.url.replace('{key}',encodeURIComponent(key)),{method:'GET',redirect:'error',signal:timeout(),headers:{...extra}});
   if(!response.ok)throw Error(`The effects read answered ${response.status}`);return pick(await response.json(),config.countEffects.path);
  }
 });
}
if(process.argv[1]?.endsWith('check-provider-idempotency.mjs')){
 try{
  const file=process.argv[2];if(!file)throw Error('Usage: check-provider-idempotency.mjs <config.json>');
  const report=await check(JSON.parse(readFileSync(file,'utf8')));console.log(JSON.stringify(report,null,1));process.exitCode=report.passed?0:1;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
