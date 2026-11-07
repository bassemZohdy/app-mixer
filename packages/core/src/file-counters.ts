import {mkdirSync} from 'node:fs';
import {open,readFile,rename,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * Small durable non-decreasing counters, one file per name in a directory (shared by the release floor and audit sequence anchors and by
 * the operator tool). Reads are plain reads of an atomically replaced file. Writes take a per-counter lock file, re-read inside the lock,
 * write a temporary file, fsync it, rename it into place and fsync the directory, so two writers cannot lower a counter by racing and a
 * failed write leaves no temporary file behind. Everything is asynchronous so a slow volume does not stall the event loop.
 */
export type FileCounters={
 read:(name:string)=>Promise<number>;
 /** Raise the counter to `value`; a lower or equal value is ignored. */
 advance:(name:string,value:number)=>Promise<void>;
 /** Set the counter to `value`, even lowering it. Returns the value it replaced. For the operator tool only. */
 set:(name:string,value:number)=>Promise<{before:number}>;
};
const namePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/,sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const lockAttempts=300,lockWaitMs=10,staleLockMs=30000;

export function createFileCounters(directory:string,suffix:string):FileCounters{
 if(typeof directory!=='string'||!directory)throw Error('Invalid anchor directory');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=(key:string):string=>{if(typeof key!=='string'||!namePattern.test(key))throw Error('Invalid anchor name');return join(directory,key+suffix);};
 const load=async(path:string):Promise<number>=>{
  let text:string;try{text=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;}
  if(!/^(0|[1-9][0-9]{0,15})\n?$/.test(text))throw Error('Corrupt anchor');const value=Number(text);if(!Number.isSafeInteger(value))throw Error('Corrupt anchor');return value;
 };
 const locked=async<T>(path:string,work:()=>Promise<T>):Promise<T>=>{
  const lockPath=path+'.lock';let handle;
  for(let attempt=0;;attempt++){
   try{handle=await open(lockPath,'wx',0o600);break;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    // A lock left by a crashed writer is broken after it has been held for far longer than any write takes.
    try{if(Date.now()-(await stat(lockPath)).mtimeMs>staleLockMs)await unlink(lockPath);}catch{/* the holder released it meanwhile */}
    if(attempt>=lockAttempts)throw Error('Anchor is locked by another writer');await sleep(lockWaitMs);
   }
  }
  try{return await work();}finally{await handle.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}
 };
 const write=async(path:string,value:number):Promise<void>=>{
  const temporary=`${path}.${randomUUID()}.tmp`;let handle;
  try{
   handle=await open(temporary,'wx',0o600);await handle.writeFile(`${value}\n`);await handle.sync();await handle.close();handle=undefined;
   // On Windows a reader that has the target open for a moment makes the rename fail transiently; the value is still safe in the temporary file.
   for(let attempt=0;;attempt++){try{await rename(temporary,path);break;}catch(error){if(attempt<30&&['EPERM','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code??'')){await sleep(10);continue;}throw error;}}
  }catch(error){await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
  try{const directoryHandle=await open(directory,'r');try{await directoryHandle.sync();}finally{await directoryHandle.close();}}catch{/* directory fsync is not available on every platform */}
 };
 return {
  read:key=>load(file(key)),
  advance:async(key,value)=>{
   if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid anchor value');
   const path=file(key);if(await load(path)>=value)return;
   await locked(path,async()=>{if(await load(path)<value)await write(path,value);});
  },
  set:async(key,value)=>{
   if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid anchor value');
   const path=file(key);
   return locked(path,async()=>{const before=await load(path);if(before!==value)await write(path,value);return {before};});
  }
 };
}
