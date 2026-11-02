import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {verifySignedExtensionManifest,computeExtensionIntegrity,ExtensionRegistry,ApplicationStore} from '@app-mixer/core';
const run=promisify(execFile),cli=resolve('packages/cli/dist/index.js');
test('extension-sign creates a verifiable package-bound manifest without overwriting files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mixer-extension-sign-'));
 try{
  const paths=['manifest.json','package.bin','key.pem','signed.json'].map(name=>join(dir,name)),[manifestPath,packagePath,keyPath,output]=paths;
  const keys=generateKeyPairSync('ed25519'),bytes=Buffer.from('trusted package'),manifest={manifestVersion:1,id:'example.chart',version:'1.0.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['react'],components:['chart'],tools:[],providers:[],permissions:[]};
  await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(packagePath,bytes);await writeFile(keyPath,keys.privateKey.export({format:'pem',type:'pkcs8'}));
  await run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'publisher',output]);
  const signed=JSON.parse(await readFile(output,'utf8')),verified=verifySignedExtensionManifest(signed,{trustedKeys:{publisher:keys.publicKey}},bytes);assert.equal(verified.integrity,computeExtensionIntegrity(bytes));
  const publicPath=join(dir,'public.pem'),otherPublicPath=join(dir,'other-public.pem');await writeFile(publicPath,keys.publicKey.export({format:'pem',type:'spki'}));await writeFile(otherPublicPath,generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}));
  const args=['extension-verify',output,packagePath,publicPath,'publisher'];assert.match((await run(process.execPath,[cli,...args])).stdout,/Verified example\.chart@1\.0\.0 \(application\)/);
  await assert.rejects(run(process.execPath,[cli,'extension-verify',output,packagePath,otherPublicPath,'publisher']));await assert.rejects(run(process.execPath,[cli,'extension-verify',output,packagePath,publicPath,'wrong-key']));await assert.rejects(run(process.execPath,[cli,'extension-verify',output,packagePath,keyPath,'publisher']),/Expected a PEM public key/);
  await writeFile(packagePath,Buffer.from('tampered package'));await assert.rejects(run(process.execPath,[cli,...args]));await writeFile(packagePath,bytes);
  const altered=join(dir,'altered.json');await writeFile(altered,JSON.stringify({...signed,manifest:{...signed.manifest,version:'2.0.0'}}));await assert.rejects(run(process.execPath,[cli,'extension-verify',altered,packagePath,publicPath,'publisher']));
  const hostPath=join(dir,'host.json'),requirementsPath=join(dir,'requirements.json'),host={runtimeVersion:'0.1.0',renderer:'react',requireIntegrityPins:true,approved:[{id:manifest.id,version:manifest.version,scope:manifest.scope,permissions:[],integrity:verified.integrity}]},requirements={components:['chart'],tools:[],providers:[]};
  await writeFile(hostPath,JSON.stringify(host));await writeFile(requirementsPath,JSON.stringify(requirements));const checkArgs=['extension-check',output,packagePath,publicPath,'publisher',hostPath,requirementsPath];assert.match((await run(process.execPath,[cli,...checkArgs])).stdout,/Compatible example\.chart@1\.0\.0/);
  for(const changed of [{...host,renderer:'flutter'},{...host,approved:[]},{...host,approved:[{...host.approved[0],integrity:computeExtensionIntegrity(Buffer.from('different'))}]},{...host,approved:[{...host.approved[0],integrity:undefined}]}]){await writeFile(hostPath,JSON.stringify(changed));await assert.rejects(run(process.execPath,[cli,...checkArgs]),/compatibility failed/);}
  await writeFile(hostPath,JSON.stringify(host));await writeFile(requirementsPath,JSON.stringify({...requirements,components:['missing']}));await assert.rejects(run(process.execPath,[cli,...checkArgs]),/compatibility failed/);await writeFile(requirementsPath,JSON.stringify(requirements));
  const registry=new ExtensionRegistry(host,{trustedKeys:{publisher:keys.publicKey}}),render=()=>1;registry.registerSigned(signed,{components:{chart:render},tools:{},providers:{}},{},bytes);const ref={id:manifest.id,version:manifest.version,scope:manifest.scope},guard=registry.createPublicationGuard(()=>requirements),store=new ApplicationStore({id:'app',schemaVersion:1,revision:0,extensions:[ref],pages:[]},guard);assert.equal(store.publish(0).version,1);assert.equal(registry.getForExtension([ref],ref.id,'components','chart')(),1);


  const before=await readFile(output,'utf8');await assert.rejects(run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'publisher',output]));assert.equal(await readFile(output,'utf8'),before);
  await writeFile(manifestPath,JSON.stringify({...manifest,integrity:computeExtensionIntegrity(Buffer.from('other'))}));await assert.rejects(run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'publisher',join(dir,'bad.json')]),/integrity does not match/);
  await writeFile(manifestPath,JSON.stringify({...manifest,unknown:true}));await assert.rejects(run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'publisher',join(dir,'invalid.json')]));
  await writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'invalid/key',join(dir,'invalid.json')]));
  await assert.rejects(run(process.execPath,[cli,'extension-sign',manifestPath,packagePath,keyPath,'publisher']));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('extension-check-set verifies trusted packages and detects conflicts across extensions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mixer-extension-set-'));
 try{
  const keys=generateKeyPairSync('ed25519'),bytes=Buffer.from('approved package'),digest=computeExtensionIntegrity(bytes),base={manifestVersion:1,version:'1.0.0',scope:'application',runtimeVersions:['0.1.0'],renderers:['react'],tools:[],providers:[],permissions:[]};
  await writeFile(join(dir,'key.pem'),keys.privateKey.export({format:'pem',type:'pkcs8'}));await writeFile(join(dir,'public.pem'),keys.publicKey.export({format:'pem',type:'spki'}));await writeFile(join(dir,'package.bin'),bytes);
  const sign=async(id,component,filename)=>{const manifest={...base,id,components:[component]},source=join(dir,'source.json');await writeFile(source,JSON.stringify(manifest));await run(process.execPath,[cli,'extension-sign',source,join(dir,'package.bin'),join(dir,'key.pem'),'publisher',join(dir,filename)]);};
  await sign('example.first','chart','first.json');await sign('example.second','chart2','second.json');
  const artifacts=[{manifest:'first.json',package:'package.bin',keyId:'publisher'},{manifest:'second.json',package:'package.bin',keyId:'publisher'}],set={trustedKeys:{publisher:'public.pem'},artifacts},host={runtimeVersion:'0.1.0',renderer:'react',requireIntegrityPins:true,approved:['example.first','example.second'].map(id=>({id,version:'1.0.0',scope:'application',permissions:[],integrity:digest}))},requirements={components:['chart','chart2'],tools:[],providers:[]};
  const config=join(dir,'set.json'),hostPath=join(dir,'host.json'),requirementsPath=join(dir,'requirements.json');await writeFile(config,JSON.stringify(set));await writeFile(hostPath,JSON.stringify(host));await writeFile(requirementsPath,JSON.stringify(requirements));const args=[cli,'extension-check-set',config,hostPath,requirementsPath];assert.match((await run(process.execPath,args,{cwd:tmpdir()})).stdout,/Compatible extensions: 2/);
  await writeFile(config,JSON.stringify({...set,artifacts:[...artifacts,{...artifacts[0]}]}));await assert.rejects(run(process.execPath,args),/Duplicate extension/);
  await writeFile(config,JSON.stringify({...set,artifacts:[artifacts[0],{...artifacts[1],keyId:'unknown'}]}));await assert.rejects(run(process.execPath,args),/Invalid extension artifact set/);
  await sign('example.second','chart','collision.json');await writeFile(config,JSON.stringify({...set,artifacts:[artifacts[0],{...artifacts[1],manifest:'collision.json'}]}));await writeFile(requirementsPath,JSON.stringify({...requirements,components:['chart']}));await assert.rejects(run(process.execPath,args),/Duplicate components/);
  await writeFile(config,JSON.stringify(set));await writeFile(join(dir,'package.bin'),Buffer.from('tampered'));await assert.rejects(run(process.execPath,args),/Invalid signed extension manifest/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
