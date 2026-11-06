// Condition polling for tests: wait until `condition()` (sync or async) is truthy, with a real deadline and a message
// that names what was awaited. Prefer this to a fixed sleep, which is either too short on a slow runner or wastes time.
export async function waitFor(condition,{timeoutMs=5000,intervalMs=10,message='condition'}={}){
 const deadline=Date.now()+timeoutMs;let lastError;
 for(;;){
  try{const value=await condition();if(value)return value;lastError=undefined;}catch(error){lastError=error;}
  if(Date.now()>=deadline)throw new Error(`Timed out after ${timeoutMs} ms waiting for ${message}`,lastError===undefined?undefined:{cause:lastError});
  await new Promise(resolve=>setTimeout(resolve,intervalMs));
 }
}
