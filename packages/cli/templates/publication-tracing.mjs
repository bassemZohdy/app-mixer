// Optional server-side instrumentation. The host owns the SDK and propagator.
export async function createPublicationTracing({enabled=false,trustIncoming=false,propagate=false}={}){
 if(typeof enabled!=='boolean'||typeof trustIncoming!=='boolean'||typeof propagate!=='boolean'||(!enabled&&(trustIncoming||propagate)))throw Error('Invalid workspace tracing configuration');
 if(!enabled)return {handle:(_req,_res,_method,_path,work)=>work(),upstream:(_method,_path,work)=>work({},()=>{})};
 const api=await import('@opentelemetry/api'),{context,propagation,trace,ROOT_CONTEXT,SpanKind,SpanStatusCode}=api,tracer=trace.getTracer('app-mixer-workspace');
 const setStatus=(span,code)=>{try{span.setAttribute('http.response.status_code',code);if(code>=500)span.setStatus({code:SpanStatusCode.ERROR});}catch{}};
 const end=span=>{try{span.end();}catch{}};
 return {
  handle(req,res,method,path,work){
   let started=false;try{
    let parent=ROOT_CONTEXT;if(trustIncoming){let value,duplicate=false;for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='traceparent'){if(value!==undefined)duplicate=true;value=req.rawHeaders[i+1];}if(!duplicate&&value&&value.length<=512)parent=propagation.extract(ROOT_CONTEXT,{traceparent:value});}
    const span=tracer.startSpan(method+' '+path,{kind:SpanKind.SERVER,attributes:{'http.request.method':method,'http.route':path}},parent);let ended=false;
    const finish=aborted=>{if(ended)return;ended=true;try{if(aborted){span.setAttribute('error.type','client_disconnect');span.setStatus({code:SpanStatusCode.ERROR});}else setStatus(span,res.statusCode);}catch{}finally{end(span);}};
    res.once('finish',()=>finish(false));res.once('close',()=>finish(true));return context.with(trace.setSpan(parent,span),()=>{started=true;return work();});
   }catch(error){if(!started)return work();throw error;}
  },
  async upstream(method,path,work,shouldPropagate=propagate){
   let span;try{span=tracer.startSpan(method+' '+path,{kind:SpanKind.CLIENT,attributes:{'http.request.method':method,'url.path':path}},context.active());}catch{return work({},()=>{});}
   let active;const headers={};try{active=trace.setSpan(context.active(),span);if(shouldPropagate){const carrier={};propagation.inject(active,carrier);if(typeof carrier.traceparent==='string'&&/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(carrier.traceparent))headers.traceparent=carrier.traceparent;}}catch{}
   const report=code=>{setStatus(span,code);if(code>=400)try{span.setStatus({code:SpanStatusCode.ERROR});}catch{}};let pending;
   try{try{context.with(active??context.active(),()=>{pending=work(headers,report);});}catch{if(!pending)pending=work({},report);}return await pending;}catch(error){try{span.setAttribute('error.type','request_failed');span.setStatus({code:SpanStatusCode.ERROR});}catch{}throw error;}finally{end(span);}
  }
 };
}
