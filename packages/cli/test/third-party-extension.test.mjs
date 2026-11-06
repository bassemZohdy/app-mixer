// A third-party extension package authored and packed outside this repository is installed into a generated
// application with npm, approved with a pinned digest of the installed tarball, published, rendered by the generated
// workspace, used as a tool, and revoked. Each step is reported as a test diagnostic so the run is the transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {createProject} from '../dist/index.js';
import {ExtensionRegistry,SqliteApplicationStore,computeExtensionIntegrity,createExtensionPublicationGuard,createExtensionRuntime} from '../../core/dist/index.js';

// npm without a shell: the npm CLI script next to this Node on Windows, npm itself elsewhere.
const npmCli=process.env.npm_execpath?.endsWith('.js')?process.env.npm_execpath:process.platform==='win32'?join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'):undefined;
const npm=(args,cwd)=>new Promise((resolve,reject)=>execFile(npmCli?process.execPath:'npm',npmCli?[npmCli,...args]:args,{cwd,timeout:180000,env:{...process.env,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'}},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout.trim())));

// The package as a third party would publish it: its own manifest (without a digest of itself) and trusted code.
const packageFiles={
 'package.json':JSON.stringify({name:'acme-chart-extension',version:'1.2.0',type:'module',exports:{'.':'./index.mjs','./manifest.json':'./manifest.json'},files:['index.mjs','manifest.json'],license:'Apache-2.0'},null,2),
 'manifest.json':JSON.stringify({manifestVersion:1,id:'acme.chart',version:'1.2.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['web'],components:['chart'],tools:['summarize'],providers:[],permissions:['read.data']},null,2),
 'index.mjs':`export const components={chart:{
 render(component,_child,_data,document){const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=component.title+': '+component.values.split(',').join(', ');figure.dataset.acme='chart';figure.appendChild(caption);return figure;},
 validate(component){if(typeof component.title!=='string'||typeof component.values!=='string'||!/^-?[0-9]+(,-?[0-9]+)*$/.test(component.values))throw Error('Invalid acme chart');}
}};
export const tools={summarize:input=>({count:input.values.length,total:input.values.reduce((sum,value)=>sum+value,0)})};
`};

test('a third-party extension package is installed, approved, used and revoked in a generated application',{timeout:300000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'app-mixer-third-party-')),source=join(root,'acme-chart-extension'),packed=join(root,'packed');
 try{
  // 1. The vendor builds the package outside this repository.
  await mkdir(source);await mkdir(packed);for(const [name,text] of Object.entries(packageFiles))await writeFile(join(source,name),text);
  await npm(['pack','--pack-destination',packed],source);const [tarballName]=await readdir(packed),tarball=join(packed,tarballName);
  t.diagnostic('packed '+tarballName+' outside the repository');

  // 2. The host generates an application and installs the package from the tarball with npm.
  const app=await createProject('host-app',root);await npm(['install','--offline','--ignore-scripts',tarball],app);
  const installedPackage=JSON.parse(await readFile(join(app,'node_modules','acme-chart-extension','package.json'),'utf8'));assert.equal(installedPackage.version,'1.2.0');
  t.diagnostic('installed acme-chart-extension@'+installedPackage.version+' into the generated app');

  // 3. The host approves exactly that tarball: its digest goes into the manifest the host trusts and into the approval pin.
  const bytes=new Uint8Array(await readFile(tarball)),integrity=computeExtensionIntegrity(bytes);
  const vendorManifest=JSON.parse(await readFile(join(app,'node_modules','acme-chart-extension','manifest.json'),'utf8')),manifest={...vendorManifest,integrity};
  const reference={id:manifest.id,version:manifest.version,scope:manifest.scope},approval={...reference,permissions:['read.data'],integrity};
  const host={runtimeVersion:'0.1.0',renderer:'web',approved:[approval]};
  // The generated app's host-owned extensions.mjs imports the installed package by name.
  await writeFile(join(app,'extensions.mjs'),`// Trusted host code only: the approved acme-chart-extension package.\nimport {components} from 'acme-chart-extension';\nexport const installedExtensions=[{id:'acme.chart',version:'1.2.0',scope:'application',components}];\n`);
  const vendor=await import(pathToFileURL(join(app,'node_modules','acme-chart-extension','index.mjs')).href);
  // Registry bindings name the trusted implementations; the web renderer itself is installed through extensions.mjs.
  const bindings={components:{chart:vendor.components.chart.render},tools:vendor.tools,providers:{}},registry=new ExtensionRegistry(host);
  assert.throws(()=>new ExtensionRegistry(host).register(manifest,bindings,undefined,{packageBytes:new TextEncoder().encode('tampered')}),/integrity/i,'a different package is refused');
  registry.register(manifest,bindings,undefined,{packageBytes:bytes});
  t.diagnostic('approved acme.chart@1.2.0 pinned to '+integrity);

  // 4. The application references the extension component and tool, and publishes through the host's guard.
  const initial={id:'host-app',schemaVersion:1,revision:0,pages:[{id:'home',title:'Home',route:'/',components:[]}]};
  const requirements=()=>({components:['chart'],tools:['summarize'],providers:[]}),guard=createExtensionPublicationGuard(registry.getManifests(),host,requirements);
  const patch=[{op:'setExtensions',extensions:[reference]},{op:'addComponent',pageId:'home',component:{id:'sales',type:'Extension',extensionId:reference.id,name:'chart',props:{title:'Sales',values:'3,4,5'}}},{op:'setExtensionOperations',operations:[{extensionId:reference.id,kind:'tool',name:'summarize'}]}];
  const store=new SqliteApplicationStore(join(root,'application.sqlite'),initial,guard);let publication;
  try{store.apply(0,patch);publication=store.publish(1);}finally{store.close();}
  assert.equal(publication.version,1);t.diagnostic('published version '+publication.version+' with the extension component and tool');

  // 5. The generated workspace renders the component from the installed package.
  const {prepareWorkspace}=await import(pathToFileURL(join(app,'workspace.mjs')).href),{A2UIRenderer,APP_MIXER_CATALOG}=await import(pathToFileURL(join(app,'renderer.mjs')).href);
  const dom=new JSDOM('<!doctype html><main></main>'),main=dom.window.document.querySelector('main');
  try{
   const {registry:components,components:tree}=prepareWorkspace(publication.definition),renderer=new A2UIRenderer(main,components);
   renderer.apply({version:'v0.9.1',createSurface:{surfaceId:'main',catalogId:APP_MIXER_CATALOG}});renderer.apply({version:'v0.9.1',updateComponents:{surfaceId:'main',components:tree}});
   const figure=main.querySelector('figure[data-acme="chart"]');assert.ok(figure,main.innerHTML);assert.equal(figure.textContent,'Sales: 3, 4, 5');
   assert.throws(()=>prepareWorkspace({...publication.definition,pages:[{...publication.definition.pages[0],components:[{...publication.definition.pages[0].components[0],props:{title:'Sales',values:'x'}}]}]}),/Invalid acme chart/);
  }finally{dom.window.close();}
  t.diagnostic('rendered the acme chart in the generated workspace');

  // 6. The declared tool runs through the capability registry with a live approval check and audit.
  let approved=true;const events=[],context={tenantId:'tenant',principalId:'analyst',origin:'ui'};
  const runtime=createExtensionRuntime(publication.definition,registry,event=>events.push(event.outcome),{authorizeExtension:(_actor,ref)=>approved&&ref.id==='acme.chart'&&ref.version==='1.2.0',operations:{summarize:{candidate:{operationId:'summarize',method:'POST',path:'/summarize'},authorize:actor=>actor.tenantId==='tenant',validate:input=>Array.isArray(input?.values)&&input.values.every(Number.isFinite)}}});
  assert.deepEqual(await runtime.capabilities.invoke('summarize',{values:[3,4,5]},context),{count:3,total:12});
  t.diagnostic('invoked summarize: '+JSON.stringify({count:3,total:12}));

  // 7. Revocation: the live check refuses the next call, and a host without the approval can neither register the
  // package nor publish an application that uses it.
  approved=false;await assert.rejects(runtime.capabilities.invoke('summarize',{values:[1]},context),/forbidden|denied|not approved/i);
  assert.ok(events.length>=2,'both decisions were audited');
  const revokedHost={...host,approved:[]};
  assert.throws(()=>new ExtensionRegistry(revokedHost).register(manifest,bindings,undefined,{packageBytes:bytes}),/compatibility failed/);
  const revokedStore=new SqliteApplicationStore(join(root,'revoked.sqlite'),initial,createExtensionPublicationGuard([manifest],revokedHost,requirements));
  try{revokedStore.apply(0,patch);assert.throws(()=>revokedStore.publish(1),/not approved|compatib/i);}finally{revokedStore.close();}
  t.diagnostic('revoked: live invocation refused, registration and publication rejected');
 }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
