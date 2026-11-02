import {EncryptedBrowserQueue,BrowserOfflineWorker,mountOfflineConflictPanel} from './offline.js';
import {invokeCapability} from './capabilities.mjs';

// Trusted host code supplies an unlocked key, current identity and authorized transport.
export async function createGeneratedOfflineRuntime(config){
  if(!config||config.enabled!==true||!Array.isArray(config.operations)||!config.operations.length||config.operations.length>100||typeof config.canEnqueue!=='function'||typeof config.canDiscard!=='function'||(config.canRetire!==undefined&&typeof config.canRetire!=='function')||(config.confirmAbandoned!==undefined&&typeof config.confirmAbandoned!=='function')||(config.verifyOutcome!==undefined&&typeof config.verifyOutcome!=='function')||typeof config.isOnline!=='function'||typeof config.resolveActor!=='function'||typeof config.dispatch!=='function'||typeof config.classify!=='function'||typeof config.onError!=='function'||typeof config.loadCurrent!=='function')throw Error('Invalid offline runtime configuration');
  const pattern=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,operations=new Map();
  for(const operation of config.operations){
    if(!operation||typeof operation.id!=='string'||!pattern.test(operation.id)||typeof operation.label!=='string'||!operation.label.trim()||operation.label.length>120||operations.has(operation.id))throw Error('Invalid offline operation');
    operations.set(operation.id,operation.label);
  }
  const {canEnqueue,canDiscard,canRetire,confirmAbandoned,verifyOutcome,isOnline,resolveActor,dispatch,classify,onError,loadCurrent}=config;
  const scope={tenantId:config.scope?.tenantId,applicationId:config.scope?.applicationId,principalId:config.scope?.principalId};
  const queue=await EncryptedBrowserQueue.open({enabled:true,databaseName:config.databaseName,scope,key:config.key,...(config.indexedDB?{indexedDB:config.indexedDB}:{}),...(config.crypto?{crypto:config.crypto}:{}),...(config.rollbackAnchor!==undefined?{rollbackAnchor:config.rollbackAnchor}:{})});
  let closed=false,closePromise;const panels=new Set();
  class OperationNotAllowed extends Error {}
  const current=async()=>{if(closed)return false;const actor=await resolveActor();return !closed&&!!actor&&actor.tenantId===scope.tenantId&&actor.applicationId===scope.applicationId&&actor.principalId===scope.principalId;};
  let worker;
  try{
    worker=new BrowserOfflineWorker(queue,{
      intervalMs:config.intervalMs,maxPerPass:config.maxPerPass,maxAttempts:config.maxAttempts,isOnline,resolveActor,...(config.policyTimeoutMs!==undefined?{policyTimeoutMs:config.policyTimeoutMs}:{}),...(config.maxPendingPolicies!==undefined?{maxPendingPolicies:config.maxPendingPolicies}:{}),
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
    async retire(id,expectedVersion){
      ensureOpen();if(!canRetire||!await current())throw Error('Offline operation not allowed');
      const item=await queue.get(id);if(!item||!operations.has(item.operationId)||!['succeeded','discarded','retired'].includes(item.status)||closed||!await current())throw Error('Offline operation not allowed');
      if(await canRetire(structuredClone(item),{...scope})!==true||closed||!await current())throw Error('Offline operation not allowed');
      return queue.retire(id,expectedVersion);
    },
    async recoverAbandoned(id,expectedVersion){
      ensureOpen();if(!confirmAbandoned||!await current())throw Error('Offline operation not allowed');
      const item=await queue.get(id);if(!item||item.version!==expectedVersion||item.status!=='running'||!operations.has(item.operationId)||closed||!await current())throw Error('Offline operation not allowed');
      if(await confirmAbandoned(structuredClone(item),{...scope})!==true||closed||!await current())throw Error('Offline operation not allowed');
      return queue.transition(id,expectedVersion,'uncertain');
    },
    async verifyUncertain(id,expectedVersion){
      ensureOpen();if(!verifyOutcome||!await current())throw Error('Offline operation not allowed');
      const item=await queue.get(id);if(!item||item.version!==expectedVersion||item.status!=='uncertain'||!operations.has(item.operationId)||closed||!await current())throw Error('Offline operation not allowed');
      const outcome=await verifyOutcome(structuredClone(item),{...scope});if(closed||!await current())throw Error('Offline operation not allowed');
      if(outcome==='unknown'){const latest=await queue.get(id);if(closed||!await current()||!latest||latest.version!==expectedVersion||latest.status!=='uncertain')throw Error('Offline version conflict');return latest;}
      if(outcome!=='applied'&&outcome!=='not_applied')throw Error('Invalid offline verification outcome');
      return queue.transition(id,expectedVersion,outcome==='applied'?'reconcileApplied':'reconcileNotApplied');
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
    async hasPendingRollbackAnchor(){ensureOpen();if(!await current()||closed)throw Error('Offline operation not allowed');return queue.hasPendingRollbackAnchor();},
    async syncRollbackAnchor(){ensureOpen();if(!await current()||closed)throw Error('Offline operation not allowed');const result=await queue.syncRollbackAnchor();if(closed||!await current())throw Error('Offline operation not allowed');return result;},
    operations(){return [...operations].map(([id,label])=>({id,label}));}
  };
  return runtime;
}

// Host callbacks govern optional recovery and retirement actions.
export function mountGeneratedOfflineHistory(root,runtime,options={}){
  if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||typeof runtime?.list!=='function'||!options||typeof options!=='object'||['onRecover','onRetire','onAbandoned','onVerify'].some(name=>options[name]!==undefined&&typeof options[name]!=='function'))throw Error('Invalid offline history');
  const doc=root.ownerDocument,{onRecover,onRetire,onAbandoned,onVerify}=options;let generation=0,disposed=false,lastItems=[];
  const node=(tag,text)=>{const result=doc.createElement(tag);if(text!==undefined)result.textContent=text;return result;};
  const panel={
    async refresh(){
      if(disposed)return;lastItems=[];const current=++generation,heading=node('h2','Offline operation history'),status=node('p','Loading operations…'),list=node('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.replaceChildren(heading,status,list);
      try{
        const items=await runtime.list();if(disposed||current!==generation)return;lastItems=items;
        if(!items.length){status.textContent='No offline operations.';return true;}
        status.textContent='Review saved operations before creating another request.';
        for(const item of items){
          const section=node('section');section.append(node('h3',item.operationId+' — '+item.status),node('p','Operation ID: '+item.id));
          if(item.status==='retired')section.appendChild(node('p','Request data removed.'));else{const details=node('details'),summary=node('summary','Show queued data');details.append(summary,node('pre',JSON.stringify(item.payload,null,2)));section.appendChild(details);}
          const action=(label,callback,success,failure,refresh=false)=>{const button=node('button',label);button.type='button';button.addEventListener('click',()=>{if(disposed||current!==generation||!root.contains(button)||button.disabled)return;button.disabled=true;void (async()=>{try{await callback(item.id,item.version);if(!disposed&&current===generation){if(refresh){const loaded=await panel.refresh();if(loaded&&!disposed&&generation===current+1&&success){const message=root.querySelector('[role="status"]');if(message)message.textContent=typeof success==='function'?success(lastItems.find(value=>value.id===item.id)):success;}}else status.textContent=success;}}catch{if(!disposed&&current===generation)status.textContent=failure;}finally{if(!disposed&&current===generation)button.disabled=false;}})();});section.appendChild(button);};
          if(onRecover&&item.status!=='retired')action('Use request in form',onRecover,'Request loaded into the form. Review it before submitting.','Unable to load the request into the form.');
          if(onRetire&&['succeeded','discarded'].includes(item.status))action('Remove request data',onRetire,'','Could not confirm removal. Refresh history to check.',true);
          if(onAbandoned&&item.status==='running')action('Check interrupted operation',onAbandoned,'','Could not confirm recovery. Refresh history to check.',true);
          if(onVerify&&item.status==='uncertain')action('Verify operation outcome',onVerify,result=>result?.status==='uncertain'?'Outcome remains uncertain.':result?.status==='pending'?'Operation verified and ready to retry.':result?.status==='succeeded'?'Operation verified as completed.':'Verification finished. Review the current operation state.','Could not confirm verification. Refresh history to check.',true);
          list.appendChild(section);
        }
        return true;
      }catch{if(!disposed&&current===generation)status.textContent='Unable to load offline operations.';}
    },
    dispose(){disposed=true;generation++;lastItems=[];root.replaceChildren();}
  };
  return panel;
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
        const item=(await runtime.list()).find(value=>value.id===id);if(disposed||!item||item.status==='retired'||![...select.options].some(option=>option.value===item.operationId)||typeof item.requestKey!=='string'||!/^[0-9a-f-]{36}$/.test(item.requestKey))throw Error('Cannot recover offline request');
        const payload=JSON.stringify(item.payload,null,2),salt=crypt.randomUUID(),digest=Array.from(new Uint8Array(await crypt.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([salt,item.operationId,item.payload])))),byte=>byte.toString(16).padStart(2,'0')).join('');
        const latest=(await runtime.list()).find(value=>value.id===id);if(disposed||!latest||latest.status==='retired'||latest.version!==item.version)throw Error('Cannot recover offline request');if(sharedIdentityStore){if(!uuid.test(item.requestKey)||!uuid.test(item.idempotencyKey))throw Error('Cannot recover shared request');await sharedIdentityStore.restore(storageKey,item.operationId,structuredClone(item.payload),{requestKey:item.requestKey,idempotencyKey:item.idempotencyKey});}else if(identityStore)await identityStore.restore(storageKey,item.operationId,item.payload,item.requestKey);else storage.setItem(storageKey,JSON.stringify({version:1,key:item.requestKey,salt,digest}));if(disposed)throw Error('Cannot recover offline request');select.value=item.operationId;data.value=payload;status.textContent='Previous request loaded. Review before submitting.';
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
 const act=(operation,expected)=>{if(!selected||selected.status!==expected||!validId(reference.value))return;const chosen={...selected},proof=reference.value;void run(async active=>{const result=await invokeCapability(operation,{id:chosen.id,reference:proof});if(!active())return;if(!result||typeof result!=='object'||(expected==='running'?typeof result.recovered!=='boolean':!['applied','not_applied','unknown'].includes(result.outcome)))throw Error('Invalid recovery result');selected={id:chosen.id,status:expected==='running'?(result.recovered?'uncertain':'running'):(result.outcome==='applied'?'succeeded':result.outcome==='not_applied'?'pending':'uncertain')};reference.value='';selection.textContent='Selected '+chosen.id+' — '+selected.status+'.';evidenceCursor=undefined;evidenceList.replaceChildren();cursor=undefined;list.replaceChildren();status.textContent=expected==='running'?(result.recovered?'Interrupted operation marked uncertain.':'The submitter could not be confirmed stopped.'):'Verification result: '+result.outcome+'.';});};
 recover.addEventListener('click',()=>act(recoverOperation,'running'));verify.addEventListener('click',()=>act(verifyOperation,'uncertain'));
 const evidencePage=async(after,active)=>{const chosen=selected;if(!chosen)return;const result=await invokeCapability(evidenceOperation,{id:chosen.id,...(after===undefined?{}:{after}),limit:20});if(!active())return;if(!result||!Array.isArray(result.items)||result.items.length>20||(result.nextAfter!==undefined&&(!Number.isSafeInteger(result.nextAfter)||result.nextAfter<1)))throw Error('Invalid evidence listing');for(const item of result.items)if(!item||!validId(item.operatorId)||!validId(item.reference)||!['recover','applied','not_applied'].includes(item.action)||!Number.isSafeInteger(item.recordedAt)||item.recordedAt<0)throw Error('Invalid evidence listing');evidenceCursor=result.nextAfter;evidenceList.replaceChildren();for(const item of result.items)evidenceList.append(node('li',item.action+' — '+item.operatorId+' — '+item.reference+' — '+item.recordedAt));status.textContent=result.items.length?'Recovery evidence loaded.':'No recovery evidence on this page.';};
 showEvidence.addEventListener('click',()=>{void run(active=>evidencePage(undefined,active));});evidenceNext.addEventListener('click',()=>{if(evidenceCursor!==undefined)void run(active=>evidencePage(evidenceCursor,active));});sync();
 return {refresh(){return run(active=>page(undefined,active));},dispose(){if(disposed)return;disposed=true;generation++;root.replaceChildren();}};
}

// Optional controls for one host-bound rollout; authorization remains server-side.
export function mountRemoteRolloutControls(root,{statusOperation,controlOperation}={}){
 const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value);
 if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||![statusOperation,controlOperation].every(valid))throw Error('Invalid rollout controls');
 const doc=root.ownerDocument,node=(tag,text)=>{const el=doc.createElement(tag);el.textContent=text;return el;},section=node('section',''),heading=node('h2','Remote rollout'),gate=node('p','Gate status: not checked.'),poller=node('p','Poller status: not checked.'),message=node('p','Refresh the gate before using the controls.'),refresh=node('button','Refresh gate'),start=node('button','Start poller'),stop=node('button','Stop poller');
 for(const button of [refresh,start,stop])button.type='button';message.setAttribute('role','status');message.setAttribute('aria-live','polite');section.append(heading,gate,poller,message,refresh,start,stop);root.replaceChildren(section);
 let disposed=false,busy=false,generation=0,phase,stopPending=false,controlUnknown=false;
 const sync=()=>{refresh.disabled=busy;start.disabled=busy||phase!=='idle'||stopPending||controlUnknown;stop.disabled=busy||!phase;};
 const run=async(task,control=false)=>{if(disposed||busy)return;busy=true;const current=++generation,active=()=>!disposed&&generation===current;sync();try{await task(active);}catch{if(active()){phase=undefined;gate.textContent='Gate status: not checked.';if(control){controlUnknown=true;poller.textContent='Poller status: unknown.';message.textContent='Control outcome unknown. Refresh the gate, then stop the poller before starting it again.';}else message.textContent='Unable to refresh the gate. Try again.';}}finally{if(active()){busy=false;sync();}}};
 const read=active=>invokeCapability(statusOperation,{}).then(result=>{if(!active())return;const version=(v,min)=>Number.isSafeInteger(v)&&v>=min;if(!result||!['idle','running','importing','uncertain'].includes(result.phase)||(['idle','running'].includes(result.phase)?result.sourceVersion!==null||result.expectedVersion!==null:!version(result.sourceVersion,1)||!version(result.expectedVersion,0)))throw Error('Invalid rollout status');phase=result.phase;gate.textContent='Gate status: '+phase+'.';message.textContent=controlUnknown?'Control outcome unknown. Stop the poller before starting it again.':phase==='idle'?'Gate is idle.':'Gate is active or requires review.';});
 const act=action=>{if((action==='start'&&(phase!=='idle'||stopPending||controlUnknown))||(action==='stop'&&!phase))return;void run(async active=>{const result=await invokeCapability(controlOperation,{action});if(!active())return;if(!result||typeof result.running!=='boolean'||typeof result.inFlight!=='boolean'||typeof result.stopPending!=='boolean'||typeof result.reviewRequired!=='boolean')throw Error('Invalid poller status');stopPending=result.stopPending;controlUnknown=false;poller.textContent='Poller: '+(result.running?'running':'stopped')+(result.inFlight?', work in progress':'')+(stopPending?', stop pending':'')+(result.reviewRequired?', review required':'')+'.';phase=undefined;gate.textContent='Gate status: not checked.';message.textContent=stopPending?'Stop is pending. Refresh the gate and stop again to check completion.':'Refresh the gate before another action.';},true);};
 refresh.addEventListener('click',()=>{void run(read);});start.addEventListener('click',()=>act('start'));stop.addEventListener('click',()=>act('stop'));sync();
 return {refresh(){return run(read);},dispose(){if(disposed)return;disposed=true;generation++;root.replaceChildren();}};
}

