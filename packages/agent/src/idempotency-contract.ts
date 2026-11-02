import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setMaxListeners} from 'node:events';

export type IdempotencyContractOptions={
 /** Perform the operation against a non-production target, passing the key exactly as the journal would. */
 dispatch:(input:Record<string,unknown>,idempotencyKey:string,signal:AbortSignal)=>Promise<unknown>;
 /** Return how many effects the target applied for a key, from an independent read. */
 countEffects:(idempotencyKey:string,signal:AbortSignal)=>Promise<number>;
 input:Record<string,unknown>;
 /** A different, otherwise valid input used to check that a reused key is not accepted for new content. */
 conflictingInput:Record<string,unknown>;
 concurrency?:number;
 /** Optional deadline for the complete check and caller cancellation. */
 timeoutMs?:number;
 signal?:AbortSignal;
 newKey?:()=>string;
};
export type IdempotencyContractFinding={check:'sequential-replay'|'concurrent-replay'|'conflicting-input'|'fresh-key';problem:string};
export type IdempotencyContractReport={passed:boolean;findings:IdempotencyContractFinding[];keys:{replay:string;concurrent:string;fresh:string}};

const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
class UncloneableContractResult extends Error {constructor(cause:unknown){super('Provider result cannot be copied',{cause});}}

export class IdempotencyContractInterruptedError extends Error {
 readonly keys:IdempotencyContractReport['keys'];
 constructor(reason:'timeout'|'cancelled',keys:IdempotencyContractReport['keys']){super(reason==='timeout'?'Idempotency contract timed out':'Idempotency contract cancelled');this.name='IdempotencyContractInterruptedError';this.keys={...keys};}
}

/** A conformance check stopped after work may have reached the target. */
export class IdempotencyContractExecutionError extends Error {
 readonly keys:IdempotencyContractReport['keys'];
 constructor(keys:IdempotencyContractReport['keys'],cause:unknown){super(cause instanceof Error?cause.message:'Idempotency contract execution failed',{cause});this.name='IdempotencyContractExecutionError';this.keys={...keys};}
}

