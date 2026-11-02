import {EncryptedBrowserQueue,BrowserOfflineWorker,mountOfflineConflictPanel} from './offline.js';
import {invokeCapability} from './capabilities.mjs';

// Trusted host code supplies an unlocked key, current identity and authorized transport.
export async function createGeneratedOfflineRuntime(config){
  if(!config||config.enabled!==true||!Array.isArray(config.operations)||!config.operations.length||config.operations.length>100||typeof config.canEnqueue!=='function'||typeof config.canDiscard!=='function'||typeof config.isOnline!=='function'||typeof config.resolveActor!=='function'||typeof config.dispatch!=='function'||typeof config.classify!=='function'||typeof config.onError!=='function'||typeof config.loadCurrent!=='function')throw Error('Invalid offline runtime configuration');
  const pattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,operations=new Map();
  for(const operation of config.operations){
    if(!operation||typeof operation.id!=='string'||!pattern.test(operation.id)||typeof operation.label!=='string'||!operation.label.trim()||operation.label.length>120||operations.has(operation.id))throw Error('Invalid offline operation');
    operations.set(operation.id,operation.label);
  }
  const {canEnqueue,canDiscard,isOnline,resolveActor,dispatch,classify,onError,loadCurrent}=config;
  const scope={tenantId:config.scope?.tenantId,applicationId:config.scope?.applicationId,principalId:config.scope?.principalId};
  const queue=await EncryptedBrowserQueue.open({enabled:true,databaseName:config.databaseName,scope,key:config.key,...(config.indexedDB?{indexedDB:config.indexedDB}:{}),...(config.crypto?{crypto:config.crypto}:{})});
  let closed=false,closePromise;const panels=new Set();
  class OperationNotAllowed extends Error {}
  const current=async()=>{const actor=await resolveActor();return !!actor&&actor.tenantId===scope.tenantId&&actor.applicationId===scope.applicationId&&actor.principalId===scope.principalId;};
  let worker;
  try{
    worker=new BrowserOfflineWorker(queue,{
      intervalMs:config.intervalMs,maxPerPass:config.maxPerPass,maxAttempts:config.maxAttempts,isOnline,resolveActor,
      dispatch:(operation,input,actor)=>{if(!operations.has(operation))throw new OperationNotAllowed('Offline operation not allowed');return dispatch(operation,input,actor);},
      classify:error=>error instanceof OperationNotAllowed?'uncertain':classify(error),onError
    });
  }catch(error){queue.close();throw error;}
  const ensureOpen=()=>{if(closed)throw Error('Offline runtime closed');};
  const runtime={
    async enqueue(operationId,requestKey,payload,options){
      const safe=structuredClone(payload),keyOptions=options===undefined?undefined:structuredClone(options);
      ensureOpen();if(!operations.has(operationId)||!await current())throw Error('Offline operation not allowed');
      if(await canEnqueue(operationId,structuredClone(safe),{...scope})!==true||!await current()||closed)throw Error('Offline operation not allowed');
      return queue.enqueue(operationId,requestKey,safe,keyOptions);
    },
    mountConflicts(root){
      ensureOpen();const panel=mountOfflineConflictPanel(root,queue,{
        authorizeRead:async()=>!closed&&await current(),
        loadCurrent:async(operation,payload,actor)=>{
          if(!operations.has(operation)||!await current())throw Error('Offline operation not allowed');
          const result=await loadCurrent(operation,payload,actor);if(!await current()||closed)throw Error('Offline operation not allowed');return result;
        },
        authorizeMutation:async(action,item,payload)=>{
          if(closed||!await current())return false;
          const allowed=action==='resolve'?operations.has(item.operationId)&&await canEnqueue(item.operationId,structuredClone(payload),{...scope})===true:await canDiscard(structuredClone(item),{...scope})===true;
          return allowed&&!closed&&await current();
        }
      });
      const guarded={async refresh(){if(closed||!await current())throw Error('Offline operation not allowed');await panel.refresh();if(closed||!await current()){panel.dispose();throw Error('Offline operation not allowed');}},dispose(){panel.dispose();panels.delete(guarded);}};
      panels.add(guarded);return guarded;
    },
    mountHistory(root,options){
      ensureOpen();const panel=mountGeneratedOfflineHistory(root,runtime,options);
      const guarded={refresh:()=>panel.refresh(),dispose(){panel.dispose();panels.delete(guarded);}};
      panels.add(guarded);return guarded;
    },
    start(){ensureOpen();worker.start();},
    async stop(){await worker.stop();},
    close(){if(closePromise)return closePromise;closed=true;for(const panel of panels)panel.dispose();closePromise=(async()=>{await worker.stop();queue.close();})();return closePromise;},
    async list(){ensureOpen();if(!await current())throw Error('Offline operation not allowed');const result=await queue.list();if(closed||!await current())throw Error('Offline operation not allowed');return result;},
    operations(){return [...operations].map(([id,label])=>({id,label}));}
  };
  return runtime;
}

