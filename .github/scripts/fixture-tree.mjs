// Shared fixtures for the React and Angular bridge smoke tests: the same files the web renderer, the React Native store
// and the Flutter renderer are checked against (adapters/flutter/test/fixtures).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export const fixtureSteps=name=>JSON.parse(readFileSync(new URL(`../../adapters/flutter/test/fixtures/${name}.json`,import.meta.url),'utf8'));
const textTags={H1:'h1',H2:'h2',H3:'h3',H4:'h4',H5:'h5',SMALL:'caption',P:'body'};
const style=value=>value===''||value===undefined?null:value;
// Reads a rendered DOM node back into the fixture tree shape; the layout fixture has no variants, the variants one does.
// A child that is referenced before it exists renders as an empty placeholder span, which the fixtures leave out.
const placeholder=node=>node.tagName==='SPAN'&&!node.children.length&&!node.textContent;
const kids=(node,variants)=>[...node.children].filter(child=>!placeholder(child)).map(child=>domTree(child,variants));
export function domTree(node,variants){
 const tag=node.tagName;
 if(tag==='SECTION')return {kind:'Card',children:kids(node,variants)};
 if(tag==='DIV')return {kind:node.style.flexDirection==='row'?'Row':'Column',justify:style(node.style.justifyContent),align:style(node.style.alignItems),children:kids(node,variants)};
 if(tag==='LABEL')return {kind:'TextField',variant:node.children[1].tagName==='TEXTAREA'?'longText':'shortText',label:node.children[0].textContent,children:[]};
 if(tag==='BUTTON')return {kind:'Button',children:kids(node,variants)};
 assert.ok(Object.hasOwn(textTags,tag),'unexpected element '+tag);
 return {kind:'Text',...(variants?{variant:textTags[tag]}:{}),text:node.textContent,children:[]};
}
// The root component of the only surface inside a bridge's container, or null before one exists.
export function surfaceRoot(container){const surface=container.querySelector('[data-surface-id]');return surface?.firstElementChild??null;}

// The React Native components rendered by react-native-web: one view holds the surfaces, each surface is a view.
export function nativeWebSurfaceRoot(container){const surfaces=container.querySelector('[class^="css-view"]');return surfaces?.firstElementChild?.firstElementChild??null;}
// Text variants come back from the text styles the React Native renderer applies (bold separates h4 from body).
const nativeTextVariant=node=>{const size=node.style.fontSize,bold=node.style.fontWeight==='bold';return {'32px':'h1','24px':'h2','18.72px':'h3','13.28px':'h5','13.33px':'caption'}[size]??(size==='16px'?(bold?'h4':'body'):'unknown '+size);};
export function nativeWebTree(node,variants){
 const children=()=>[...node.children].map(child=>nativeWebTree(child,variants));
 if(node.getAttribute('role')==='button')return {kind:'Button',children:children()};
 if((node.getAttribute('class')??'').startsWith('css-text')){const variant=nativeTextVariant(node);assert.equal(node.getAttribute('role')==='heading',variant.startsWith('h'),'heading role matches the variant');return {kind:'Text',...(variants?{variant}:{}),text:node.textContent,children:[]};}
 const field=node.children[1];if(field&&(field.tagName==='INPUT'||field.tagName==='TEXTAREA'))return {kind:'TextField',variant:field.tagName==='TEXTAREA'?'longText':'shortText',label:field.getAttribute('aria-label'),children:[]};
 if(node.style.flexDirection)return {kind:node.style.flexDirection==='row'?'Row':'Column',justify:style(node.style.justifyContent),align:style(node.style.alignItems),children:children()};
 return {kind:'Card',children:children()};
}
const remove={version:'v0.9.1',deleteSurface:{surfaceId:'main'}};
const surfaceRootOf=container=>surfaceRoot(container),domTreeOf=(node,variants)=>domTree(node,variants);
// Replays the shared fixtures through a bridge: deliver(message) feeds its subscription, actions() and errors() return
// what its action and error callbacks received so far. The DOM is checked after every step.
export async function replayFixtures(deliver,container,{actions,errors,root:surfaceRoot=surfaceRootOf,tree:domTree=domTreeOf}){
 for(const [name,variants] of [['layout',false],['variants',true]]){
  for(const step of fixtureSteps(name)){await deliver(step.message);const root=surfaceRoot(container);assert.deepEqual(root?domTree(root,variants):null,step.tree,name);}
  await deliver(remove);
 }
 // Typing into the field updates the bound text through the bridge, as on the other adapters.
 for(const step of fixtureSteps('text-field')){
  if(step.message)await deliver(step.message);
  else await deliver.type(surfaceRoot(container).children[0].children[1],step.input);
  const root=surfaceRoot(container),wrapper=root?.children[0],input=wrapper?.children[1];
  assert.deepEqual(root?{field:{label:wrapper.children[0].textContent,value:input.value,variant:input.tagName==='TEXTAREA'?'longText':null},text:root.children[1].textContent}:{field:null,text:null},{field:step.field,text:step.text},'text-field '+JSON.stringify(step.input??step.message));
 }
 await deliver(remove);
 for(const step of fixtureSteps('bindings')){await deliver(step.message);assert.equal(surfaceRoot(container)?.textContent??null,step.text,'bindings');}
 await deliver(remove);
 const fixture=fixtureSteps('actions'),before=actions().length;for(const message of fixture.messages)await deliver(message);
 await deliver.click(surfaceRoot(container));assert.equal(actions().length,before+1,'one action');const {timestamp,...action}=actions().at(-1).action;assert.equal(typeof timestamp,'string');assert.deepEqual(action,fixture.action,'actions');
 await deliver(remove);
 // Invalid messages reach the bridge's error callback and leave the last good surface in place.
 await deliver({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:fixtureSteps('layout')[0].message.createSurface.catalogId}});await deliver({version:'v0.9.1',updateComponents:{surfaceId:'main',components:[{id:'root',component:'Text',text:'Safe'}]}});
 const rejected=fixtureSteps('rejections'),failures=errors().length;for(const invalid of rejected){await deliver(invalid);assert.equal(surfaceRoot(container).textContent,'Safe','rejections');}
 assert.equal(errors().length,failures+rejected.length,'every rejection is reported');await deliver(remove);
}
