import {EncryptedBrowserQueue,BrowserOfflineWorker,mountOfflineConflictPanel} from './offline.js';

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

// Explicit user action creates a durable intent. Hosts must not allowlist staged submission.
export function mountGeneratedOfflineForm(root,runtime,options={}){
  if(!root?.ownerDocument||typeof runtime?.enqueue!=='function'||typeof runtime.operations!=='function'||!options||typeof options!=='object'||(options.storageKey!==undefined&&(typeof options.storageKey!=='string'||!options.storageKey.trim()||options.storageKey.length>200))||(options.identityStore!==undefined&&(!options.identityStore||typeof options.identityStore.getOrCreate!=='function'||typeof options.identityStore.reset!=='function'||typeof options.identityStore.restore!=='function')))throw Error('Invalid offline form');
  const doc=root.ownerDocument,form=doc.createElement('form'),label=doc.createElement('label'),select=doc.createElement('select'),dataLabel=doc.createElement('label'),data=doc.createElement('textarea'),button=doc.createElement('button'),reset=doc.createElement('button'),status=doc.createElement('p');
  label.textContent='Operation';for(const operation of runtime.operations()){const option=doc.createElement('option');option.value=operation.id;option.textContent=operation.label;select.appendChild(option);}label.appendChild(select);
  dataLabel.textContent='Operation data (JSON object)';data.value='{}';dataLabel.appendChild(data);button.type='submit';button.textContent='Queue operation';reset.type='button';reset.textContent='New operation';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  form.append(label,dataLabel,button,reset,status);root.replaceChildren(form);let busy=false,disposed=false;const storageKey='app-mixer-offline-form-v1:'+(options.storageKey??(root.id||'default'));
  reset.addEventListener('click',()=>{if(busy)return;busy=true;button.disabled=true;reset.disabled=true;void (async()=>{try{if(options.identityStore)await options.identityStore.reset(storageKey);else doc.defaultView.sessionStorage.removeItem(storageKey);if(!disposed)status.textContent='Ready to queue a new operation.';}catch{if(!disposed)status.textContent='Unable to create a new request ID. Your data is retained.';}finally{busy=false;if(!disposed){button.disabled=false;reset.disabled=false;}}})();});
  form.addEventListener('submit',event=>{event.preventDefault();void (async()=>{
    if(busy)return;let payload;try{payload=JSON.parse(data.value);if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid');}catch{status.textContent='Enter a valid JSON object.';return;}
    const operation=select.value;busy=true;button.disabled=true;reset.disabled=true;select.disabled=true;data.disabled=true;
    try{
      let requestKey;
      if(options.identityStore)requestKey=await options.identityStore.getOrCreate(storageKey,operation,payload);
      else {
      const crypt=doc.defaultView?.crypto,storage=doc.defaultView?.sessionStorage;if(!crypt||typeof crypt.randomUUID!=='function'||!crypt.subtle||!storage)throw Error('Secure request IDs are unavailable');
      const raw=storage.getItem(storageKey);let saved=raw===null?undefined:JSON.parse(raw);if(saved!==undefined&&(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).sort().join(',')!=='digest,key,salt,version'||saved.version!==1||typeof saved.key!=='string'||!/^[0-9a-f-]{36}$/.test(saved.key)||typeof saved.salt!=='string'||!/^[0-9a-f-]{36}$/.test(saved.salt)||typeof saved.digest!=='string'||!/^[0-9a-f]{64}$/.test(saved.digest)))throw Error('Invalid stored request ID');
      const digest=async salt=>Array.from(new Uint8Array(await crypt.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([salt,operation,payload])))),byte=>byte.toString(16).padStart(2,'0')).join('');
      if(!saved||saved.digest!==await digest(saved.salt)){const salt=crypt.randomUUID();saved={version:1,key:crypt.randomUUID(),salt,digest:await digest(salt)};storage.setItem(storageKey,JSON.stringify(saved));}
        requestKey=saved.key;
      }
      const item=await runtime.enqueue(operation,requestKey,payload);status.textContent='Operation '+item.status+'.';
    }
    catch{status.textContent='Unable to queue operation. Your data is retained.';}
    finally{busy=false;button.disabled=false;reset.disabled=false;select.disabled=false;data.disabled=false;}
  })();});
  return {
    async recover(id){
      if(disposed||busy||typeof runtime.list!=='function'||typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('Cannot recover offline request');
      busy=true;button.disabled=true;reset.disabled=true;select.disabled=true;data.disabled=true;
      try{
        const crypt=doc.defaultView?.crypto,storage=doc.defaultView?.sessionStorage;if(!crypt||typeof crypt.randomUUID!=='function'||!crypt.subtle||!storage)throw Error('Secure request IDs are unavailable');
        const item=(await runtime.list()).find(value=>value.id===id);if(disposed||!item||![...select.options].some(option=>option.value===item.operationId)||typeof item.requestKey!=='string'||!/^[0-9a-f-]{36}$/.test(item.requestKey))throw Error('Cannot recover offline request');
        const payload=JSON.stringify(item.payload,null,2),salt=crypt.randomUUID(),digest=Array.from(new Uint8Array(await crypt.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([salt,item.operationId,item.payload])))),byte=>byte.toString(16).padStart(2,'0')).join('');
        const latest=(await runtime.list()).find(value=>value.id===id);if(disposed||!latest||latest.version!==item.version)throw Error('Cannot recover offline request');if(options.identityStore)await options.identityStore.restore(storageKey,item.operationId,item.payload,item.requestKey);else storage.setItem(storageKey,JSON.stringify({version:1,key:item.requestKey,salt,digest}));if(disposed)throw Error('Cannot recover offline request');select.value=item.operationId;data.value=payload;status.textContent='Previous request loaded. Review before submitting.';
      }finally{busy=false;if(!disposed){button.disabled=false;reset.disabled=false;select.disabled=false;data.disabled=false;}}
    },
    dispose(){disposed=true;root.replaceChildren();}
  };
}
