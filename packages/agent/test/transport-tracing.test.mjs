import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {SpanStatusCode} from '@opentelemetry/api';
import {TracerProvider,SimpleSpanProcessor,InMemorySpanExporter} from '@opentelemetry/sdk-trace';
import {createAGUIServer,LangGraphAGUIAdapter} from '../dist/index.js';

test('agent tracing ends an aborted streaming span and propagates cancellation', {timeout:10000},async()=>{
 const exporter=new InMemorySpanExporter(),provider=new TracerProvider({spanProcessors:[new SimpleSpanProcessor({exporter})]}),token='agent-secret-at-least-thirty-two-characters';let aborted;const stopped=new Promise(resolve=>aborted=resolve),model={async *stream(_messages,signal){yield 'first';await new Promise(resolve=>{if(signal.aborted){aborted();resolve();return;}signal.addEventListener('abort',()=>{aborted();resolve();},{once:true});});}};
 const server=createAGUIServer(new LangGraphAGUIAdapter(model),token,{tracer:provider.getTracer('test')});server.listen(0,'127.0.0.1');await once(server,'listening');const controller=new AbortController();
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/agent`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({threadId:'thread',runId:'run',messages:[{id:'m',role:'user',content:'secret prompt'}],tools:[],context:[],state:{}}),signal:controller.signal}),reader=response.body.getReader(),decoder=new TextDecoder();let text='';while(!text.includes('TEXT_MESSAGE_CONTENT')){const result=await reader.read();if(result.done)throw Error('Stream ended early');text+=decoder.decode(result.value,{stream:true});}controller.abort();await stopped;for(let i=0;i<100&&!exporter.getFinishedSpans().length;i++)await new Promise(resolve=>setTimeout(resolve,10));const span=exporter.getFinishedSpans()[0];assert.equal(span.status.code,SpanStatusCode.ERROR);assert.equal(span.attributes['error.type'],'client_disconnect');assert.equal(JSON.stringify({name:span.name,attributes:span.attributes}).includes('secret'),false);}finally{controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await provider.shutdown();}
});
