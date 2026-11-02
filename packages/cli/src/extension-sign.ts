import {open,writeFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {computeExtensionIntegrity,signExtensionManifest,verifySignedExtensionManifest,type ExtensionManifest} from '@app-mixer/core';

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

/** Verify using an explicitly selected public key; this does not approve installation. */
export async function verifyExtensionFiles(manifestPath:string,packagePath:string,keyPath:string,keyId:string):Promise<ExtensionManifest>{
 const manifestBytes=await readBounded(manifestPath,4*1024*1024),packageBytes=await readBounded(packagePath,64*1024*1024),keyBytes=await readBounded(keyPath,65536);
 if(!keyBytes.toString('ascii').trimStart().startsWith('-----BEGIN PUBLIC KEY-----'))throw Error('Expected a PEM public key');
 const signed:unknown=JSON.parse(manifestBytes.toString('utf8')),key=createPublicKey(keyBytes);
 // A null prototype avoids treating a caller-supplied key ID as an object prototype.
 const trustedKeys:Record<string,typeof key>=Object.create(null) as Record<string,typeof key>;trustedKeys[keyId]=key;
 return verifySignedExtensionManifest(signed,{trustedKeys},packageBytes);
}
