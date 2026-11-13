import {AppMixerError} from './errors.js';
import type {ApplicationDefinition,Component} from './index.js';

// The rules of the renderers (the web renderer and the generated workspace), so a definition they would refuse is refused before it is stored or published.
// `validate` in index.ts stays structural: a definition stored before these rules existed must still be read, so it can be repaired.
const TEXT_VARIANTS=['h1','h2','h3','h4','h5','body','caption'],INPUT_VARIANTS=['shortText','longText'];
const quoted=(value:unknown):string=>JSON.stringify(String(value).slice(0,64));
/** Number of segments of an absolute JSON pointer as the renderers read it (0 is the root), or undefined when they refuse it. */
function pointerDepth(path:unknown):number|undefined {
 if(typeof path!=='string')return undefined;
 if(path===''||path==='/')return 0;
 if(!path.startsWith('/'))return undefined;
 const segments=path.slice(1).split('/');
 for(const segment of segments)if(/~(?![01])/.test(segment)||['__proto__','prototype','constructor'].includes(segment.replace(/~1/g,'/').replace(/~0/g,'~')))return undefined;
 return segments.length;
}
/** What a renderer refuses about one component, or undefined. A Table has no renderer yet: it is a valid draft component and is refused only when publishing. */
function issue(component:Component,publishing:boolean):string|undefined {
 const props:unknown=component.props;
 if(props!==undefined&&(props===null||typeof props!=='object'||Array.isArray(props)))return `${component.type} properties must be an object`;
 const values=(props??{}) as Record<string,unknown>,other=(allowed:string[])=>Object.keys(values).find(key=>!allowed.includes(key));
 switch(component.type){
  case 'Text':{
   // The renderer counts Unicode code points, not UTF-16 units.
   if(!Object.hasOwn(values,'path')){const text=String(values.text??'');return text.length<=10000||[...text].length<=10000?undefined:'Text property text must be at most 10000 characters';}
   if(Object.hasOwn(values,'text'))return 'Text property text cannot be combined with path';
   const extra=other(['path','variant']);if(extra!==undefined)return `Text property ${quoted(extra)} is not supported with path`;
   if(pointerDepth(values.path)===undefined)return 'Text property path must be an absolute JSON pointer, such as /greeting';
   if(values.variant!==undefined&&!TEXT_VARIANTS.includes(values.variant as string))return 'Text property variant must be one of '+TEXT_VARIANTS.join(', ');
   return undefined;
  }
  case 'Card':{
   const extra=other(['title','text']);if(extra!==undefined)return `Card property ${quoted(extra)} is not supported`;
   for(const name of ['title','text'])if(values[name]!==undefined&&(typeof values[name]!=='string'||values[name].length>10000))return `Card property ${name} must be text of at most 10000 characters`;
   return undefined;
  }
  case 'Input':{
   const extra=other(['label','path','variant']);if(extra!==undefined)return `Input property ${quoted(extra)} is not supported`;
   if(typeof values.label!=='string')return 'Input property label must be text';
   if(!pointerDepth(values.path))return 'Input property path must be an absolute JSON pointer to a field, such as /name';
   if(values.variant!==undefined&&!INPUT_VARIANTS.includes(values.variant as string))return 'Input property variant must be '+INPUT_VARIANTS.join(' or ');
   return undefined;
  }
  case 'Table':return publishing?'Table cannot be published because no renderer supports it yet':undefined;
  default:return undefined;
 }
}
const refusal=(pageId:unknown,component:Component,reason:string):AppMixerError=>new AppMixerError('invalid',`Invalid component ${quoted(component.id)} on page ${quoted(pageId)}: ${reason}`);

/** Refuses a definition holding a component no renderer can show, naming the component and the property. */
export function validatePublishable(definition:ApplicationDefinition):void {
 for(const page of definition.pages)for(const component of page.components){const reason=issue(component,true);if(reason)throw refusal(page.id,component,reason);}
}
/**
 * Refuses a draft change that adds an unrenderable component or rewrites one into another unrenderable state.
 * A component stored that way before the change is left alone, so such a draft still opens and can be repaired one patch at a time; publishing refuses it.
 */
export function validateDraftChange(previous:ApplicationDefinition,candidate:ApplicationDefinition):void {
 const stored=new Set<string>();
 for(const page of previous.pages)for(const component of page.components)if(issue(component,false))stored.add(JSON.stringify([page.id,component]));
 for(const page of candidate.pages)for(const component of page.components){const reason=issue(component,false);if(reason&&!stored.has(JSON.stringify([page.id,component])))throw refusal(page.id,component,reason);}
}
