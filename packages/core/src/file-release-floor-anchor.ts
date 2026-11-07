import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PublicationReleaseFloorAnchor,PublicationReleaseScope} from './postgres-publication-releases.js';

const pattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,id={test:(value:unknown):boolean=>typeof value==='string'&&pattern.test(value)};
function file(directory:string,scope:PublicationReleaseScope):string{
 if(!scope||!id.test(scope.tenantId)||!id.test(scope.applicationId)||!id.test(scope.environment))throw Error('Invalid publication release scope');
 return join(directory,`${scope.tenantId}__${scope.applicationId}__${scope.environment}.floor`);
}
/**
 * A release-floor anchor stored as one small file per scope in a directory. Point it at storage that a database restore cannot reach
 * (a separate volume, a mounted secret store or a host-owned path), never at the database's own volume. A missing file reads as 0, so
 * the first check adopts the database floor; a corrupt file throws, which makes `isAllowed` fail closed. Writes are atomic
 * (temporary file, fsync, rename) and never lower the floor. Deleting the file removes the protection.
 */
export function createFileReleaseFloorAnchor(directory:string):PublicationReleaseFloorAnchor{
 if(typeof directory!=='string'||!directory)throw Error('Invalid release floor anchor directory');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const read=(path:string):number=>{
  let text:string;try{text=readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
  if(!/^(0|[1-9][0-9]{0,15})\n?$/.test(text))throw Error('Corrupt release floor anchor');const value=Number(text);if(!Number.isSafeInteger(value))throw Error('Corrupt release floor anchor');return value;
 };
 return {
  read:scope=>read(file(directory,scope)),
  advance:(scope,floor)=>{
   if(!Number.isSafeInteger(floor)||floor<0)throw Error('Invalid release floor');
   const path=file(directory,scope);if(read(path)>=floor)return;
   const temporary=`${path}.${randomUUID()}.tmp`,descriptor=openSync(temporary,'wx',0o600);
   try{writeSync(descriptor,`${floor}\n`);fsyncSync(descriptor);}finally{closeSync(descriptor);}
   renameSync(temporary,path);
   try{const directoryDescriptor=openSync(directory,'r');try{fsyncSync(directoryDescriptor);}finally{closeSync(directoryDescriptor);}}catch{/* directory fsync is not available on every platform */}
  }
 };
}
