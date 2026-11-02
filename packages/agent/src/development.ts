import type { StreamingModel } from './index.js';

export type DraftSnapshot = {id:string; schemaVersion:number; revision:number; pages:unknown[]};
export type ProposalResult = {id:string; baseRevision:number; status:'pending'; preview:unknown};
export type ProposalClient = (baseRevision:number, patches:unknown[], signal?:AbortSignal) => Promise<ProposalResult>;

/** A proposal-only client. Credentials and URL must be supplied by trusted host configuration. */
export function createProposalClient(endpoint:string, token:string): ProposalClient {
  let url:URL;
  try { url=new URL(endpoint); } catch { throw Error('Invalid proposal endpoint'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(url.hostname) || url.pathname !== '/proposals' || url.search || url.hash || url.username || url.password || typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) throw Error('Invalid proposal endpoint or token');
  return async (baseRevision,patches,signal) => {
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify({baseRevision,patches}),signal,redirect:'error'});
    if(!response.ok) throw Error('Proposal service rejected the request');
    if (!response.body) throw Error('Invalid proposal response');
    const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let length=0;
    try {
      while(true) { const {done,value}=await reader.read(); if(done) break; length+=value.length; if(length>1024*1024) throw Error('Proposal response is too large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    let body:unknown;
    try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw Error('Invalid proposal response'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid proposal response');
    const result=body as Record<string,unknown>;
    if (typeof result.id !== 'string' || result.baseRevision !== baseRevision || result.status !== 'pending' || !result.preview || typeof result.preview !== 'object') throw Error('Invalid proposal response');
    return {id:result.id,baseRevision,status:'pending',preview:result.preview};
  };
}

/** Translates a request to a proposal. This class cannot approve or publish. */
export class DevelopmentAgent {
  constructor(private readonly model:StreamingModel, private readonly submit:ProposalClient) {}
  async propose(instruction:string, draft:DraftSnapshot, signal?:AbortSignal): Promise<ProposalResult> {
    if(typeof instruction !== 'string' || !instruction.trim() || instruction.length>10000 || !draft ||
       typeof draft.id !== 'string' || !Number.isSafeInteger(draft.revision) || draft.revision<0 ||
       ![1,2].includes(draft.schemaVersion) || !Array.isArray(draft.pages)) throw Error('Invalid development request');
    const baseRevision=draft.revision,schemaVersion=draft.schemaVersion,snapshot=JSON.stringify(draft);
    if(snapshot.length>200000) throw Error('Draft is too large');
    const prompt='Return only a JSON object with a patches array. Supported operations: '+
      (schemaVersion===2?'addPage with page {id,title,route,description,components}; setPageDescription with pageId and description; ':'addPage with page {id,title,route,components}; ')+
      'setPageTitle with pageId and title; addComponent with pageId and component {id,type,props}. '+
      'Renderable component types: Text with props {text} or {path,variant?}; Input with props {label,path,variant?}; Card with props {title?,text?}. Paths are absolute JSON pointers. Input variants: shortText or longText. Input edits and Text bindings use the local surface model and do not persist. '+
      'Do not include code or additional properties. Proposals require separate human approval.\n'+
      'Current draft: '+snapshot+'\nRequest: '+instruction;
    let output='';
    for await(const chunk of this.model.stream([{role:'user',content:prompt}],signal)) {
      if(typeof chunk !== 'string') throw Error('Invalid model output');
      output+=chunk;
      if(output.length>200000) throw Error('Model output is too large');
    }
    let parsed:unknown;
    try { parsed=JSON.parse(output); } catch { throw Error('Model output is not valid JSON'); }
    if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key=>key!=='patches') ||
       !Array.isArray((parsed as Record<string,unknown>).patches) || !(parsed as {patches:unknown[]}).patches.length || (parsed as {patches:unknown[]}).patches.length>100) throw Error('Invalid model proposal');
    return this.submit(baseRevision,(parsed as {patches:unknown[]}).patches,signal);
  }
}