// Read-only recovery view; host identity and authorization are checked by runtime.list().
export function mountGeneratedOfflineHistory(root,runtime,options={}){
  if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||typeof runtime?.list!=='function'||!options||typeof options!=='object'||(options.onRecover!==undefined&&typeof options.onRecover!=='function'))throw Error('Invalid offline history');
  const doc=root.ownerDocument;let generation=0,disposed=false;
  const node=(tag,text)=>{const result=doc.createElement(tag);if(text!==undefined)result.textContent=text;return result;};
  return {
    async refresh(){
      if(disposed)return;const current=++generation,heading=node('h2','Offline operation history'),status=node('p','Loading operations…'),list=node('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.replaceChildren(heading,status,list);
      try{
        const items=await runtime.list();if(disposed||current!==generation)return;
        if(!items.length){status.textContent='No offline operations.';return;}
        status.textContent='Review saved operations before creating another request.';
        for(const item of items){const section=node('section'),details=node('details'),summary=node('summary','Show queued data');details.append(summary,node('pre',JSON.stringify(item.payload,null,2)));section.append(node('h3',item.operationId+' — '+item.status),node('p','Operation ID: '+item.id),details);if(options.onRecover){const recover=node('button','Use request in form');recover.type='button';recover.addEventListener('click',()=>{recover.disabled=true;void (async()=>{try{await options.onRecover(item.id);if(!disposed&&current===generation)status.textContent='Request loaded into the form. Review it before submitting.';}catch{if(!disposed&&current===generation)status.textContent='Unable to load the request into the form.';}finally{if(!disposed&&current===generation)recover.disabled=false;}})();});section.appendChild(recover);}list.appendChild(section);}
      }catch{if(!disposed&&current===generation)status.textContent='Unable to load offline operations.';}
    },
    dispose(){disposed=true;generation++;root.replaceChildren();}
  };
}