// Recovery is a separate opt-in view and does not itself verify worker fencing.
export function mountRemoteRolloutRecovery(root,{statusOperation,recoveryOperation,evidenceOperation}={}){
 const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value),validText=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value),version=(value,min)=>Number.isSafeInteger(value)&&value>=min,cursorValid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{48}$/.test(value);
 if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||![statusOperation,recoveryOperation,evidenceOperation].every(validOperation))throw Error('Invalid rollout recovery view');
 const doc=root.ownerDocument,node=(tag,text)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;},section=node('section'),heading=node('h2','Rollout recovery'),status=node('p','Gate status: not checked.'),message=node('p','Refresh the gate before requesting recovery.'),refresh=node('button','Refresh recovery gate'),label=node('label','Evidence reference'),reference=node('input'),recover=node('button','Request verified recovery'),browse=node('button','View recovery evidence'),next=node('button','Next evidence page'),list=node('ul');
 reference.maxLength=256;label.append(reference);for(const button of [refresh,recover,browse,next])button.type='button';message.setAttribute('role','status');message.setAttribute('aria-live','polite');section.append(heading,status,message,refresh,label,recover,browse,next,list);root.replaceChildren(section);
 let disposed=false,busy=false,generation=0,phase,cursor;
 const sync=()=>{refresh.disabled=busy;reference.disabled=busy||!phase||phase==='idle';recover.disabled=reference.disabled||!validText(reference.value);browse.disabled=busy;next.disabled=busy||!cursor;};
 const clearGate=()=>{phase=undefined;reference.value='';status.textContent='Gate status: not checked.';};
 const run=async(task,recovery=false)=>{if(disposed||busy)return;busy=true;const current=++generation,active=()=>!disposed&&generation===current;sync();try{await task(active);}catch{if(active()){if(recovery){clearGate();cursor=undefined;list.replaceChildren();message.textContent='Recovery outcome unknown. Refresh the gate and inspect evidence before retrying.';}else message.textContent='Unable to load the requested information.';}}finally{if(active()){busy=false;sync();}}};
 const read=async active=>{clearGate();const result=await invokeCapability(statusOperation,{});if(!active())return;if(!result||!['idle','running','importing','uncertain'].includes(result.phase)||(['idle','running'].includes(result.phase)?result.sourceVersion!==null||result.expectedVersion!==null:!version(result.sourceVersion,1)||!version(result.expectedVersion,0)))throw Error('Invalid rollout status');phase=result.phase;status.textContent='Gate status: '+phase+(['importing','uncertain'].includes(phase)?'; source version '+result.sourceVersion+', expected target version '+result.expectedVersion:'')+'.';message.textContent=phase==='idle'?'No recovery is currently required.':'Provide a reference to independently verified recovery evidence.';};
 const page=async(after,active)=>{const result=await invokeCapability(evidenceOperation,{...(after?{cursor:after}:{}),limit:20});if(!active())return;if(!result||!Array.isArray(result.items)||result.items.length>20||(result.nextCursor!==undefined&&!cursorValid(result.nextCursor)))throw Error('Invalid recovery evidence');for(const item of result.items)if(!item||!validText(item.principalId)||!validText(item.reference)||!version(item.observedAt,0)||!['running','importing','uncertain'].includes(item.phase)||(item.phase==='running'?(item.sourceVersion!==null||item.expectedVersion!==null):(!version(item.sourceVersion,1)||!version(item.expectedVersion,0))))throw Error('Invalid recovery evidence');cursor=result.nextCursor;list.replaceChildren();for(const item of result.items)list.append(node('li',item.phase+' — '+item.principalId+' — '+item.reference+' — '+item.observedAt+(item.phase==='running'?'':' — source '+item.sourceVersion+', expected '+item.expectedVersion)));message.textContent=result.items.length?'Recovery evidence loaded.':'No recovery evidence on this page.';};
 refresh.addEventListener('click',()=>{void run(read);});reference.addEventListener('input',sync);recover.addEventListener('click',()=>{if(!phase||phase==='idle'||!validText(reference.value))return;const proof=reference.value;void run(async active=>{const result=await invokeCapability(recoveryOperation,{reference:proof});if(!active())return;if(!result||result.recovered!==true)throw Error('Invalid recovery result');clearGate();cursor=undefined;list.replaceChildren();message.textContent='Recovery accepted. Refresh the gate and inspect evidence.';},true);});browse.addEventListener('click',()=>{cursor=undefined;list.replaceChildren();void run(active=>page(undefined,active));});next.addEventListener('click',()=>{if(cursor)void run(active=>page(cursor,active));});sync();
 return {refresh(){return run(read);},dispose(){if(disposed)return;disposed=true;generation++;root.replaceChildren();}};
}

