/** A restricted static subset of App Mixer's A2UI v0.9.1 catalog for React Native. */
export const APP_MIXER_CATALOG='https://raw.githubusercontent.com/bassemZohdy/app-mixer/main/packages/web/catalog/v1/catalog.json';
export const BASIC_CATALOG='https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
type Obj=Record<string,unknown>;
export type NativeNode={id:string;kind:'Text'|'Column'|'Row'|'Card'|'TextField';text?:string;variant?:string;justify?:string;align?:string;label?:string;value?:string;children:NativeNode[]};
export type NativeSurface={id:string;revision:number;root?:NativeNode};
const obj=(value:unknown):value is Obj=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256;
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
  for(const key of pointer(path)){if(!obj(current)&&!Array.isArray(current))return undefined;if(!Object.hasOwn(current,key))return undefined;current=(current as Record<string,unknown>)[key];}
  return current;
}
function updateData(data:unknown,path:string,value:unknown,remove:boolean):unknown {
  const keys=pointer(path);if(!keys.length)return remove?{}:cloneData(value);
  const root=cloneData(data);let current=root;
  for(let i=0;i<keys.length-1;i++){
    const key=keys[i];if(!obj(current)&&!Array.isArray(current))throw Error('Data path parent does not exist');
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
function validate(c:unknown):asserts c is Obj {
  if(!obj(c)||!id(c.id)||typeof c.component!=='string')throw Error('Invalid component');
  if(c.component==='Text'){
    if(!only(c,['id','component','text','variant'])||(!(typeof c.text==='string'&&c.text.length<=10000)&&!(obj(c.text)&&only(c.text,['path'])&&typeof c.text.path==='string'&&pointer(c.text.path)))||(c.variant!==undefined&&!['h1','h2','h3','h4','h5','body','caption'].includes(c.variant as string)))throw Error('Unsupported Text');
  }else if(c.component==='Column'||c.component==='Row'){
    if(!only(c,['id','component','children','justify','align'])||!Array.isArray(c.children)||c.children.length>1000||!c.children.every(id)||(c.justify!==undefined&&!justifies.includes(c.justify as string))||(c.align!==undefined&&!aligns.includes(c.align as string)))throw Error('Unsupported layout');
  }else if(c.component==='TextField'){
    if(!only(c,['id','component','label','value','variant'])||typeof c.label!=='string'||!obj(c.value)||!only(c.value,['path'])||typeof c.value.path!=='string'||pointer(c.value.path).length===0||(c.variant!==undefined&&c.variant!=='shortText'&&c.variant!=='longText'))throw Error('Unsupported TextField');
  }else if(c.component==='Card'){
    if(!only(c,['id','component','child'])||!id(c.child))throw Error('Unsupported Card');
  }else throw Error('Unsupported component');
}
type Surface={id:string;components:Map<string,Obj>;data:unknown;revision:number};
/** Validates and commits updates atomically. Button actions are not yet supported. */
export class NativeSurfaceStore {
  private readonly surfaces=new Map<string,Surface>();
  private revision=0;
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
    for(const c of payload.components){validate(c);components.set(c.id as string,{...c,...(Array.isArray(c.children)?{children:[...c.children]}:{}),...(obj(c.text)?{text:{...c.text}}:{}),...(obj(c.value)?{value:{...c.value}}:{})});}
    if(components.size>1000)throw Error('Too many components');
    this.root(components,surface.data);surface.components=components;surface.revision=++this.revision;
  }
  writeField(surfaceId:string,componentId:string,revision:number,value:string):void {
    const surface=this.surfaces.get(surfaceId),component=surface?.components.get(componentId);
    if(!surface||surface.revision!==revision||!component||component.component!=='TextField'||!obj(component.value)||typeof component.value.path!=='string')throw Error('Stale or unknown field');
    if(typeof value!=='string')throw Error('Invalid field value');
    const data=updateData(surface.data,component.value.path,value,false);this.root(surface.components,data);surface.data=data;
  }
  snapshot():NativeSurface[]{return [...this.surfaces.values()].map(surface=>({id:surface.id,revision:surface.revision,root:this.root(surface.components,surface.data)}));}
  private root(components:Map<string,Obj>,data:unknown):NativeNode|undefined {
    if(!components.has('root'))return undefined;
    let count=0;
    const visit=(key:string,ancestors:Set<string>):NativeNode|undefined=>{
      if(++count>5000)throw Error('Component tree too large');
      const c=components.get(key);if(!c)return undefined;
      if(ancestors.has(key)||ancestors.size>=100)throw Error('Cyclic or deeply nested components');
      const next=new Set(ancestors);next.add(key);
      const childIds=c.component==='Card'?[c.child as string]:c.component==='Column'||c.component==='Row'?c.children as string[]:[];
      const boundText=typeof c.text==='string'?c.text:obj(c.text)?read(data,c.text.path as string):undefined;
      const fieldValue=c.component==='TextField'&&obj(c.value)?read(data,c.value.path as string):undefined;
      return {id:key,kind:c.component as NativeNode['kind'],...(c.component==='Text'?{text:typeof boundText==='string'?boundText:''}:{}),...(c.component==='TextField'?{label:c.label as string,value:typeof fieldValue==='string'?fieldValue:''}:{}),...(typeof c.variant==='string'?{variant:c.variant}:{}),...(typeof c.justify==='string'?{justify:c.justify}:{}),...(typeof c.align==='string'?{align:c.align}:{}),children:childIds.map(child=>visit(child,next)).filter((child):child is NativeNode=>child!==undefined)};
    };
    return visit('root',new Set());
  }
}
type ReactRuntime={createElement:(type:any,props:any,...children:any[])=>any;useRef:<T>(value:T)=>{current:T};useState:<T>(value:T)=>[T,(value:T)=>void];useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>void};
export type NativeA2UIProps={subscribe:(receive:(message:unknown)=>void)=>void|(()=>void);onError:(error:unknown)=>void};
/** The host supplies its React and React Native primitives so no framework runtime is bundled. */
export function createReactNativeA2UIComponent(React:ReactRuntime,primitives:{View:any;Text:any;TextInput?:any}):(props:NativeA2UIProps)=>any {
  const justify:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',spaceBetween:'space-between',spaceAround:'space-around',spaceEvenly:'space-evenly'};
  const align:Record<string,string>={start:'flex-start',center:'center',end:'flex-end',stretch:'stretch'};
  return function NativeA2UI({subscribe,onError}:NativeA2UIProps):any{
    const [surfaces,setSurfaces]=React.useState<NativeSurface[]>([]),errors=React.useRef(onError),storeRef=React.useRef<NativeSurfaceStore|null>(null);
    React.useEffect(()=>{errors.current=onError;},[onError]);
    React.useEffect(()=>{
      let active=true;const store=new NativeSurfaceStore();storeRef.current=store;setSurfaces([]);let stop:void|(()=>void);
      try{stop=subscribe(message=>{if(!active)return;try{
        if(obj(message)&&obj(message.updateComponents)&&Array.isArray(message.updateComponents.components)&&!primitives.TextInput&&message.updateComponents.components.some(c=>obj(c)&&c.component==='TextField'))throw Error('TextInput primitive is required');
        store.apply(message);setSurfaces(store.snapshot());
      }catch(error){errors.current(error);}});}catch(error){errors.current(error);}
      return ()=>{active=false;if(storeRef.current===store)storeRef.current=null;if(typeof stop==='function')stop();};
    },[subscribe]);
    const store=storeRef.current;
    const render=(node:NativeNode,surface:NativeSurface):any=>{
      if(node.kind==='Text')return React.createElement(primitives.Text,{key:node.id,...(node.variant?.startsWith('h')?{accessibilityRole:'header'}:{})},node.text);
      if(node.kind==='TextField')return React.createElement(primitives.View,{key:node.id},
        React.createElement(primitives.Text,null,node.label),
        React.createElement(primitives.TextInput,{accessibilityLabel:node.label,value:node.value,multiline:node.variant==='longText',onChangeText:(value:string)=>{
          if(!store||storeRef.current!==store)return;
          try{store.writeField(surface.id,node.id,surface.revision,value);setSurfaces(store.snapshot());}catch(error){errors.current(error);}
        }}));
      const style=node.kind==='Column'||node.kind==='Row'?{flexDirection:node.kind==='Column'?'column':'row',...(node.justify?{justifyContent:justify[node.justify]}:{}),...(node.align?{alignItems:align[node.align]}:{})}:undefined;
      return React.createElement(primitives.View,{key:node.id,style},...node.children.map(child=>render(child,surface)));
    };
    return React.createElement(primitives.View,null,...surfaces.map(surface=>React.createElement(primitives.View,{key:surface.id},...(surface.root?[render(surface.root,surface)]:[]))));
  };
}