// Optional host-owned cross-session request identities; this store contains no payload.
export async function createPersistentOfflineRequestKeys({databaseName,scope,indexedDB=globalThis.indexedDB,crypto=globalThis.crypto}={}){
  const valid=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
  if(!valid(databaseName)||!scope||!valid(scope.tenantId)||!valid(scope.applicationId)||!valid(scope.principalId)||!indexedDB||!crypto?.subtle||typeof crypto.randomUUID!=='function')throw Error('Invalid persistent request configuration');
  const identity=[scope.tenantId,scope.applicationId,scope.principalId],enc=new TextEncoder(),uuid=/^[0-9a-f-]{36}$/;
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(databaseName,1);let blocked=false;request.onupgradeneeded=()=>request.result.createObjectStore('request-identities',{keyPath:'id'});request.onblocked=()=>{blocked=true;reject(Error('Request identity database blocked'));};request.onerror=()=>reject(request.error??Error('Request identity database unavailable'));request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};});
  let closed=false;db.onversionchange=()=>{closed=true;db.close();};
  const slotId=async slot=>{if(!valid(slot))throw Error('Invalid request identity slot');return hash(JSON.stringify([...identity,slot]));};
  const read=id=>new Promise((resolve,reject)=>{if(closed){reject(Error('Request identity store closed'));return;}const tx=db.transaction('request-identities','readonly'),request=tx.objectStore('request-identities').get(id);let value;request.onsuccess=()=>{value=request.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error??Error('Request identity read failed'));});
  const mutate=(id,action)=>new Promise((resolve,reject)=>{if(closed){reject(Error('Request identity store closed'));return;}const tx=db.transaction('request-identities','readwrite'),store=tx.objectStore('request-identities'),request=store.get(id);let result;request.onsuccess=()=>{try{result=action(store,request.result);}catch(error){tx.abort();reject(error);}};tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(tx.error??Error('Request identity write failed'));});
  const digest=(salt,operation,payload)=>hash(JSON.stringify([salt,operation,payload]));
  const check=value=>{if(value!==undefined&&(!value||Object.keys(value).sort().join(',')!=='digest,id,key,salt'||!uuid.test(value.key)||!uuid.test(value.salt)||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||typeof value.id!=='string'||!/^[a-f0-9]{64}$/.test(value.id)))throw Error('Invalid stored request identity');};
  return {
    async getOrCreate(slot,operation,payload){
      if(!valid(operation)||!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid offline request');const id=await slotId(slot),serialized=JSON.stringify(payload),fixed=JSON.parse(serialized);
      for(let i=0;i<30;i++){
        const previous=await read(id);check(previous);if(previous&&previous.id!==id)throw Error('Invalid stored request identity');
        const matches=previous&&previous.digest===await digest(previous.salt,operation,fixed);const salt=matches?previous.salt:crypto.randomUUID(),candidate=matches?previous:{id,key:crypto.randomUUID(),salt,digest:await digest(salt,operation,fixed)};
        const result=await mutate(id,(store,current)=>{check(current);if(JSON.stringify(current)!==JSON.stringify(previous))return false;if(!matches)store.put(candidate);return true;});if(result)return candidate.key;
      }
      throw Error('Request identity changed concurrently');
    },
    async reset(slot){const id=await slotId(slot);await mutate(id,store=>{store.delete(id);});},
    async restore(slot,operation,payload,key){if(!valid(operation)||!uuid.test(key)||!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid offline request');const id=await slotId(slot),salt=crypto.randomUUID(),value={id,key,salt,digest:await digest(salt,operation,JSON.parse(JSON.stringify(payload)))};await mutate(id,store=>{store.put(value);});},
    close(){closed=true;db.close();}
  };
}

// Shared slots require an authenticated capability and a dedicated local generation store.
export async function createSharedOfflineIdentityStore({databaseName,scope,operations,invoke,resolveActor,indexedDB=globalThis.indexedDB,crypto=globalThis.crypto}={}){
  const valid=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value),cap=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if(!valid(databaseName)||!scope||!valid(scope.tenantId)||!valid(scope.applicationId)||!valid(scope.principalId)||!Array.isArray(operations)||!operations.length||operations.length>100||typeof invoke!=='function'||typeof resolveActor!=='function'||!indexedDB||!crypto?.subtle)throw Error('Invalid shared identity configuration');
  const identity={tenantId:scope.tenantId,applicationId:scope.applicationId,principalId:scope.principalId},mapping=new Map();for(const item of operations){if(!item||typeof item.id!=='string'||!cap.test(item.id)||typeof item.slotCapability!=='string'||!cap.test(item.slotCapability)||mapping.has(item.id))throw Error('Invalid shared identity configuration');mapping.set(item.id,item.slotCapability);}
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(databaseName,1);let blocked=false;request.onupgradeneeded=()=>request.result.createObjectStore('shared-slots',{keyPath:'id'});request.onblocked=()=>{blocked=true;reject(Error('Shared identity database blocked'));};request.onerror=()=>reject(request.error??Error('Shared identity database unavailable'));request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};});let closed=false;db.onversionchange=()=>{closed=true;db.close();};
  const ensure=async()=>{if(closed)throw Error('Shared identity store closed');const actor=await resolveActor();if(closed||!actor||actor.tenantId!==identity.tenantId||actor.applicationId!==identity.applicationId||actor.principalId!==identity.principalId)throw Error('Shared identity unavailable');};
  const slotId=async slot=>{if(!valid(slot))throw Error('Invalid shared identity slot');const data=new TextEncoder().encode(JSON.stringify([identity.tenantId,identity.applicationId,identity.principalId,slot]));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),byte=>byte.toString(16).padStart(2,'0')).join('');};
  const check=(row,id)=>{if(row!==undefined&&(!row||Object.keys(row).sort().join(',')!=='id,requestKey'||row.id!==id||typeof row.requestKey!=='string'||!uuid.test(row.requestKey)))throw Error('Invalid stored shared identity');};
  const read=id=>new Promise((resolve,reject)=>{if(closed){reject(Error('Shared identity store closed'));return;}const tx=db.transaction('shared-slots','readonly'),request=tx.objectStore('shared-slots').get(id);let row;request.onsuccess=()=>{row=request.result;};tx.oncomplete=()=>{try{check(row,id);resolve(row?.requestKey);}catch(error){reject(error);}};tx.onerror=tx.onabort=()=>reject(tx.error??Error('Shared identity read failed'));});
  const compare=(id,expected,next)=>new Promise((resolve,reject)=>{if(closed){reject(Error('Shared identity store closed'));return;}const tx=db.transaction('shared-slots','readwrite'),store=tx.objectStore('shared-slots'),request=store.get(id);let changed=false;request.onsuccess=()=>{try{const row=request.result;check(row,id);if(row?.requestKey===expected){store.put({id,requestKey:next});changed=true;}}catch(error){tx.abort();reject(error);}};tx.oncomplete=()=>resolve(changed);tx.onerror=tx.onabort=()=>reject(tx.error??Error('Shared identity write failed'));});
  const capability=operation=>{const value=mapping.get(operation);if(!value)throw Error('Shared identity operation unavailable');return value;};
  const call=async(operation,input)=>{await ensure();const result=await invoke(capability(operation),structuredClone(input));await ensure();return result;};
  const open=async(slot,operation)=>{const result=await call(operation,{action:'open',slot});if(!result||Object.keys(result).join(',')!=='requestKey'||typeof result.requestKey!=='string'||!uuid.test(result.requestKey))throw Error('Invalid shared identity response');return result.requestKey;};
  const current=async(slot,operation,id)=>{let value=await read(id);await ensure();if(value!==undefined)return value;const remote=await open(slot,operation);if(await compare(id,undefined,remote))return remote;value=await read(id);if(value===undefined)throw Error('Shared identity changed concurrently');return value;};
  const copyPayload=payload=>{if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid offline request');return structuredClone(payload);};
  return {
    async getOrCreate(slot,operation,payload){const safe=copyPayload(payload),id=await slotId(slot);capability(operation);await ensure();const requestKey=await current(slot,operation,id),result=await call(operation,{action:'allocate',slot,expectedRequestKey:requestKey,payload:safe});if(!result||Object.keys(result).sort().join(',')!=='idempotencyKey,requestKey'||result.requestKey!==requestKey||typeof result.idempotencyKey!=='string'||!uuid.test(result.idempotencyKey))throw Error('Invalid shared identity response');return {requestKey,idempotencyKey:result.idempotencyKey};},
    async reset(slot,operation){const id=await slotId(slot);capability(operation);await ensure();const previous=await current(slot,operation,id),result=await call(operation,{action:'reset',slot,expectedRequestKey:previous});if(!result||Object.keys(result).join(',')!=='requestKey'||typeof result.requestKey!=='string'||!uuid.test(result.requestKey)||result.requestKey===previous)throw Error('Invalid shared identity response');if(!await compare(id,previous,result.requestKey))throw Error('Shared identity changed concurrently');await ensure();},
    async restore(slot,operation,payload,pair){const safe=copyPayload(payload);if(!pair||typeof pair!=='object'||!uuid.test(pair.requestKey)||!uuid.test(pair.idempotencyKey))throw Error('Invalid shared request identity');const selected={requestKey:pair.requestKey,idempotencyKey:pair.idempotencyKey},id=await slotId(slot);capability(operation);await ensure();const previous=await current(slot,operation,id),result=await call(operation,{action:'restore',slot,expectedRequestKey:previous,...selected,payload:safe});if(!result||Object.keys(result).join(',')!=='requestKey'||result.requestKey!==selected.requestKey)throw Error('Invalid shared identity response');if(!await compare(id,previous,selected.requestKey))throw Error('Shared identity changed concurrently');await ensure();},
    async adoptCurrent(slot,operation){const id=await slotId(slot);capability(operation);await ensure();const previous=await read(id),remote=await open(slot,operation);if(!await compare(id,previous,remote))throw Error('Shared identity changed concurrently');await ensure();return remote;},
    close(){closed=true;db.close();}
  };
}

