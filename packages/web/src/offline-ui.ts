import {EncryptedBrowserQueue,type BrowserQueueItem,type BrowserQueueScope} from './offline.js';
export type OfflineConflictPanelOptions={
  loadCurrent:(operationId:string,payload:Record<string,unknown>,scope:BrowserQueueScope)=>unknown|Promise<unknown>;
};
export type OfflineConflictPanel={refresh:()=>Promise<void>;dispose:()=>void};

/** Host mounts this after unlocking the queue and supplying an authenticated current-state loader. */
export function mountOfflineConflictPanel(root:HTMLElement,queue:EncryptedBrowserQueue,options:OfflineConflictPanelOptions):OfflineConflictPanel {
  if(!root||!root.ownerDocument||typeof root.replaceChildren!=='function'||!(queue instanceof EncryptedBrowserQueue)||!options||typeof options.loadCurrent!=='function')throw Error('Invalid offline conflict panel');
  const document=root.ownerDocument,loadCurrent=options.loadCurrent;let generation=0,disposed=false;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
  async function refresh():Promise<void>{
    if(disposed)return;const current=++generation;
    const heading=node('h2','Offline operations'),status=node('p','Loading operations…'),list=node('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.replaceChildren(heading,status,list);
    try{
      const items=(await queue.list()).filter(item=>['conflict','uncertain','exhausted'].includes(item.status));
      if(disposed||current!==generation)return;
      if(!items.length){status.textContent='No operations need attention.';return;}
      status.textContent='Review operations that need attention.';
      for(const item of items)list.appendChild(renderItem(item,current));
    }catch{if(!disposed&&current===generation)status.textContent='Unable to load offline operations.';}
  }
  function renderItem(item:BrowserQueueItem,renderGeneration:number):HTMLElement {
    const section=node('section'),title=node('h3',item.operationId+' — '+item.status),message=node('p'),queuedLabel=node('h4','Queued data'),queued=node('pre',JSON.stringify(item.payload,null,2));
    message.setAttribute('role','status');section.append(title,node('p','Operation ID: '+item.id),message,queuedLabel,queued);
    if(item.status==='uncertain'){
      message.textContent='The remote outcome is unknown. An authorized host must verify it before reconciliation.';return section;
    }
    if(item.status==='exhausted'){
      message.textContent='Retry limit reached. Review the operation with an authorized host.';return section;
    }
    message.textContent='Load current data before resolving this conflict.';
    const review=node('button','Load current data'),discard=node('button','Discard queued operation'),currentLabel=node('h4','Current data'),currentData=node('pre'),editLabel=node('label','Resolved data (JSON object)'),edit=node('textarea'),resolve=node('button','Queue resolved operation');
    review.type='button';discard.type='button';resolve.type='button';resolve.disabled=true;edit.disabled=true;edit.value=JSON.stringify(item.payload,null,2);editLabel.appendChild(edit);
    section.append(review,discard,currentLabel,currentData,editLabel,resolve);
    let busy=false,requestKey='',lastPayload='';
    const isCurrent=()=>!disposed&&renderGeneration===generation;
    const lock=(active:boolean)=>{busy=active;review.disabled=active;discard.disabled=active;edit.disabled=active||!currentData.textContent;resolve.disabled=active||!currentData.textContent;};
    review.addEventListener('click',()=>{void (async()=>{
      if(busy)return;lock(true);currentData.textContent='';
      try{
        const value=await loadCurrent(item.operationId,structuredClone(item.payload),queue.getScope());
        const text=JSON.stringify(value,null,2);if(typeof text!=='string'||new TextEncoder().encode(text).length>1024*1024)throw Error('Invalid current data');
        if(!isCurrent())return;currentData.textContent=text;message.textContent='Compare the current and queued data, then edit the resolved object.';
      }catch{if(isCurrent())message.textContent='Unable to load current data.';}
      finally{if(isCurrent())lock(false);}
    })();});
    discard.addEventListener('click',()=>{void (async()=>{
      if(busy)return;lock(true);
      try{await queue.transition(item.id,item.version,'discard');if(isCurrent())await refresh();}
      catch{if(isCurrent()){message.textContent='Unable to discard. Refresh and try again.';lock(false);}}
    })();});
    resolve.addEventListener('click',()=>{void (async()=>{
      if(busy||!currentData.textContent)return;
      let payload:Record<string,unknown>;try{const value:unknown=JSON.parse(edit.value);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid');payload=value as Record<string,unknown>;}catch{message.textContent='Enter a valid JSON object.';return;}
      const serialized=JSON.stringify(payload);
      if(!requestKey||lastPayload!==serialized){
        const crypt=document.defaultView?.crypto;if(!crypt||typeof crypt.randomUUID!=='function'){message.textContent='Secure request IDs are unavailable.';return;}
        requestKey=crypt.randomUUID();lastPayload=serialized;
      }
      lock(true);
      try{await queue.resolveConflict(item.id,item.version,requestKey,payload);if(isCurrent())await refresh();}
      catch{if(isCurrent()){message.textContent='Unable to queue the resolution. Your edits are retained; refresh to check its state.';lock(false);}}
    })();});
    return section;
  }
  return {refresh,dispose(){disposed=true;generation++;root.replaceChildren();}};
}
