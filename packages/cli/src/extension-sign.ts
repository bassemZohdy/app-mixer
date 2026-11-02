import {open,writeFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,type KeyObject} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {checkExtensionCompatibility,computeExtensionIntegrity,signExtensionManifest,verifySignedExtensionManifest,type ExtensionManifest} from '@app-mixer/core';

// Bounded reads do not trust a file size that can change while it is being read.
async function readBounded(path:string,max:number):Promise<Buffer>{
 const file=await open(path,'r');const chunks:Buffer[]=[];let size=0;
 try{if(!(await file.stat()).isFile())throw Error('Input must be a regular file');while(true){const chunk=Buffer.allocUnsafe(Math.min(65536,max+1-size)),{bytesRead}=await file.read(chunk,0,chunk.length,null);if(bytesRead===0)break;size+=bytesRead;if(size>max)throw Error('Input file too large');chunks.push(chunk.subarray(0,bytesRead));}return Buffer.concat(chunks,size);}finally{await file.close();}
}
/** Sign a local package and manifest. Existing output is never overwritten. */
export async function signExtensionFiles(manifestPath:string,packagePath:string,keyPath:string,keyId:string,outputPath:string):Promise<void>{
 const manifestBytes=await readBounded(manifestPath,1024*1024),packageBytes=await readBounded(packagePath,64*1024*1024),keyBytes=await readBounded(keyPath,65536);
 try{
  const manifest:unknown=JSON.parse(manifestBytes.toString('utf8'));if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw Error('Invalid extension manifest');
  const digest=computeExtensionIntegrity(packageBytes),candidate=manifest as Record<string,unknown>;
  if(Object.hasOwn(candidate,'integrity')&&candidate.integrity!==digest)throw Error('Manifest integrity does not match package');
  const signed=signExtensionManifest({...candidate,integrity:digest} as ExtensionManifest,keyId,createPrivateKey(keyBytes));
  await writeFile(outputPath,JSON.stringify(signed,null,2)+'\n',{flag:'wx',mode:0o600});
 }finally{keyBytes.fill(0);}
}

async function readPublicKey(keyPath:string):Promise<KeyObject>{const keyBytes=await readBounded(keyPath,65536);if(!keyBytes.toString('ascii').trimStart().startsWith('-----BEGIN PUBLIC KEY-----'))throw Error('Expected a PEM public key');return createPublicKey(keyBytes);}
async function verifyArtifact(manifestPath:string,packagePath:string,keyId:string,key:KeyObject):Promise<ExtensionManifest>{
 const manifestBytes=await readBounded(manifestPath,4*1024*1024),packageBytes=await readBounded(packagePath,64*1024*1024),signed:unknown=JSON.parse(manifestBytes.toString('utf8'));
 const trustedKeys:Record<string,KeyObject>=Object.create(null) as Record<string,KeyObject>;trustedKeys[keyId]=key;
 return verifySignedExtensionManifest(signed,{trustedKeys},packageBytes);
}
/** Verify using an explicitly selected public key; this does not approve installation. */
export async function verifyExtensionFiles(manifestPath:string,packagePath:string,keyPath:string,keyId:string):Promise<ExtensionManifest>{
 return verifyArtifact(manifestPath,packagePath,keyId,await readPublicKey(keyPath));
}

/** Check one verified artifact against a host-owned compatibility configuration. */
export async function checkExtensionFiles(manifestPath:string,packagePath:string,keyPath:string,keyId:string,hostPath:string,requirementsPath:string):Promise<ExtensionManifest>{
 const manifest=await verifyExtensionFiles(manifestPath,packagePath,keyPath,keyId);
 const host:unknown=JSON.parse((await readBounded(hostPath,1024*1024)).toString('utf8'));
 const requirements:unknown=JSON.parse((await readBounded(requirementsPath,1024*1024)).toString('utf8'));
 const result=checkExtensionCompatibility([manifest],host,requirements);
 if(!result.compatible)throw Error('Extension compatibility failed: '+result.errors.join('; '));
 return manifest;
}

/** Verify a host-selected set and check compatibility across all registrations. */
export async function checkExtensionSetFiles(setPath:string,hostPath:string,requirementsPath:string):Promise<ExtensionManifest[]>{
 const input:unknown=JSON.parse((await readBounded(setPath,1024*1024)).toString('utf8'));
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'artifacts')||!Object.hasOwn(input,'trustedKeys'))throw Error('Invalid extension artifact set');
 const {artifacts, trustedKeys}=input as {artifacts:unknown;trustedKeys:unknown};if(!Array.isArray(artifacts)||artifacts.length<1||artifacts.length>256||!trustedKeys||typeof trustedKeys!=='object'||Array.isArray(trustedKeys)||Object.keys(trustedKeys).length<1||Object.keys(trustedKeys).length>100)throw Error('Invalid extension artifact set');
 const keys=trustedKeys as Record<string,unknown>,validPath=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0');
 if(Object.entries(keys).some(([id,path])=>!/^[a-z][a-z0-9.-]{0,127}$/.test(id)||!validPath(path)))throw Error('Invalid extension artifact set');
 const base=dirname(resolve(setPath)),manifests:ExtensionManifest[]=[],publicKeys=new Map<string,KeyObject>();
 const host:unknown=JSON.parse((await readBounded(hostPath,1024*1024)).toString('utf8')),requirements:unknown=JSON.parse((await readBounded(requirementsPath,1024*1024)).toString('utf8'));
 for(const [id,path] of Object.entries(keys))publicKeys.set(id,await readPublicKey(resolve(base,path as string)));
 for(const entry of artifacts){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==3||!['manifest','package','keyId'].every(key=>Object.hasOwn(entry,key)))throw Error('Invalid extension artifact set');
  const value=entry as Record<string,unknown>;if(!validPath(value.manifest)||!validPath(value.package)||typeof value.keyId!=='string'||!Object.hasOwn(keys,value.keyId)||!validPath(keys[value.keyId]))throw Error('Invalid extension artifact set');
  manifests.push(await verifyArtifact(resolve(base,value.manifest),resolve(base,value.package),value.keyId,publicKeys.get(value.keyId)!));
 }
 const result=checkExtensionCompatibility(manifests,host,requirements);
 if(!result.compatible)throw Error('Extension compatibility failed: '+result.errors.join('; '));return manifests;
}