/** Exercise a downstream operation's idempotency-key handling. This is a host-run conformance check, not proof of production behavior. */
export async function checkIdempotencyContract(options:IdempotencyContractOptions):Promise<IdempotencyContractReport>{
 const concurrency=options?.concurrency??5;
 if(!options||typeof options.dispatch!=='function'||typeof options.countEffects!=='function'||!record(options.input)||!record(options.conflictingInput)||isDeepStrictEqual(options.input,options.conflictingInput)||!Number.isSafeInteger(concurrency)||concurrency<2||concurrency>50||(options.newKey!==undefined&&typeof options.newKey!=='function')||(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>300000))||(options.signal!==undefined&&!(options.signal instanceof AbortSignal)))throw Error('Invalid idempotency contract configuration');
 let fixedInput:Record<string,unknown>,fixedConflict:Record<string,unknown>;try{fixedInput=structuredClone(options.input);fixedConflict=structuredClone(options.conflictingInput);}catch{throw Error('Invalid idempotency contract configuration');}const hostDispatch=options.dispatch.bind(options),hostCountEffects=options.countEffects.bind(options),newKey=options.newKey??randomUUID,timeoutMs=options.timeoutMs,callerSignal=options.signal,keys={replay:newKey(),concurrent:newKey(),fresh:newKey()};
 if(new Set(Object.values(keys)).size!==3||Object.values(keys).some(key=>typeof key!=='string'||!key))throw Error('Invalid idempotency contract keys');
 const controller=new AbortController();setMaxListeners(0,controller.signal);let reason:'timeout'|'cancelled'='cancelled';
 const cancel=()=>{if(!controller.signal.aborted){reason='cancelled';controller.abort();}};if(callerSignal?.aborted)cancel();else callerSignal?.addEventListener('abort',cancel,{once:true});
 const timer=timeoutMs===undefined?undefined:setTimeout(()=>{if(!controller.signal.aborted){reason='timeout';controller.abort();}},timeoutMs);
 const interrupted=()=>new IdempotencyContractInterruptedError(reason,keys);
 const invoke=async<T>(work:()=>Promise<T>):Promise<T>=>{if(controller.signal.aborted)throw interrupted();let onAbort:()=>void=()=>{};const stopped=new Promise<never>((_,reject)=>{onAbort=()=>reject(interrupted());controller.signal.addEventListener('abort',onAbort,{once:true});});try{return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw interrupted();return work();}),stopped]);}finally{controller.signal.removeEventListener('abort',onAbort);}};
 const dispatch=(input:Record<string,unknown>,key:string)=>invoke(async()=>{const result=await hostDispatch(input,key,controller.signal);if(controller.signal.aborted)throw interrupted();try{return structuredClone(result);}catch(error){throw new UncloneableContractResult(error);}});
 const countEffects=(key:string)=>invoke(()=>hostCountEffects(key,controller.signal));
 const settle=async(work:()=>Promise<unknown>)=>{try{return {ok:true as const,value:await work()};}catch(error){if(error instanceof IdempotencyContractInterruptedError||error instanceof UncloneableContractResult)throw error;return {ok:false as const,error};}};
 try {
 const findings:IdempotencyContractFinding[]=[],input=()=>structuredClone(fixedInput);
 const effects=async(key:string)=>{const count=await countEffects(key);if(!Number.isSafeInteger(count)||count<0)throw Error('Invalid effect count');return count;};

 const first=await dispatch(input(),keys.replay),second=await settle(()=>dispatch(input(),keys.replay));
 if(!second.ok)findings.push({check:'sequential-replay',problem:'replay with the same key and input failed'});
 else if(!isDeepStrictEqual(second.value,first))findings.push({check:'sequential-replay',problem:'replay returned a different result'});
 const replayed=await effects(keys.replay);if(replayed!==1)findings.push({check:'sequential-replay',problem:`expected 1 effect, observed ${replayed}`});

 const parallel=await Promise.all(Array.from({length:concurrency},()=>settle(()=>dispatch(input(),keys.concurrent))));
 const succeeded=parallel.filter(result=>result.ok) as {ok:true;value:unknown}[];
 if(!succeeded.length)findings.push({check:'concurrent-replay',problem:'every concurrent attempt failed'});
 let different=succeeded.length>0&&succeeded.some(result=>!isDeepStrictEqual(result.value,succeeded[0].value));const replay=await settle(()=>dispatch(input(),keys.concurrent));if(!replay.ok)findings.push({check:'concurrent-replay',problem:'replay after concurrent attempts failed'});else if(succeeded.length&&!isDeepStrictEqual(replay.value,succeeded[0].value))different=true;
 if(different)findings.push({check:'concurrent-replay',problem:'concurrent attempts or their replay returned different results'});
 const concurrent=await effects(keys.concurrent);if(concurrent!==1)findings.push({check:'concurrent-replay',problem:`expected 1 effect, observed ${concurrent}`});

 const conflict=await settle(()=>dispatch(structuredClone(fixedConflict),keys.replay));
 if(conflict.ok)findings.push({check:'conflicting-input',problem:isDeepStrictEqual(conflict.value,first)?'a reused key with different input returned the original result instead of an error':'a reused key was accepted for different input'});
 const afterConflict=await effects(keys.replay);if(afterConflict!==1)findings.push({check:'conflicting-input',problem:`expected 1 effect after reuse, observed ${afterConflict}`});

 await dispatch(input(),keys.fresh);const fresh=await effects(keys.fresh);if(fresh!==1)findings.push({check:'fresh-key',problem:`expected 1 effect for a new key, observed ${fresh}`});
 return {passed:findings.length===0,findings,keys};
 } catch(error) {if(error instanceof IdempotencyContractInterruptedError)throw error;if(!controller.signal.aborted)controller.abort();throw new IdempotencyContractExecutionError(keys,error instanceof UncloneableContractResult?error.cause:error);
 } finally {if(timer!==undefined)clearTimeout(timer);callerSignal?.removeEventListener('abort',cancel);}
}
