/** Bounded asynchronous host work; a timed-out operation keeps its slot until it settles. */
export function createBoundedOperation(timeoutMs:number|undefined,maxPending:number|undefined,invalidMessage:string,unavailableMessage:string):<T>(operation:(signal:AbortSignal)=>Promise<T>)=>Promise<T>{
 if((timeoutMs===undefined)!==(maxPending===undefined)||(timeoutMs!==undefined&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000))||(maxPending!==undefined&&(!Number.isSafeInteger(maxPending)||maxPending<1||maxPending>100)))throw Error(invalidMessage);
 let pending=0;return async <T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const controller=new AbortController();if(timeoutMs===undefined)return operation(controller.signal);if(pending>=maxPending!)throw Error(unavailableMessage);pending++;
  const task=Promise.resolve().then(()=>operation(controller.signal));void task.then(()=>{pending--;},()=>{pending--;});let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error(unavailableMessage));},timeoutMs);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
 };
}
