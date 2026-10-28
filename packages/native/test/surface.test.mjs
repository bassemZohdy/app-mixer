import test from 'node:test';
import assert from 'node:assert/strict';
import {APP_MIXER_CATALOG,NativeSurfaceStore} from '../dist/index.js';
const create=id=>({version:'v0.9.1',createSurface:{surfaceId:id,catalogId:APP_MIXER_CATALOG}});
const update=(id,components)=>({version:'v0.9.1',updateComponents:{surfaceId:id,components}});
const remove=id=>({version:'v0.9.1',deleteSurface:{surfaceId:id}});
test('renders static layouts incrementally and isolates surfaces',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));store.apply(create('b'));
 const components=[{id:'root',component:'Row',children:['title','later'],justify:'spaceBetween'},{id:'title',component:'Text',text:'<safe>',variant:'h1'}];
 store.apply(update('a',components));components[0].children[0]='tampered';
 store.apply(update('b',[{id:'root',component:'Card',child:'text'},{id:'text',component:'Text',text:'Other'}]));
 store.apply(update('a',[{id:'later',component:'Text',text:'Loaded'}]));
 let surfaces=store.snapshot();assert.deepEqual(surfaces[0].root.children.map(x=>x.text),['<safe>','Loaded']);assert.equal(surfaces[1].root.children[0].text,'Other');
 surfaces[0].root.children[0].text='tampered';assert.equal(store.snapshot()[0].root.children[0].text,'<safe>');store.apply(remove('a'));assert.equal(store.snapshot()[0].id,'b');
});
test('rejects incompatible and cyclic updates atomically',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));store.apply(update('a',[{id:'root',component:'Text',text:'Safe'}]));
 for(const invalid of [
  update('a',[{id:'root',component:'Button',child:'x'}]),
  update('a',[{id:'root',component:'Text',text:{path:'/name'}}]),
  update('a',[{id:'root',component:'Column',children:['root']}]),
  {version:'v0.9.1',updateDataModel:{surfaceId:'a',value:{name:'Ada'}}}
 ])assert.throws(()=>store.apply(invalid));
 assert.equal(store.snapshot()[0].root.text,'Safe');
});
test('rejects expanded trees over the resource limit',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));
 const components=[{id:'root',component:'Column',children:Array(1000).fill('branch')},{id:'branch',component:'Column',children:Array(6).fill('leaf')},{id:'leaf',component:'Text',text:'x'}];
 assert.throws(()=>store.apply(update('a',components)),/tree too large/);assert.equal(store.snapshot()[0].root,undefined);
});
