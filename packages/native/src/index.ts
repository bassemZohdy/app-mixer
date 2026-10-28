/** A restricted static subset of App Mixer's A2UI v0.9.1 catalog for React Native. */
export const APP_MIXER_CATALOG='https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json';
export const BASIC_CATALOG='https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
type Obj=Record<string,unknown>;
export type NativeNode={id:string;kind:'Text'|'Column'|'Row'|'Card';text?:string;variant?:string;justify?:string;align?:string;children:NativeNode[]};
export type NativeSurface={id:string;root?:NativeNode};
const obj=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256;
const only=(value:Obj,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));
const aligns=['start','center','end','stretch'];
const justifies=['start','center','end','spaceBetween','spaceAround','spaceEvenly'];
function validate(c:unknown):asserts c is Obj {
  if(!obj(c)||!id(c.id)||typeof c.component!=='string')throw Error('Invalid component');
  if(c.component==='Text'){
    if(!only(c,['id','component','text','variant'])||(typeof c.text!=='string'||c.text.length>10000)||(c.variant!==undefined&&!['h1','h2','h3','h4','h5','body','caption'].includes(c.variant as string)))throw Error('Unsupported Text');
  }else if(c.component==='Column'||c.component==='Row'){
    if(!only(c,['id','component','children','justify','align'])||!Array.isArray(c.children)||c.children.length>1000||!c.children.every(id)||(c.justify!==undefined&&!justifies.includes(c.justify as string))||(c.align!==undefined&&!aligns.includes(c.align as string)))throw Error('Unsupported layout');
  }else if(c.component==='Card'){
    if(!only(c,['id','component','child'])||!id(c.child))throw Error('Unsupported Card');
  }else throw Error('Unsupported component');
}
type Surface={id:string;components:Map<string,Obj>};
/** Validates and commits updates atomically. Dynamic bindings and interactions are not yet supported. */
export class NativeSurfaceStore {
  private readonly surfaces=new Map<string,Surface>();
  apply(message:unknown):void {
    if(!obj(message)||message.version!=='v0.9.1')throw Error('Unsupported A2UI version');
    const keys=['createSurface','updateComponents','deleteSurface'].filter(key=>Object.hasOwn(message,key));
    if(keys.length!==1||!only(message,['version',keys[0]])||!obj(message[keys[0]]))throw Error('Unsupported A2UI message');
    const kind=keys[0],payload=message[kind] as Obj;
    if(!id(payload.surfaceId))throw Error('Invalid surface ID');
    const surfaceId=payload.surfaceId;
    if(kind==='createSurface'){
      if(!only(payload,['surfaceId','catalogId'])||(payload.catalogId!==APP_MIXER_CATALOG&&payload.catalogId!==BASIC_CATALOG))throw Error('Unsupported catalog');
      if(this.surfaces.has(surfaceId)||this.surfaces.size>=100)throw Error('Duplicate or excessive surfaces');
      this.surfaces.set(surfaceId,{id:surfaceId,components:new Map()});return;
    }
    const surface=this.surfaces.get(surfaceId);if(!surface)throw Error('Unknown surface');
    if(kind==='deleteSurface'){
      if(!only(payload,['surfaceId']))throw Error('Unsupported delete property');
      this.surfaces.delete(surfaceId);return;
    }
    if(!only(payload,['surfaceId','components'])||!Array.isArray(payload.components)||payload.components.length<1||payload.components.length>1000)throw Error('Invalid components');
    const components=new Map(surface.components);
    for(const c of payload.components){validate(c);components.set(c.id as string,{...c,...(Array.isArray(c.children)?{children:[...c.children]}:{})});}
    if(components.size>1000)throw Error('Too many components');
    this.root(components);surface.components=components;
  }
  snapshot():NativeSurface[]{return [...this.surfaces.values()].map(surface=>({id:surface.id,root:this.root(surface.components)}));}
  private root(components:Map<string,Obj>):NativeNode|undefined {
    if(!components.has('root'))return undefined;
    let count=0;
    const visit=(key:string,ancestors:Set<string>):NativeNode|undefined=>{
      if(++count>5000)throw Error('Component tree too large');
      const c=components.get(key);if(!c)return undefined;
      if(ancestors.has(key)||ancestors.size>=100)throw Error('Cyclic or deeply nested components');
      const next=new Set(ancestors);next.add(key);
      const childIds=c.component==='Card'?[c.child as string]:c.component==='Column'||c.component==='Row'?c.children as string[]:[];
      return {id:key,kind:c.component as NativeNode['kind'],...(typeof c.text==='string'?{text:c.text}:{}),...(typeof c.variant==='string'?{variant:c.variant}:{}),...(typeof c.justify==='string'?{justify:c.justify}:{}),...(typeof c.align==='string'?{align:c.align}:{}),children:childIds.map(child=>visit(child,next)).filter((child):child is NativeNode=>child!==undefined)};
    };
    return visit('root',new Set());
  }
}
type ReactRuntime={createElement:(type:any,props:any,...children:any[])=>any;useRef:<T>(value:T)=>{current:T};useState:<T>(value:T)=>[T,(value:T)=>void];useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>void};
export type NativeA2UIProps={subscribe:(receive:(message:unknown)=>void)=>void|(()=>void);onError:(error:unknown)=>void};
/** The host supplies its React and React Native primitives so no framework runtime is bundled. */
export function createReactNativeA2UIComponent(React:ReactRuntime,primitives:{View:any;Text:any}):(props:NativeA2UIProps)=>any {
  const justify:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'};
  const align:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',stretch:'stretch'};
  const render=(node:NativeNode):any=>{
    if(node.kind==='Text')return React.createElement(primitives.Text,{key:node.id,...(node.variant?.startsWith('h')?{accessibilityRole:'header'}:{})},node.text);
    const style=node.kind==='Column'||node.kind==='Row'?{flexDirection:node.kind==='Column'?'column':'row',...(node.justify?{justifyContent:justify[node.justify]}:{}),...(node.align?{alignItems:align[node.align]}:{})}:undefined;
    return React.createElement(primitives.View,{key:node.id,style},...node.children.map(render));
  };
  return function NativeA2UI({subscribe,onError}:NativeA2UIProps):any{
    const [surfaces,setSurfaces]=React.useState<NativeSurface[]>([]),errors=React.useRef(onError);
    React.useEffect(()=>{errors.current=onError;},[onError]);
    React.useEffect(()=>{
      let active=true;const store=new NativeSurfaceStore();setSurfaces([]);let stop:void|(()=>void);
      try{stop=subscribe(message=>{if(!active)return;try{store.apply(message);setSurfaces(store.snapshot());}catch(error){errors.current(error);}});}catch(error){errors.current(error);}
      return ()=>{active=false;if(typeof stop==='function')stop();};
    },[subscribe]);
    return React.createElement(primitives.View,null,...surfaces.map(surface=>React.createElement(primitives.View,{key:surface.id},...(surface.root?[render(surface.root)]:[]))));
  };
}