// Explicit user action creates a durable intent. Hosts must not allowlist staged submission.
export function mountGeneratedOfflineForm(root,runtime,options={}){
  const identityValid=store=>!!store&&typeof store.getOrCreate==='function'&&typeof store.reset==='function'&&typeof store.restore==='function';
  if(!root?.ownerDocument||typeof runtime?.enqueue!=='function'||typeof runtime.operations!=='function'||!options||typeof options!=='object'||(options.storageKey!==undefined&&(typeof options.storageKey!=='string'||!options.storageKey.trim()||options.storageKey.length>200))||(options.identityStore!==undefined&&!identityValid(options.identityStore))||(options.sharedIdentityStore!==undefined&&!identityValid(options.sharedIdentityStore))||(options.identityStore!==undefined&&options.sharedIdentityStore!==undefined))throw Error('Invalid offline form');
  const identityStore=options.identityStore,sharedIdentityStore=options.sharedIdentityStore,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const doc=root.ownerDocument,form=doc.createElement('form'),label=doc.createElement('label'),select=doc.createElement('select'),dataLabel=doc.createElement('label'),data=doc.createElement('textarea'),button=doc.createElement('button'),reset=doc.createElement('button'),status=doc.createElement('p');
  label.textContent='Operation';for(const operation of runtime.operations()){const option=doc.createElement('option');option.value=operation.id;option.textContent=operation.label;select.appendChild(option);}label.appendChild(select);
  dataLabel.textContent='Operation data (JSON object)';data.value='{}';dataLabel.appendChild(data);button.type='submit';button.textContent='Queue operation';reset.type='button';reset.textContent='New operation';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  form.append(label,dataLabel,button,reset,status);root.replaceChildren(form);let busy=false,disposed=false;const storageKey='app-mixer-offline-form-v1:'+(options.storageKey??(root.id||'default'));
  reset.addEventListener('click',()=>{if(busy||disposed)return;busy=true;button.disabled=true;reset.disabled=true;void (async()=>{try{if(sharedIdentityStore)await sharedIdentityStore.reset(storageKey,select.value);else if(identityStore)await identityStore.reset(storageKey);else doc.defaultView.sessionStorage.removeItem(storageKey);if(!disposed)status.textContent='Ready to queue a new operation.';}catch{if(!disposed)status.textContent='Unable to create a new request ID. Your data is retained.';}finally{busy=false;if(!disposed){button.disabled=false;reset.disabled=false;}}})();});
  form.addEventListener('submit',event=>{event.preventDefault();void (async()=>{
    if(busy||disposed)return;let payload;try{payload=JSON.parse(data.value);if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid');}catch{status.textContent='Enter a valid JSON object.';return;}
    const operation=select.value;busy=true;button.disabled=true;reset.disabled=true;select.disabled=true;data.disabled=true;
    try{
      let requestKey,keyOptions;
      if(sharedIdentityStore){const pair=await sharedIdentityStore.getOrCreate(storageKey,operation,structuredClone(payload));if(!pair||typeof pair!=='object'||Array.isArray(pair)||Object.keys(pair).sort().join(',')!=='idempotencyKey,requestKey'||typeof pair.requestKey!=='string'||typeof pair.idempotencyKey!=='string'||!uuid.test(pair.requestKey)||!uuid.test(pair.idempotencyKey))throw Error('Invalid shared request identity');requestKey=pair.requestKey;keyOptions={idempotencyKey:pair.idempotencyKey};}
      else if(identityStore)requestKey=await identityStore.getOrCreate(storageKey,operation,payload);
      else {
      const crypt=doc.defaultView?.crypto,storage=doc.defaultView?.sessionStorage;if(!crypt||typeof crypt.randomUUID!=='function'||!crypt.subtle||!storage)throw Error('Secure request IDs are unavailable');
      const raw=storage.getItem(storageKey);let saved=raw===null?undefined:JSON.parse(raw);if(saved!==undefined&&(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).sort().join(',')!=='digest,key,salt,version'||saved.version!==1||typeof saved.key!=='string'||!/^[0-9a-f-]{36}$/.test(saved.key)||typeof saved.salt!=='string'||!/^[0-9a-f-]{36}$/.test(saved.salt)||typeof saved.digest!=='string'||!/^[0-9a-f]{64}$/.test(saved.digest)))throw Error('Invalid stored request ID');
      const digest=async salt=>Array.from(new Uint8Array(await crypt.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([salt,operation,payload])))),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!saved||saved.digest!==await digest(saved.salt)){const salt=crypt.randomUUID();saved={version:1,key:crypt.randomUUID(),salt,digest:await digest(salt)};storage.setItem(storageKey,JSON.stringify(saved));}
        requestKey=saved.key;
      }
      if(disposed)throw Error('Offline form disposed');const item=await runtime.enqueue(operation,requestKey,payload,keyOptions);if(!disposed)status.textContent='Operation '+item.status+'.';
    }
    catch(error){if(!disposed)status.textContent=error instanceof Error&&error.message==='Shared offline slot conflict'?'Shared request changed or conflicts. Review before proceeding.':'Unable to queue operation. Your data is retained.';}
    finally{busy=false;if(!disposed){button.disabled=false;reset.disabled=false;select.disabled=false;data.disabled=false;}}
  })();});
  return {
    async recover(id){
      if(disposed||busy||typeof runtime.list!=='function'||typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('Cannot recover offline request');
      busy=true;button.disabled=true;reset.disabled=true;select.disabled=true;data.disabled=true;
      try{
        const crypt=doc.defaultView?.crypto,storage=doc.defaultView?.sessionStorage;if(!crypt||typeof crypt.randomUUID!=='function'||!crypt.subtle||!storage)throw Error('Secure request IDs are unavailable');
        const item=(await runtime.list()).find(value=>value.id===id);if(disposed||!item||![...select.options].some(option=>option.value===item.operationId)||typeof item.requestKey!=='string'||!/^[0-9a-f-]{36}$/.test(item.requestKey))throw Error('Cannot recover offline request');
        const payload=JSON.stringify(item.payload,null,2),salt=crypt.randomUUID(),digest=Array.from(new Uint8Array(await crypt.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([salt,item.operationId,item.payload])))),byte=>byte.toString(16).padStart(2,'0')).join('');
        const latest=(await runtime.list()).find(value=>value.id===id);if(disposed||!latest||latest.version!==item.version)throw Error('Cannot recover offline request');if(sharedIdentityStore){if(!uuid.test(item.requestKey)||!uuid.test(item.idempotencyKey))throw Error('Cannot recover shared request');await sharedIdentityStore.restore(storageKey,item.operationId,structuredClone(item.payload),{requestKey:item.requestKey,idempotencyKey:item.idempotencyKey});}else if(identityStore)await identityStore.restore(storageKey,item.operationId,item.payload,item.requestKey);else storage.setItem(storageKey,JSON.stringify({version:1,key:item.requestKey,salt,digest}));if(disposed)throw Error('Cannot recover offline request');select.value=item.operationId;data.value=payload;status.textContent='Previous request loaded. Review before submitting.';
      }finally{busy=false;if(!disposed){button.disabled=false;reset.disabled=false;select.disabled=false;data.disabled=false;}}
    },
    dispose(){disposed=true;root.replaceChildren();}
  };
}

