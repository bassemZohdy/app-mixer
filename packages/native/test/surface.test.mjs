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
  update('a',[{id:'root',component:'Text',text:{path:'relative'}}]),
  update('a',[{id:'root',component:'Column',children:['root']}]),
  {version:'v0.9.1',updateDataModel:{surfaceId:'a',path:'/__proto__/polluted',value:'x'}}
 ])assert.throws(()=>store.apply(invalid));
 assert.equal(store.snapshot()[0].root.text,'Safe');
});
test('rejects expanded trees over the resource limit',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));
 const components=[{id:'root',component:'Column',children:Array(1000).fill('branch')},{id:'branch',component:'Column',children:Array(6).fill('leaf')},{id:'leaf',component:'Text',text:'x'}];
 assert.throws(()=>store.apply(update('a',components)),/tree too large/);assert.equal(store.snapshot()[0].root,undefined);
});

test('bound text follows data updates while unsafe paths leave state unchanged',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));
 store.apply(update('a',[{id:'root',component:'Text',text:{path:'/person/name'}}]));
 const data=(path,value)=>({version:'v0.9.1',updateDataModel:{surfaceId:'a',path,value}});
 store.apply(data('/person/name','Ada'));assert.equal(store.snapshot()[0].root.text,'Ada');
 assert.throws(()=>store.apply(data('/person/__proto__/x','bad')),/Unsafe/);assert.equal(store.snapshot()[0].root.text,'Ada');
 store.apply({version:'v0.9.1',updateDataModel:{surfaceId:'a',path:'/person/name'}});assert.equal(store.snapshot()[0].root.text,'');
});

test('field writes are isolated and reject stale callbacks',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));
 store.apply(update('a',[{id:'root',component:'TextField',label:'Name',value:{path:'/name'}}]));
 const first=store.snapshot()[0];store.writeField('a','root',first.revision,'Ada');store.writeField('a','root',first.revision,'Grace');
 assert.equal(store.snapshot()[0].root.value,'Grace');
 assert.throws(()=>store.apply(update('a',[{id:'root',component:'TextField',label:'Unsafe',value:{path:'/__proto__/x'}}])),/Unsafe/);
 store.apply(remove('a'));store.apply(create('a'));store.apply(update('a',[{id:'root',component:'TextField',label:'New',value:{path:'/name'}}]));
 assert.throws(()=>store.writeField('a','root',first.revision,'stale'),/Stale/);assert.equal(store.snapshot()[0].root.value,'');
});

test('buttons resolve only explicit context and reject stale action callbacks',()=>{
 const store=new NativeSurfaceStore();store.apply(create('a'));
 store.apply({version:'v0.9.1',updateDataModel:{surfaceId:'a',value:{form:{name:'Ada',secret:'private'}}}});
 store.apply(update('a',[{id:'root',component:'Button',child:'label',action:{event:{name:'save',context:{name:{path:'/form/name'},source:'screen'}}}},{id:'label',component:'Text',text:'Save'}]));
 const revision=store.snapshot()[0].revision;
 const action=store.action('a','root',revision);assert.deepEqual(action.action.context,{name:'Ada',source:'screen'});assert.equal(action.action.sourceComponentId,'root');
 store.apply({version:'v0.9.1',updateDataModel:{surfaceId:'a',path:'/form/name',value:'Grace'}});assert.equal(store.action('a','root',revision).action.context.name,'Grace');
 store.apply(update('a',[{id:'root',component:'Button',child:'label',action:{event:{name:'other'}}}]));assert.throws(()=>store.action('a','root',revision),/Stale/);
 assert.throws(()=>store.apply(update('a',[{id:'root',component:'Button',child:'label',action:{event:{name:'bad',context:{x:{path:'/__proto__/x'}}}}}])),/Unsafe/);
});
