import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export type IdempotencyContractOptions={
 /** Perform the operation against a non-production target, passing the key exactly as the journal would. */
 dispatch:(input:Record<string,unknown>,idempotencyKey:string)=>Promise<unknown>;
 /** Return how many effects the target applied for a key, from an independent read. */
 countEffects:(idempotencyKey:string)=>Promise<number>;
 input:Record<string,unknown>;
 /** A different, otherwise valid input used to check that a reused key is not accepted for new content. */
 conflictingInput:Record<string,unknown>;
 concurrency?:number;
 newKey?:()=>string;
};
export type IdempotencyContractFinding={check:'sequential-replay'|'concurrent-replay'|'conflicting-input'|'fresh-key';problem:string};
export type IdempotencyContractReport={passed:boolean;findings:IdempotencyContractFinding[];keys:{replay:string;concurrent:string;fresh:string}};

const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const settle=async(work:()=>Promise<unknown>)=>{try{return {ok:true as const,value:await work()};}catch(error){return {ok:false as const,error};}};

/** Exercise a downstream operation's idempotency-key handling. This is a host-run conformance check, not proof of production behavior. */
export async function checkIdempotencyContract(options:IdempotencyContractOptions):Promise<IdempotencyContractReport>{
 const concurrency=options?.concurrency??5;
 if(!options||typeof options.dispatch!=='function'||typeof options.countEffects!=='function'||!record(options.input)||!record(options.conflictingInput)||isDeepStrictEqual(options.input,options.conflictingInput)||!Number.isSafeInteger(concurrency)||concurrency<2||concurrency>50||(options.newKey!==undefined&&typeof options.newKey!=='function'))throw Error('Invalid idempotency contract configuration');
 const newKey=options.newKey??randomUUID,keys={replay:newKey(),concurrent:newKey(),fresh:newKey()};
 if(new Set(Object.values(keys)).size!==3||Object.values(keys).some(key=>typeof key!=='string'||!key))throw Error('Invalid idempotency contract keys');
 const findings:IdempotencyContractFinding[]=[],input=()=>structuredClone(options.input);
 const effects=async(key:string)=>{const count=await options.countEffects(key);if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid effect count');return count;};

 const first=await options.dispatch(input(),keys.replay),second=await settle(()=>options.dispatch(input(),keys.replay));
 if(!second.ok)findings.push({check:'sequential-replay',problem:'replay with the same key and input failed'});
 else if(!isDeepStrictEqual(second.value,first))findings.push({check:'sequential-replay',problem:'replay returned a different result'});
 const replayed=await effects(keys.replay);if(replayed!==1)findings.push({check:'sequential-replay',problem:`expected 1 effect, observed ${replayed}`});

 const parallel=await Promise.all(Array.from({length:concurrency},()=>settle(()=>options.dispatch(input(),keys.concurrent))));
 const succeeded=parallel.filter(result=>result.ok) as {ok:true;value:unknown}[];
 if(!succeeded.length)findings.push({check:'concurrent-replay',problem:'every concurrent attempt failed'});
 else if(succeeded.some(result=>!isDeepStrictEqual(result.value,succeeded[0].value)))findings.push({check:'concurrent-replay',problem:'concurrent attempts returned different results'});
 const concurrent=await effects(keys.concurrent);if(concurrent!==1)findings.push({check:'concurrent-replay',problem:`expected 1 effect, observed ${concurrent}`});

 const conflict=await settle(()=>options.dispatch(structuredClone(options.conflictingInput),keys.replay));
 if(conflict.ok)findings.push({check:'conflicting-input',problem:isDeepStrictEqual(conflict.value,first)?'a reused key with different input returned the original result instead of an error':'a reused key was accepted for different input'});
 const afterConflict=await effects(keys.replay);if(afterConflict!==1)findings.push({check:'conflicting-input',problem:`expected 1 effect after reuse, observed ${afterConflict}`});

 await options.dispatch(input(),keys.fresh);const fresh=await effects(keys.fresh);if(fresh!==1)findings.push({check:'fresh-key',problem:`expected 1 effect for a new key, observed ${fresh}`});
 return {passed:findings.length===0,findings,keys};
}