// Optional operator view; the capability server owns authentication and recovery policy.
export function mountOfflineRecovery(root,{listOperation,recoverOperation,verifyOperation,evidenceOperation}={}){
 const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
 if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||![listOperation,recoverOperation,verifyOperation,evidenceOperation].every(valid))throw Error('Invalid offline recovery view');
 const doc=root.ownerDocument,node=(tag,text)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;return element;},section=node('section'),heading=node('h2','Offline recovery'),status=node('p','Browse operations that may need recovery.'),list=node('ul'),browse=node('button','Browse operations'),next=node('button','Next operations page'),selection=node('p','No operation selected.'),lookupLabel=node('label','Operation ID for evidence'),lookup=node('input'),selectById=node('button','Select operation for evidence'),label=node('label','Evidence reference'),reference=node('input'),recover=node('button','Recover interrupted operation'),verify=node('button','Verify provider outcome'),showEvidence=node('button','View recovery evidence'),evidenceNext=node('button','Next evidence page'),evidenceList=node('ul');
 for(const button of [browse,next,selectById,recover,verify,showEvidence,evidenceNext])button.type='button';status.setAttribute('role','status');status.setAttribute('aria-live','polite');reference.maxLength=256;lookup.maxLength=256;lookupLabel.append(lookup);label.append(reference);section.append(heading,status,browse,next,list,selection,lookupLabel,selectById,label,recover,verify,showEvidence,evidenceNext,evidenceList);root.replaceChildren(section);
 let disposed=false,busy=false,generation=0,cursor,selected,evidenceCursor;
 const sync=()=>{browse.disabled=busy;next.disabled=busy||!cursor;lookup.disabled=busy;selectById.disabled=busy||!lookup.value.trim();reference.disabled=busy||!selected;recover.disabled=busy||!selected||selected.status!=='running'||!reference.value.trim();verify.disabled=busy||!selected||selected.status!=='uncertain'||!reference.value.trim();showEvidence.disabled=busy||!selected;evidenceNext.disabled=busy||!selected||evidenceCursor===undefined;for(const button of list.querySelectorAll('button'))button.disabled=busy;};
 const validId=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value);
 const clearSelection=()=>{selected=undefined;evidenceCursor=undefined;reference.value='';selection.textContent='No operation selected.';evidenceList.replaceChildren();};
 const run=async(task)=>{if(disposed||busy)return;busy=true;const active=++generation;sync();try{await task(()=>!disposed&&generation===active);}catch{if(!disposed&&generation===active){clearSelection();cursor=undefined;list.replaceChildren();status.textContent='Unable to complete the request. Refresh before trying again.';}}finally{if(!disposed&&generation===active){busy=false;sync();}}};
 const page=async(after,active)=>{const result=await invokeCapability(listOperation,{...(after?{after}:{}),limit:20});if(!active())return;if(!result||!Array.isArray(result.items)||result.items.length>20||(result.nextAfter!==undefined&&!validId(result.nextAfter)))throw Error('Invalid recovery listing');for(const item of result.items)if(!item||!validId(item.id)||!['running','uncertain'].includes(item.status)||!Number.isSafeInteger(item.attempts)||item.attempts<1)throw Error('Invalid recovery listing');cursor=result.nextAfter;clearSelection();list.replaceChildren();for(const item of result.items){const row=node('li'),button=node('button',item.id+' — '+item.status+' ('+item.attempts+' attempts)');button.type='button';button.addEventListener('click',()=>{if(busy||disposed)return;selected={id:item.id,status:item.status};lookup.value=item.id;reference.value='';selection.textContent='Selected '+item.id+' — '+item.status+'.';evidenceCursor=undefined;evidenceList.replaceChildren();sync();});row.append(button);list.append(row);}status.textContent=result.items.length?'Select an operation to review.':'No operations on this page.';};
 browse.addEventListener('click',()=>{void run(active=>page(undefined,active));});next.addEventListener('click',()=>{if(cursor)void run(active=>page(cursor,active));});reference.addEventListener('input',sync);lookup.addEventListener('input',()=>{clearSelection();sync();});
 selectById.addEventListener('click',()=>{if(busy||disposed||!validId(lookup.value))return;selected={id:lookup.value,status:'unknown'};reference.value='';selection.textContent='Selected '+lookup.value+' for evidence.';evidenceCursor=undefined;evidenceList.replaceChildren();status.textContent='View evidence for this operation.';sync();});
 const act=(operation,expected)=>{if(!selected||selected.status!==expected||!validId(reference.value))return;const chosen={...selected},proof=reference.value;void run(async active=>{const result=await invokeCapability(operation,{id:chosen.id,reference:proof});if(!active())return;if(!result||typeof result!=='object'||(expected==='running'?typeof result.recovered!=='boolean':!['applied','not_applied','unknown'].includes(result.outcome)))throw Error('Invalid recovery result');selected={id:chosen.id,status:expected==='running'?(result.recovered?'uncertain':'running'):(result.outcome==='applied'?'succeeded':result.outcome==='not_applied'?'pending':'uncertain')};reference.value='';selection.textContent='Selected '+chosen.id+' � '+selected.status+'.';evidenceCursor=undefined;evidenceList.replaceChildren();cursor=undefined;list.replaceChildren();status.textContent=expected==='running'?(result.recovered?'Interrupted operation marked uncertain.':'The submitter could not be confirmed stopped.'):'Verification result: '+result.outcome+'.';});};
 recover.addEventListener('click',()=>act(recoverOperation,'running'));verify.addEventListener('click',()=>act(verifyOperation,'uncertain'));
 const evidencePage=async(after,active)=>{const chosen=selected;if(!chosen)return;const result=await invokeCapability(evidenceOperation,{id:chosen.id,...(after===undefined?{}:{after}),limit:20});if(!active())return;if(!result||!Array.isArray(result.items)||result.items.length>20||(result.nextAfter!==undefined&&(!Number.isSafeInteger(result.nextAfter)||result.nextAfter<1)))throw Error('Invalid evidence listing');for(const item of result.items)if(!item||!validId(item.operatorId)||!validId(item.reference)||!['recover','applied','not_applied'].includes(item.action)||!Number.isSafeInteger(item.recordedAt)||item.recordedAt<0)throw Error('Invalid evidence listing');evidenceCursor=result.nextAfter;evidenceList.replaceChildren();for(const item of result.items)evidenceList.append(node('li',item.action+' — '+item.operatorId+' — '+item.reference+' — '+item.recordedAt));status.textContent=result.items.length?'Recovery evidence loaded.':'No recovery evidence on this page.';};
 showEvidence.addEventListener('click',()=>{void run(active=>evidencePage(undefined,active));});evidenceNext.addEventListener('click',()=>{if(evidenceCursor!==undefined)void run(active=>evidencePage(evidenceCursor,active));});sync();
 return {refresh(){return run(active=>page(undefined,active));},dispose(){if(disposed)return;disposed=true;generation++;root.replaceChildren();}};
}
