import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Small durable non-decreasing counters, one file per name in a directory (shared by the release floor and audit sequence anchors). */
export type FileCounters={read:(name:string)=>number;advance:(name:string,value:number)=>void};
const name=/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export function createFileCounters(directory:string,suffix:string):FileCounters{
 if(typeof directory!=='string'||!directory)throw Error('Invalid anchor directory');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=(key:string):string=>{if(typeof key!=='string'||!name.test(key))throw Error('Invalid anchor name');return join(directory,key+suffix);};
 const load=(path:string):number=>{
  let text:string;try{text=readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
  if(!/^(0|[1-9][0-9]{0,15})\n?$/.test(text))throw Error('Corrupt anchor');const value=Number(text);if(!Number.isSafeInteger(value))throw Error('Corrupt anchor');return value;
 };
 return {
  read:key=>load(file(key)),
  advance:(key,value)=>{
   if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid anchor value');
   const path=file(key);if(load(path)>=value)return;
   const temporary=`${path}.${randomUUID()}.tmp`,descriptor=openSync(temporary,'wx',0o600);
   try{writeSync(descriptor,`${value}\n`);fsyncSync(descriptor);}finally{closeSync(descriptor);}
   renameSync(temporary,path);
   try{const directoryDescriptor=openSync(directory,'r');try{fsyncSync(directoryDescriptor);}finally{closeSync(directoryDescriptor);}}catch{/* directory fsync is not available on every platform */}
  }
 };
}
