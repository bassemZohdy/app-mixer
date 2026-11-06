/** A restricted static subset of App Mixer's A2UI v0.9.1 catalog for React Native. */
export const APP_MIXER_CATALOG='https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json';
export const BASIC_CATALOG='https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
type Obj=Record<string,unknown>;
export type NativeNode={id:string;kind:string;text?:string;variant?:string;justify?:string;align?:string;label?:string;value?:string;extensionProps?:Record<string,unknown>;children:NativeNode[]};
export type NativeSurface={id:string;revision:number;root?:NativeNode};
export type ActionMessage={version:'v0.9.1';action:{name:string;surfaceId:string;sourceComponentId:string;timestamp:string;context:Record<string,unknown>}};
const obj=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// JSON Schema maxLength counts Unicode code points, not UTF-16 code units.
function withinCodePointLimit(value:string,limit:number):boolean {if(value.length<=limit)return true;let count=0;for(const _ of value)if(++count>limit)return false;return true;}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&withinCodePointLimit(value,256);
const only=(value:Obj,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const pointer=(path:string):string[]=>{
  if(path===''||path==='/')return [];
  if(!path.startsWith('/'))throw Error('Only absolute JSON pointers are supported');
  return path.slice(1).split('/').map(segment=>{
    if(/~(?![01])/.test(segment))throw Error('Invalid JSON pointer');
    const value=segment.replace(/~1/g,'/').replace(/~0/g,'~');
    if(['__proto__','prototype','constructor'].includes(value))throw Error('Unsafe JSON pointer');
    return value;
  });
};
function cloneData(value:unknown):unknown {
  const ancestors=new Set<object>();let count=0;
  const visit=(input:unknown,depth:number):unknown=>{
    if(++count>10000||depth>100)throw Error('Data model too large');
    if(input===undefined||input===null||typeof input==='string'||typeof input==='boolean'||(typeof input==='number'&&Number.isFinite(input)))return input;
    if(!obj(input)&&!Array.isArray(input))throw Error('Unsupported data value');
    if(ancestors.has(input))throw Error('Cyclic data model');ancestors.add(input);
    let result:unknown;
    if(Array.isArray(input))result=input.map(item=>visit(item,depth+1));
    else {const output:Obj={};for(const [key,item] of Object.entries(input)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe data key');output[key]=visit(item,depth+1);}result=output;}
    ancestors.delete(input);return result;
  };
  return visit(value,0);
}
function read(data:unknown,path:string):unknown {
  let current=data;
  for(const key of pointer(path)){if(!obj(current)&&!Array.isArray(current))return undefined;if(Array.isArray(current)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=current.length))return undefined;if(!Object.hasOwn(current,key))return undefined;current=(current as Record<string,unknown>)[key];}
  return current;
}
function updateData(data:unknown,path:string,value:unknown,remove:boolean):unknown {
  const keys=pointer(path);if(!keys.length)return remove?{}:cloneData(value);
  const root=cloneData(data);let current=root;
  for(let i=0;i<keys.length-1;i++){
    const key=keys[i];if(!obj(current)&&!Array.isArray(current))throw Error('Data path parent does not exist');
    if(Array.isArray(current)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=current.length))throw Error('Invalid array index');
    if(!Object.hasOwn(current,key)||(current as Record<string,unknown>)[key]===undefined){if(remove)return root;if(Array.isArray(current))throw Error('Invalid array index');current[key]={};}
    current=(current as Record<string,unknown>)[key];
  }
  if(!obj(current)&&!Array.isArray(current))throw Error('Data path parent does not exist');
  const last=keys[keys.length-1];
  if(Array.isArray(current)){if(!/^(0|[1-9]\d*)$/.test(last)||Number(last)>=current.length)throw Error('Invalid array index');current[Number(last)]=remove?undefined:cloneData(value);}
  else if(remove)delete current[last];else current[last]=cloneData(value);
  return cloneData(root);
}
const aligns=['start','center','end','stretch'];
const justifies=['start','center','end','spaceBetween','spaceAround','spaceEvenly'];
type NativeExtension={render:(props:Record<string,unknown>)=>unknown;validate:(component:Record<string,unknown>)=>boolean};
export type NativeInstalledExtension={id:string;version:string;scope:'platform'|'development'|'application';components:Record<string,NativeExtension>};
export type NativePlanVerifier=(input:{keyId:string;signingInput:string;signature:string;signal?:AbortSignal})=>boolean|Promise<boolean>;
export type NativeSignedPlanTarget={tenantId:string;environment:string;applicationId:string;revision:number;clock?:()=>number;verificationTimeoutMs?:number;signal?:AbortSignal};
/** Trusted host registrations; validators must synchronously return true for accepted components. */
export class NativeComponentRegistry {
  private readonly entries=new Map<string,NativeExtension>();
  /** Verify the exact signed payload using a host-trusted Ed25519 verifier before resolving components. */
  static async fromSignedPlan(envelope:unknown,installed:NativeInstalledExtension[],expected:NativeSignedPlanTarget,verify:NativePlanVerifier):Promise<NativeComponentRegistry>{
    const exact=(value:Obj,fields:string[])=>only(value,fields)&&fields.every(field=>Object.hasOwn(value,field)),id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    if(!obj(envelope)||!exact(envelope,['version','keyId','payload','signature'])||envelope.version!==1||!id(envelope.keyId)||typeof envelope.payload!=='string'||envelope.payload.length>1000000||typeof envelope.signature!=='string'||!/^[A-Za-z0-9_-]{85}[AQgw]$/.test(envelope.signature)||!expected||!id(expected.tenantId)||typeof expected.environment!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(expected.environment)||typeof expected.applicationId!=='string'||!expected.applicationId.trim()||expected.applicationId.length>256||/[\u0000-\u001f\u007f]/.test(expected.applicationId)||!Number.isSafeInteger(expected.revision)||expected.revision<0||(expected.clock!==undefined&&typeof expected.clock!=='function')||(expected.signal!==undefined&&(!expected.signal||typeof expected.signal.aborted!=='boolean'||typeof expected.signal.addEventListener!=='function'||typeof expected.signal.removeEventListener!=='function'))||(expected.verificationTimeoutMs!==undefined&&(!Number.isSafeInteger(expected.verificationTimeoutMs)||expected.verificationTimeoutMs<1||expected.verificationTimeoutMs>300000))||typeof verify!=='function'||!Array.isArray(installed)||installed.length>256)throw Error('Invalid signed native extension plan');
    const keyId=envelope.keyId as string,payload=envelope.payload,signature=envelope.signature,target={tenantId:expected.tenantId,environment:expected.environment,applicationId:expected.applicationId,revision:expected.revision},clock=expected.clock??Date.now,timeoutMs=expected.verificationTimeoutMs,signal=expected.signal;let count=0;const fixed=installed.map(item=>{if(!obj(item)||!exact(item,['id','version','scope','components'])||!obj(item.components))throw Error('Invalid installed native extension');const components:Record<string,NativeExtension>=Object.create(null) as Record<string,NativeExtension>;for(const [name,entry] of Object.entries(item.components)){if(++count>10000||!obj(entry)||typeof entry.render!=='function'||typeof entry.validate!=='function')throw Error('Invalid installed native extension');components[name]={render:entry.render as NativeExtension['render'],validate:entry.validate as NativeExtension['validate']};}return {id:item.id,version:item.version,scope:item.scope,components} as NativeInstalledExtension;});
    let verified=false;const controller=timeoutMs===undefined&&!signal?undefined:new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;try{if(signal?.aborted)throw Error('Cancelled');const result=Promise.resolve().then(()=>{if(controller?.signal.aborted)throw Error('Cancelled');return verify({keyId,signingInput:`app-mixer-native-plan-v1.${keyId}.${payload}`,signature,...(controller?{signal:controller.signal}:{})});});const guards:Promise<boolean>[]=[result];if(timeoutMs!==undefined)guards.push(new Promise<false>(resolve=>{timer=setTimeout(()=>{controller!.abort();resolve(false);},timeoutMs);}));if(signal)guards.push(new Promise<false>(resolve=>{onAbort=()=>{controller!.abort();resolve(false);};signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}));verified=(await Promise.race(guards))===true&&!signal?.aborted;}catch{}finally{if(timer!==undefined)clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}if(!verified)throw Error('Invalid signed native extension plan');let body:unknown;try{body=JSON.parse(payload);}catch{throw Error('Invalid signed native extension plan');}const now=clock();if(!obj(body)||!exact(body,['tenantId','environment','issuedAt','expiresAt','plan'])||body.tenantId!==target.tenantId||body.environment!==target.environment||!Number.isSafeInteger(body.issuedAt)||Number(body.issuedAt)<0||!Number.isSafeInteger(body.expiresAt)||Number(body.expiresAt)<=Number(body.issuedAt)||Number(body.expiresAt)-Number(body.issuedAt)>86400000||!Number.isSafeInteger(now)||now<Number(body.issuedAt)||now>=Number(body.expiresAt))throw Error('Invalid signed native extension plan');return NativeComponentRegistry.fromPlan(body.plan,fixed,{applicationId:target.applicationId,revision:target.revision});
  }
  /** Resolve a host-authenticated plan against trusted installed implementations. */
  static fromPlan(plan:unknown,installed:NativeInstalledExtension[],expected:{applicationId:string;revision:number}):NativeComponentRegistry {
    const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9.-]{0,127}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value),version=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),scope=(value:unknown)=>value==='platform'||value==='development'||value==='application',keys=(value:Obj,fields:string[])=>only(value,fields)&&fields.every(field=>Object.hasOwn(value,field));
    if(!expected||typeof expected.applicationId!=='string'||!expected.applicationId.trim()||expected.applicationId.length>256||/[\u0000-\u001f\u007f]/.test(expected.applicationId)||!Number.isSafeInteger(expected.revision)||expected.revision<0||!obj(plan)||!keys(plan,['version','renderer','applicationId','revision','components'])||plan.version!==1||plan.renderer!=='react-native'||plan.applicationId!==expected.applicationId||plan.revision!==expected.revision||!Array.isArray(plan.components)||plan.components.length>1000||!Array.isArray(installed)||installed.length>256)throw Error('Invalid native extension plan');
    const available=new Map<string,NativeInstalledExtension>();for(const item of installed){if(!obj(item)||!keys(item,['id','version','scope','components'])||!name(item.id)||!version(item.version)||!scope(item.scope)||!obj(item.components))throw Error('Invalid installed native extension');const identity=JSON.stringify([item.id,item.version,item.scope]);if(available.has(identity))throw Error('Duplicate installed native extension');available.set(identity,item as NativeInstalledExtension);}
    const names=new Set<string>(),owners=new Map<string,string>(),selected:{name:string;entry:NativeExtension}[]=[];for(const item of plan.components){if(!obj(item)||!keys(item,['id','version','scope','name'])||!name(item.id)||!version(item.version)||!scope(item.scope)||!name(item.name)||names.has(item.name))throw Error('Invalid native extension plan');const identity=JSON.stringify([item.id,item.version,item.scope]),prior=owners.get(item.id);if(prior!==undefined&&prior!==identity)throw Error('Invalid native extension plan');owners.set(item.id,identity);const implementation=available.get(identity),entry=implementation&&Object.hasOwn(implementation.components,item.name)?implementation.components[item.name]:undefined;if(!entry||typeof entry.render!=='function'||typeof entry.validate!=='function')throw Error('Native extension not installed');names.add(item.name);selected.push({name:item.name,entry});}
    const registry=new NativeComponentRegistry();for(const item of selected)registry.register(item.name,item.entry.render,item.entry.validate);return registry;
  }
  register(name:string,render:NativeExtension['render'],validate:NativeExtension['validate']):void {
    if(typeof name!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(name)||['constructor','prototype','__proto__'].includes(name)||typeof render!=='function'||typeof validate!=='function'||this.entries.has(name))throw Error('Invalid or duplicate native extension');
    this.entries.set(name,{render,validate});
  }
  snapshot():Map<string,NativeExtension>{return new Map([...this.entries].map(([name,entry])=>[name,{...entry}]));}
}
function validate(c:unknown,extensions:Map<string,NativeExtension>):asserts c is Obj {
  if(!obj(c)||!id(c.id)||typeof c.component!=='string')throw Error('Invalid component');
  if(c.component==='Text'){
    if(!only(c,['id','component','text','variant'])||(!(typeof c.text==='string'&&withinCodePointLimit(c.text,10000))&&!(obj(c.text)&&only(c.text,['path'])&&typeof c.text.path==='string'&&pointer(c.text.path)))||(c.variant!==undefined&&!['h1','h2','h3','h4','h5','body','caption'].includes(c.variant as string)))throw Error('Unsupported Text');
  }else if(c.component==='Column'||c.component==='Row'){
    if(!only(c,['id','component','children','justify','align'])||!Array.isArray(c.children)||c.children.length>1000||!c.children.every(id)||(c.justify!==undefined&&!justifies.includes(c.justify as string))||(c.align!==undefined&&!aligns.includes(c.align as string)))throw Error('Unsupported layout');
  }else if(c.component==='TextField'){
    if(!only(c,['id','component','label','value','variant'])||typeof c.label!=='string'||!obj(c.value)||!only(c.value,['path'])||typeof c.value.path!=='string'||pointer(c.value.path).length===0||(c.variant!==undefined&&c.variant!=='shortText'&&c.variant!=='longText'))throw Error('Unsupported TextField');
  }else if(c.component==='Button'){
    if(!only(c,['id','component','child','action','variant'])||!id(c.child)||(c.variant!==undefined&&!['default','primary','borderless'].includes(c.variant as string))||!obj(c.action)||!only(c.action,['event'])||!obj(c.action.event)||!only(c.action.event,['name','context'])||!id(c.action.event.name)||(c.action.event.context!==undefined&&!obj(c.action.event.context)))throw Error('Unsupported Button');
    for(const [key,value] of Object.entries((c.action.event.context??{}) as Obj)){
      if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe action context');
      if(obj(value)){if(!only(value,['path'])||typeof value.path!=='string')throw Error('Unsupported action context');pointer(value.path);}
      else if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value)))throw Error('Unsupported action context');
    }
  }else if(c.component==='Card'){
    if(!only(c,['id','component','child'])||!id(c.child))throw Error('Unsupported Card');
  }else {
    const extension=extensions.get(c.component);
    if(!extension||Object.keys(c).some(key=>['key','ref','children'].includes(key)))throw Error('Unsupported component');
    const input=cloneData(c);
    const result:unknown=extension.validate(input as Obj);
    if(result instanceof Promise){result.catch(()=>{});throw Error('Native extension validator must be synchronous');}
    if(result!==true)throw Error('Invalid native extension component');
  }
}
type Surface={id:string;components:Map<string,Obj>;data:unknown;revision:number};
/** Validates and commits updates atomically. */
export class NativeSurfaceStore {
  private readonly surfaces=new Map<string,Surface>();
  private revision=0;
  private readonly extensions:Map<string,NativeExtension>;
  constructor(registry?:NativeComponentRegistry){this.extensions=registry?.snapshot()??new Map();}
  apply(message:unknown):void {
    if(!obj(message)||message.version!=='v0.9.1')throw Error('Unsupported A2UI version');
    const keys=['createSurface','updateComponents','updateDataModel','deleteSurface'].filter(key=>Object.hasOwn(message,key));
    if(keys.length!==1||!only(message,['version',keys[0]])||!obj(message[keys[0]]))throw Error('Unsupported A2UI message');
    const kind=keys[0],payload=message[kind] as Obj;
    if(!id(payload.surfaceId))throw Error('Invalid surface ID');
    const surfaceId=payload.surfaceId;
    if(kind==='createSurface'){
      if(!only(payload,['surfaceId','catalogId'])||(payload.catalogId!==APP_MIXER_CATALOG&&payload.catalogId!==BASIC_CATALOG))throw Error('Unsupported catalog');
      if(this.surfaces.has(surfaceId)||this.surfaces.size>=100)throw Error('Duplicate or excessive surfaces');
      this.surfaces.set(surfaceId,{id:surfaceId,components:new Map(),data:{},revision:++this.revision});return;
    }
    const surface=this.surfaces.get(surfaceId);if(!surface)throw Error('Unknown surface');
    if(kind==='deleteSurface'){
      if(!only(payload,['surfaceId']))throw Error('Unsupported delete property');
      this.surfaces.delete(surfaceId);return;
    }
    if(kind==='updateDataModel'){
      if(!only(payload,['surfaceId','path','value'])||(payload.path!==undefined&&typeof payload.path!=='string'))throw Error('Invalid data update');
      const data=updateData(surface.data,(payload.path as string|undefined)??'/',payload.value,!Object.hasOwn(payload,'value')||payload.value===undefined);
      this.root(surface.components,data);surface.data=data;return;
    }
    if(!only(payload,['surfaceId','components'])||!Array.isArray(payload.components)||payload.components.length<1||payload.components.length>1000)throw Error('Invalid components');
    const components=new Map(surface.components);
    for(const c of payload.components){validate(c,this.extensions);const stored=this.extensions.has(c.component as string)?cloneData(c) as Obj:{...c,...(Array.isArray(c.children)?{children:[...c.children]}:{}),...(obj(c.text)?{text:{...c.text}}:{}),...(obj(c.value)?{value:{...c.value}}:{}),...(obj(c.action)?{action:cloneData(c.action)}:{})};components.set(c.id as string,stored);}
    if(components.size>1000)throw Error('Too many components');
    this.root(components,surface.data);surface.components=components;surface.revision=++this.revision;
  }
  writeField(surfaceId:string,componentId:string,revision:number,value:string):void {
    const surface=this.surfaces.get(surfaceId),component=surface?.components.get(componentId);
    if(!surface||surface.revision!==revision||!component||component.component!=='TextField'||!obj(component.value)||typeof component.value.path!=='string')throw Error('Stale or unknown field');
    if(typeof value!=='string')throw Error('Invalid field value');
    const data=updateData(surface.data,component.value.path,value,false);this.root(surface.components,data);surface.data=data;
  }
  action(surfaceId:string,componentId:string,revision:number):ActionMessage {
    const surface=this.surfaces.get(surfaceId),component=surface?.components.get(componentId);
    if(!surface||surface.revision!==revision||!component||component.component!=='Button'||!obj(component.action)||!obj(component.action.event))throw Error('Stale or unknown button');
    const event=component.action.event,context:Record<string,unknown>={};
    for(const [key,value] of Object.entries((event.context??{}) as Obj)){
      const result=obj(value)?read(surface.data,value.path as string):value;
      if(result===undefined)throw Error('Action context path not found');context[key]=cloneData(result);
    }
    return {version:'v0.9.1',action:{name:event.name as string,surfaceId,sourceComponentId:componentId,timestamp:new Date().toISOString(),context}};
  }
  snapshot():NativeSurface[]{return [...this.surfaces.values()].map(surface=>({id:surface.id,revision:surface.revision,root:this.root(surface.components,surface.data)}));}
  /** Render-only tree. Unlike snapshot(), this retains unresolved child slots for layout. */
  renderRoot(surfaceId:string):NativeNode|undefined {const surface=this.surfaces.get(surfaceId);return surface?this.root(surface.components,surface.data,true):undefined;}
  private root(components:Map<string,Obj>,data:unknown,retainMissing=false):NativeNode|undefined {
    if(!components.has('root'))return undefined;
    let count=0;
    const visit=(key:string,ancestors:Set<string>,inButton=false):NativeNode|undefined=>{
      if(++count>5000)throw Error('Component tree too large');
      const c=components.get(key);if(!c)return retainMissing?{id:key,kind:'Missing',children:[]}:undefined;
      if(inButton&&(c.component==='Button'||c.component==='TextField'))throw Error('Interactive component inside button');
      if(ancestors.has(key)||ancestors.size>=100)throw Error('Cyclic or deeply nested components');
      const next=new Set(ancestors);next.add(key);
      const childIds=c.component==='Card'||c.component==='Button'?[c.child as string]:c.component==='Column'||c.component==='Row'?c.children as string[]:[];
      const boundText=c.component==='Text'?(typeof c.text==='string'?c.text:obj(c.text)?read(data,c.text.path as string):undefined):undefined;
      const fieldValue=c.component==='TextField'&&obj(c.value)?read(data,c.value.path as string):undefined;
      const extensionProps=this.extensions.has(c.component as string)?Object.fromEntries(Object.entries(cloneData(c) as Obj).filter(([name])=>name!=='id'&&name!=='component')):undefined;
      return {id:key,kind:c.component as string,...(extensionProps?{extensionProps}:{}),...(c.component==='Text'?{text:typeof boundText==='string'?boundText:''}:{}),...(c.component==='TextField'?{label:c.label as string,value:typeof fieldValue==='string'?fieldValue:''}:{}),...(typeof c.variant==='string'?{variant:c.variant}:{}),...(typeof c.justify==='string'?{justify:c.justify}:{}),...(typeof c.align==='string'?{align:c.align}:{}),children:childIds.map(child=>visit(child,next,inButton||c.component==='Button')).filter((child):child is NativeNode=>child!==undefined)};
    };
    return visit('root',new Set());
  }
}
type ReactRuntime={createElement:(type:any,props:any,...children:any[])=>any;useRef:<T>(value:T)=>{current:T};useState:<T>(value:T)=>[T,(value:T)=>void];useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>void};
export type NativeA2UIProps={subscribe:(receive:(message:unknown)=>void)=>void|(()=>void);onError:(error:unknown)=>void;onAction?:(message:ActionMessage)=>void};
/** The host supplies its React and React Native primitives so no framework runtime is bundled. */
export function createReactNativeA2UIComponent(React:ReactRuntime,primitives:{View:any;Text:any;TextInput?:any;Pressable?:any;Platform?:{OS:string}},registry?:NativeComponentRegistry):(props:NativeA2UIProps)=>any {
  const installed=registry?.snapshot()??new Map<string,NativeExtension>();
  const fixedRegistry=new NativeComponentRegistry();for(const [name,entry] of installed)fixedRegistry.register(name,entry.render,entry.validate);
  // Approximate the browser's default heading scale for the supported text variants.
  // React Native's default font scaling remains enabled for accessibility.
  const textStyles:Record<string,{fontSize:number;fontWeight?:'bold'}>={
    h1:{fontSize:32,fontWeight:'bold'},h2:{fontSize:24,fontWeight:'bold'},
    h3:{fontSize:18.72,fontWeight:'bold'},h4:{fontSize:16,fontWeight:'bold'},
    h5:{fontSize:13.28,fontWeight:'bold'},caption:{fontSize:13.33},body:{fontSize:16}
  };
  const justify:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'};
  const align:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',stretch:'stretch'};
  return function NativeA2UI({subscribe,onError,onAction}:NativeA2UIProps):any{
    const [surfaces,setSurfaces]=React.useState<Array<{surface:NativeSurface;key:number;renderRoot?:NativeNode}>>([]),errors=React.useRef(onError),actions=React.useRef(onAction),storeRef=React.useRef<NativeSurfaceStore|null>(null),publishRef=React.useRef<(()=>void)|null>(null),nextKey=React.useRef(0);
    React.useEffect(()=>{errors.current=onError;actions.current=onAction;},[onError,onAction]);
    React.useEffect(()=>{
      let active=true;const store=new NativeSurfaceStore(fixedRegistry),keys=new Map<string,number>();storeRef.current=store;setSurfaces([]);let stop:void|(()=>void);
      const publish=()=>setSurfaces(store.snapshot().map(surface=>({surface,key:keys.get(surface.id)!,renderRoot:store.renderRoot(surface.id)})));publishRef.current=publish;
      try{stop=subscribe(message=>{if(!active)return;try{
        if(obj(message)&&obj(message.updateComponents)&&Array.isArray(message.updateComponents.components)&&!primitives.TextInput&&message.updateComponents.components.some(c=>obj(c)&&c.component==='TextField'))throw Error('TextInput primitive is required');
        if(obj(message)&&obj(message.updateComponents)&&Array.isArray(message.updateComponents.components)&&!primitives.Pressable&&message.updateComponents.components.some(c=>obj(c)&&c.component==='Button'))throw Error('Pressable primitive is required');
        store.apply(message);
        if(obj(message)&&obj(message.createSurface))keys.set(message.createSurface.surfaceId as string,++nextKey.current);
        if(obj(message)&&obj(message.deleteSurface))keys.delete(message.deleteSurface.surfaceId as string);
        publish();
      }catch(error){errors.current(error);}});}catch(error){errors.current(error);}
      return ()=>{active=false;if(storeRef.current===store){storeRef.current=null;publishRef.current=null;}try{if(typeof stop==='function')stop();}catch(error){errors.current(error);}};
    },[subscribe]);
    const store=storeRef.current;
    const render=(node:NativeNode,surface:NativeSurface,inButton=false,inRow=false,key=node.id):any=>{
      const extension=installed.get(node.kind);
      const renderChildren=(insideButton:boolean,insideRow:boolean)=>{const occurrences=new Map<string,number>();return node.children.map(child=>{const occurrence=occurrences.get(child.id)??0;occurrences.set(child.id,occurrence+1);return render(child,surface,insideButton,insideRow,JSON.stringify([child.id,occurrence]));});};
      if(node.kind==='Missing')return React.createElement(primitives.View,{key,collapsable:false,pointerEvents:'none'});
      if(extension)return React.createElement(extension.render,{...node.extensionProps,key});
      if(node.kind==='Text')return React.createElement(primitives.Text,{key,...(node.variant?.startsWith('h')&&!inButton?{accessibilityRole:'header',accessible:true,...(primitives.Platform?.OS==='web'?{'aria-level':Number(node.variant.slice(1))}:{})}:{}),style:inRow?{...textStyles[node.variant??'body'],flexShrink:1}:textStyles[node.variant??'body']},node.text);
      if(node.kind==='Button')return React.createElement(primitives.Pressable,{key,accessibilityRole:'button',...(inRow?{style:{flexShrink:1,minWidth:0}}:{}),disabled:!onAction,onPress:()=>{
        if(!store||storeRef.current!==store||!actions.current)return;
        try{actions.current(store.action(surface.id,node.id,surface.revision));}catch(error){errors.current(error);}
      }},...renderChildren(true,false));
      if(node.kind==='TextField')return React.createElement(primitives.View,{key,...(inRow?{style:{flexShrink:1,flexGrow:1,minWidth:0}}:{})},
        React.createElement(primitives.Text,null,node.label),
        React.createElement(primitives.TextInput,{accessibilityLabel:node.label,value:node.value,multiline:node.variant==='longText',onChangeText:(value:string)=>{
          if(!store||storeRef.current!==store)return;
          try{store.writeField(surface.id,node.id,surface.revision,value);publishRef.current?.();}catch(error){errors.current(error);}
        }}));
      const style={...(inRow?{flexShrink:1,minWidth:0}:{}),...(node.kind==='Column'||node.kind==='Row'?{flexDirection:node.kind==='Column'?'column':'row',...(node.justify?{justifyContent:justify[node.justify]}:{}),...(node.align?{alignItems:align[node.align]}:{})}:{})};
      return React.createElement(primitives.View,{key,style},...renderChildren(inButton,node.kind==='Row'));
    };
    return React.createElement(primitives.View,null,...surfaces.map(({surface,key,renderRoot:root})=>React.createElement(primitives.View,{key},...(root?[render(root,surface)]:[]))));
  };
}
