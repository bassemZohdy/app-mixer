/** Static local-development UI; it never receives credentials from the server. */
export const DEVELOPMENT_UI = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review proposal — App Mixer</title>
<style>body{font:16px system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;color:#17243a}label{display:block;margin-top:1rem}input{padding:.5rem;width:min(100%,38rem);box-sizing:border-box}button{margin:1rem .5rem 0 0;padding:.6rem 1rem}pre{overflow:auto;background:#f2f5fa;padding:1rem;white-space:pre-wrap;overflow-wrap:anywhere}#status{min-height:1.5em}</style></head>
<body><h1>Review development proposal</h1><p>Enter the developer token and proposal ID. Review the patch and preview before deciding. Approval changes the draft; publishing is a separate action.</p>
<label for="token">Developer token</label><input id="token" type="password" autocomplete="off">
<label for="instruction">Development request</label><input id="instruction" autocomplete="off" placeholder="Describe the change"><button id="generate" type="button">Create proposal</button>
<label for="proposal-id">Proposal ID</label><input id="proposal-id" autocomplete="off">
<button id="load" type="button">Load proposal</button><p id="status" role="status" aria-live="polite"></p>
<section><h2>Patch</h2><pre id="patch">No proposal loaded.</pre><h2>Rendered preview</h2><div id="rendered-preview"></div><h2>Preview definition</h2><pre id="preview">No proposal loaded.</pre></section>
<button id="approve" type="button" disabled>Approve draft change</button><button id="reject" type="button" disabled>Reject</button><button id="publish" type="button" disabled>Publish approved revision</button>
<script type="module">
import {A2UIRenderer,APP_MIXER_CATALOG} from '/development/renderer.mjs';
(()=>{
const instruction=document.getElementById('instruction'),generate=document.getElementById('generate'),token=document.getElementById('token'),proposalId=document.getElementById('proposal-id'),status=document.getElementById('status'),patch=document.getElementById('patch'),preview=document.getElementById('preview'),load=document.getElementById('load'),approve=document.getElementById('approve'),reject=document.getElementById('reject'),publish=document.getElementById('publish');
const rendered=document.getElementById('rendered-preview');
let current, approvedRevision, approvedId;
function renderPreview(definition){
  rendered.replaceChildren();
  try{
    const renderer=new A2UIRenderer(rendered),surfaceId='preview';
    const components=[{id:'root',component:'Column',children:[]}];
    for(const [i,page] of definition.pages.entries()){
      const title='page-'+i;components[0].children.push(title);components.push({id:title,component:'Text',text:page.title,variant:'h2'});
      for(const [j,item] of page.components.entries()){
        if(item.type!=='Text')throw Error('Rendered preview does not support '+item.type);
        const id='page-'+i+'-item-'+j;components[0].children.push(id);components.push({id,component:'Text',text:String(item.props?.text??'')});
      }
    }
    renderer.apply({version:'v0.9.1',createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}});
    renderer.apply({version:'v0.9.1',updateComponents:{surfaceId,components}});return true;
  }catch(error){rendered.textContent=error.message;return false;}
}
function reset(){current=undefined;approvedRevision=undefined;approvedId=undefined;approve.disabled=true;reject.disabled=true;publish.disabled=true;patch.textContent='No proposal loaded.';preview.textContent='No proposal loaded.';rendered.replaceChildren();}
for(const field of [token,proposalId])field.addEventListener('input',reset);
async function call(path,method='GET',body){const response=await fetch(path,{method,headers:{'Authorization':'Bearer '+token.value,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;}
generate.addEventListener('click',async()=>{reset();generate.disabled=true;status.textContent='Creating proposal…';const auth=token.value,request=instruction.value.trim();try{if(!request)throw Error('Enter a development request');const result=await call('/development/propose','POST',{instruction:request});if(token.value!==auth)return;proposalId.value=result.id;current=result;patch.textContent=JSON.stringify(result.patches,null,2);preview.textContent=JSON.stringify(result.preview,null,2);const supported=renderPreview(result.preview);approve.disabled=!supported;reject.disabled=false;status.textContent=supported?'Proposal: '+result.status:'Cannot approve: rendered preview is unsupported.';}catch(error){status.textContent=error.message;}finally{generate.disabled=false;}});
load.addEventListener('click',async()=>{reset();status.textContent='Loading…';try{const id=proposalId.value.trim();if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid proposal ID');const result=await call('/proposals/'+id);if(id!==proposalId.value.trim())return;current=result;patch.textContent=JSON.stringify(result.patches,null,2);preview.textContent=JSON.stringify(result.preview,null,2);const supported=renderPreview(result.preview);approve.disabled=result.status!=='pending'||!supported;reject.disabled=result.status!=='pending';status.textContent=supported?'Proposal: '+result.status:'Cannot approve: rendered preview is unsupported.';}catch(error){status.textContent=error.message;}});
approve.addEventListener('click',async()=>{if(!current||current.status!=='pending')return;approve.disabled=true;reject.disabled=true;try{const id=current.id;const result=await call('/proposals/'+id+'/approve','POST');if(!current||current.id!==id)return;current=result;approvedId=id;approvedRevision=result.approvedRevision;publish.disabled=false;status.textContent='Draft approved. Publish the approved revision when ready.';}catch(error){status.textContent=error.message;approve.disabled=false;reject.disabled=false;}});
reject.addEventListener('click',async()=>{if(!current||current.status!=='pending')return;approve.disabled=true;reject.disabled=true;try{const id=current.id;await call('/proposals/'+id+'/reject','POST');if(!current||current.id!==id)return;current=undefined;status.textContent='Proposal rejected.';}catch(error){status.textContent=error.message;approve.disabled=false;reject.disabled=false;}});
publish.addEventListener('click',async()=>{if(approvedRevision===undefined||approvedId!==proposalId.value.trim())return;publish.disabled=true;try{const result=await call('/publish','POST',{expectedRevision:approvedRevision});approvedRevision=undefined;status.textContent='Published version '+result.version+'.';}catch(error){status.textContent=error.message;publish.disabled=false;}});
document.body.dataset.reviewReady='true';
})();
</script></body></html>`;
