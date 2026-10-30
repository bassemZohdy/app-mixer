import {context,propagation,ROOT_CONTEXT,trace,SpanKind,SpanStatusCode,type Tracer} from '@opentelemetry/api';
import type {IncomingMessage,ServerResponse} from 'node:http';

export type AgentTransportTracingOptions={tracer:Tracer;trustRemoteParent?:boolean};
export function traceAgent(options:AgentTransportTracingOptions){
 return (req:IncomingMessage,res:ServerResponse,run:()=>void):void=>{
  let started=false;try{
   let parent=ROOT_CONTEXT;if(options.trustRemoteParent){let value:string|undefined,duplicate=false;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='traceparent'){if(value!==undefined)duplicate=true;value=req.rawHeaders[i+1];}if(!duplicate&&value&&value.length<=512)parent=propagation.extract(ROOT_CONTEXT,{traceparent:value});}
   const method=req.method==='POST'?'POST':'_OTHER',path=method==='POST'&&req.url==='/agent'?'/agent':undefined,span=options.tracer.startSpan(path?`${method} ${path}`:method,{kind:SpanKind.SERVER,attributes:{'http.request.method':method,...(path?{'http.route':path}:{})}},parent);let ended=false;
   const finish=(aborted:boolean)=>{if(ended)return;ended=true;try{if(aborted){span.setAttribute('error.type','client_disconnect');span.setStatus({code:SpanStatusCode.ERROR});}else{span.setAttribute('http.response.status_code',res.statusCode);if(res.statusCode>=500)span.setStatus({code:SpanStatusCode.ERROR});}}catch{}finally{try{span.end();}catch{}}};
   res.once('finish',()=>finish(false));res.once('close',()=>finish(true));context.with(trace.setSpan(parent,span),()=>{started=true;run();});
  }catch{if(!started)run();}
 };
}
