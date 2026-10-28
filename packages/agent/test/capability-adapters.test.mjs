import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {CapabilityRegistry,createOpenAPIGetBinding} from '../../core/dist/index.js';
import {A2UIRenderer,basicRegistry,APP_MIXER_CATALOG,createCapabilityActionHandler} from '../../web/dist/index.js';
import {createCapabilityTool,createToolCallingModel,LangGraphAGUIAdapter} from '../dist/index.js';
import {AIMessage} from '@langchain/core/messages';
class Element{constructor(doc){this.ownerDocument=doc;this.children=[];this.style={};this.dataset={};this.listeners={};this.textContent='';}appendChild(child){this.children.push(child);}replaceChildren(...children){this.children=children;}addEventListener(name,fn){this.listeners[name]=fn;}}
const spec={openapi:'3.1.0',paths:{'/customers/{id}':{get:{operationId:'getCustomer',parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}]}}}};

test('A2UI button and LangChain tool invoke the same authorized capability',async()=>{
  let calls=0;const service=createServer((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json'});res.end('{"name":"Ada"}');});
  service.listen(0,'127.0.0.1');await once(service,'listening');
  try{
    const audit=[],registry=new CapabilityRegistry(event=>audit.push(event));
    const {candidate,binding}=createOpenAPIGetBinding(spec,'getCustomer',{baseURL:`http://127.0.0.1:${service.address().port}`,authorize:ctx=>ctx.tenantId==='t'&&ctx.principalId==='alice'});
    registry.register(candidate,binding);
    let finish;const result=new Promise(resolve=>{finish=resolve;});
    const handler=createCapabilityActionHandler({mapping:{loadCustomer:'getCustomer'},invoke:(id,input)=>registry.invoke(id,input,{tenantId:'t',principalId:'alice',origin:'ui'}),onResult:(_id,value)=>finish(value),onError:error=>finish({error})});
    const doc={createElement:()=>new Element(doc)},host=doc.createElement();
    const renderer=new A2UIRenderer(host,basicRegistry(),handler),version='v0.9.1',surfaceId='main';
    renderer.apply({version,createSurface:{surfaceId,catalogId:APP_MIXER_CATALOG}});
    renderer.apply({version,updateDataModel:{surfaceId,value:{params:{path:{id:'c1'}}}}});
    renderer.apply({version,updateComponents:{surfaceId,components:[{id:'root',component:'Button',child:'label',action:{event:{name:'loadCustomer',context:{path:{path:'/params/path'}}}}},{id:'label',component:'Text',text:'Load'}]}});
    host.children[0].children[0].listeners.click();assert.equal((await result).name,'Ada');
    const capability=createCapabilityTool({name:'getCustomer',description:'Get a customer',invoke:input=>registry.invoke('getCustomer',input,{tenantId:'t',principalId:'alice',origin:'agent'})});
    let turn=0;const model={async invoke(messages){if(++turn===1)return new AIMessage({content:'',tool_calls:[{id:'c',name:'getCustomer',args:{path:{id:'c1'}}}]});assert.match(messages.at(-1).content,/Ada/);return new AIMessage('Ada');}};
    const events=[];for await(const event of new LangGraphAGUIAdapter(createToolCallingModel(model,[capability])).run({threadId:'t',runId:'r',messages:[{role:'user',content:'Get customer'}]}))events.push(event);
    assert.equal(events.at(-1).type,'RUN_FINISHED');assert.equal(events.find(e=>e.type==='TEXT_MESSAGE_CONTENT').delta,'Ada');
    const denied=createCapabilityTool({name:'getCustomer',description:'Get a customer',invoke:input=>registry.invoke('getCustomer',input,{tenantId:'other',principalId:'alice',origin:'agent'})});
    await assert.rejects(denied.invoke({path:{id:'c1'}}),/forbidden/);
    let finishDenied;const uiDenied=new Promise(resolve=>{finishDenied=resolve;});
    const deniedHandler=createCapabilityActionHandler({mapping:{loadCustomer:'getCustomer'},invoke:(id,input)=>registry.invoke(id,input,{tenantId:'other',principalId:'alice',origin:'ui'}),onResult:()=>finishDenied('unexpected'),onError:finishDenied});
    deniedHandler({version:'v0.9.1',action:{name:'loadCustomer',surfaceId:'main',sourceComponentId:'root',timestamp:new Date().toISOString(),context:{path:{id:'c1'}}}});
    assert.equal(await uiDenied,'Capability invocation failed');
    assert.equal(calls,2);assert.deepEqual(audit.map(e=>e.outcome),['attempt','succeeded','attempt','succeeded','attempt','denied','attempt','denied']);
  }finally{await new Promise((resolve,reject)=>service.close(e=>e?reject(e):resolve()));}
});