// Optional operator view; each capability remains separately host-authorized.
export function mountOfflineArchive(root,{candidateListOperation,archivedListOperation,archiveOperation,readOperation}={}){
 const validOperation=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(value),validId=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f]/.test(value),validTime=value=>Number.isSafeInteger(value)&&value>=0;
 if(!root?.ownerDocument||typeof root.replaceChildren!=='function'||![candidateListOperation,archivedListOperation,archiveOperation,readOperation].every(validOperation))throw Error('Invalid offline archive view');
 const doc=root.ownerDocument,node=(tag,text)=>{const element=doc.createElement(tag);if(text!==undefined)element.textContent=text;return element;},section=node('section'),heading=node('h2','Offline retention'),status=node('p','Browse completed operations or archive records.'),candidates=node('button','Browse completed operations'),archived=node('button','Browse archive records'),next=node('button','Next page'),cutoffLabel=node('label','Completed before (UTC date; unknown times excluded)'),cutoff=node('input'),list=node('ul'),selection=node('p','No operation selected.'),referenceLabel=node('label','Retirement evidence reference'),reference=node('input'),retire=node('button','Retire selected operation'),read=node('button','View archive marker'),details=node('div');
 for(const button of [candidates,archived,next,retire,read])button.type='button';status.setAttribute('role','status');status.setAttribute('aria-live','polite');reference.maxLength=256;cutoff.type='date';cutoff.min='1970-01-01';cutoffLabel.append(cutoff);referenceLabel.append(reference);section.append(heading,status,cutoffLabel,candidates,archived,next,list,selection,referenceLabel,retire,read,details);root.replaceChildren(section);
 let disposed=false,busy=false,generation=0,cursor,mode,selected,candidateCutoff;
 const cutoffValue=()=>{if(!cutoff.value)return undefined;const value=Date.parse(cutoff.value+'T00:00:00.000Z');return validTime(value)&&new Date(value).toISOString().slice(0,10)===cutoff.value?value:null;};
 const displayTime=value=>value<=8640000000000000?new Date(value).toISOString():String(value)+' ms';
 const sync=()=>{cutoff.disabled=busy;candidates.disabled=busy||cutoffValue()===null;archived.disabled=busy;next.disabled=busy||!cursor;reference.disabled=busy||selected?.kind!=='candidates';retire.disabled=busy||selected?.kind!=='candidates'||!validId(reference.value);read.disabled=busy||selected?.kind!=='archived';for(const button of list.querySelectorAll('button'))button.disabled=busy;};
 const clear=()=>{selected=undefined;reference.value='';selection.textContent='No operation selected.';details.replaceChildren();};
 const run=async task=>{if(disposed||busy)return;busy=true;const request=++generation;sync();try{await task(()=>!disposed&&generation===request);}catch{if(!disposed&&generation===request){clear();cursor=undefined;list.replaceChildren();status.textContent='Unable to complete the request. Refresh before trying again.';}}finally{if(!disposed&&generation===request){busy=false;sync();}}};
 const page=async(kind,after,active,filter)=>{const result=await invokeCapability(kind==='candidates'?candidateListOperation:archivedListOperation,{...(after?{after}:{}),...(kind==='candidates'&&filter!==undefined?{completedBefore:filter}:{}),limit:20});if(!active())return;if(!result||!Array.isArray(result.items)||result.items.length>20||(result.nextAfter!==undefined&&!validId(result.nextAfter)))throw Error('Invalid archive listing');for(const item of result.items)if(!item||!validId(item.id)||!['succeeded','discarded'].includes(item.status)||(kind==='archived'?!validTime(item.recordedAt):(item.completedAt!==undefined&&!validTime(item.completedAt))))throw Error('Invalid archive listing');mode=kind;candidateCutoff=filter;cursor=result.nextAfter;clear();list.replaceChildren();for(const item of result.items){const row=node('li'),when=kind==='archived'?'retired at '+displayTime(item.recordedAt):item.completedAt===undefined?'completion time unknown':'completed at '+displayTime(item.completedAt),button=node('button',item.id+' — '+item.status+' — '+when);button.type='button';button.addEventListener('click',()=>{if(busy||disposed)return;selected={id:item.id,status:item.status,kind};reference.value='';selection.textContent='Selected '+item.id+' — '+item.status+'.';details.replaceChildren();sync();});row.append(button);list.append(row);}status.textContent=result.items.length?'Select an operation to review.':'No operations on this page.';};
 const browseCandidates=()=>{const filter=cutoffValue();if(filter===null){status.textContent='Choose a date on or after 1970-01-01.';return Promise.resolve();}return run(active=>page('candidates',undefined,active,filter));};
 candidates.addEventListener('click',()=>{void browseCandidates();});archived.addEventListener('click',()=>{void run(active=>page('archived',undefined,active));});next.addEventListener('click',()=>{if(cursor&&mode)void run(active=>page(mode,cursor,active,candidateCutoff));});cutoff.addEventListener('input',()=>{cursor=undefined;mode=undefined;candidateCutoff=undefined;clear();list.replaceChildren();status.textContent=cutoffValue()===null?'Choose a date on or after 1970-01-01.':'Browse completed operations to apply the date filter.';sync();});reference.addEventListener('input',sync);
 retire.addEventListener('click',()=>{if(selected?.kind!=='candidates'||!validId(reference.value))return;const chosen={...selected},proof=reference.value;void run(async active=>{const result=await invokeCapability(archiveOperation,{id:chosen.id,reference:proof});if(!active())return;if(!result||result.archived!==true)throw Error('Invalid archive result');selected={...chosen,kind:'archived'};reference.value='';selection.textContent='Selected '+chosen.id+' — archived.';cursor=undefined;list.replaceChildren();details.replaceChildren();status.textContent='Operation retired. Its request identity remains protected.';});});
 read.addEventListener('click',()=>{if(selected?.kind!=='archived')return;const chosen={...selected};void run(async active=>{const result=await invokeCapability(readOperation,{id:chosen.id});if(!active())return;if(!result||result.id!==chosen.id||![result.operationId,result.requestKey,result.idempotencyKey,result.operatorId,result.reference].every(validId)||!['succeeded','discarded'].includes(result.status)||!validTime(result.recordedAt))throw Error('Invalid archive marker');details.replaceChildren();const heading=node('h3','Archive marker'),items=node('ul');for(const [label,value] of [['Operation',result.operationId],['Status',result.status],['Request key',result.requestKey],['Idempotency key',result.idempotencyKey],['Operator',result.operatorId],['Reference',result.reference],['Retired at',displayTime(result.recordedAt)]])items.append(node('li',label+': '+value));details.append(heading,items);status.textContent='Archive marker loaded.';});});
 sync();return {refresh(){return browseCandidates();},dispose(){if(disposed)return;disposed=true;generation++;root.replaceChildren();}};
}
