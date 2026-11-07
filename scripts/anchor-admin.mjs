#!/usr/bin/env node
// Operator tool for the file-based rollback anchors (release floor, revocation epoch, audit sequences, approval epoch).
//   node scripts/anchor-admin.mjs <directory> list
//   node scripts/anchor-admin.mjs <directory> get <file>
//   node scripts/anchor-admin.mjs <directory> set <file> <value> [--allow-lower --reason "<why>"]
// Raising an anchor is always allowed. Lowering one removes the protection a restored database was refused by, so it needs
// `--allow-lower` and a `--reason`, and every change is appended to `anchor-admin.log` in the directory as one JSON line.
// Lower an anchor only after the lost state (revocations, approval revocations, the release floor, a note in the audit trail)
// has been re-applied to the restored database. See docs/kubernetes-data-plane.md, "Recovering after a rollback refusal".
import {appendFileSync,closeSync,fsyncSync,openSync,readdirSync,readFileSync,renameSync,writeSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {userInfo} from 'node:os';

const name=/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.(floor|sequence)$/;
function read(path){
 let text;try{text=readFileSync(path,'utf8');}catch(error){if(error.code==='ENOENT')return 0;throw error;}
 if(!/^(0|[1-9][0-9]{0,15})\n?$/.test(text))throw Error(`${path} is corrupt`);return Number(text);
}
function write(directory,file,value){
 const path=join(directory,file),temporary=`${path}.${randomUUID()}.tmp`,descriptor=openSync(temporary,'wx',0o600);
 try{writeSync(descriptor,`${value}\n`);fsyncSync(descriptor);}finally{closeSync(descriptor);}
 renameSync(temporary,path);
 try{const d=openSync(directory,'r');try{fsyncSync(d);}finally{closeSync(d);}}catch{/* directory fsync is not available on every platform */}
}
export function run(argv,now=()=>Date.now()){
 const [directory,command,file,rawValue,...flags]=argv;
 if(!directory||!existsSync(directory))throw Error('Usage: anchor-admin.mjs <directory> list|get <file>|set <file> <value> [--allow-lower --reason "<why>"]');
 if(command==='list')return readdirSync(directory).filter(entry=>name.test(entry)).sort().map(entry=>({file:entry,value:read(join(directory,entry))}));
 if(command!=='get'&&command!=='set')throw Error('Unknown command');
 if(typeof file!=='string'||!name.test(file))throw Error('Invalid anchor file name');
 const path=join(directory,file);
 if(command==='get')return {file,value:read(path)};
 if(typeof rawValue!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(rawValue))throw Error('Invalid value');
 const value=Number(rawValue),before=read(path),allowLower=flags.includes('--allow-lower'),reasonAt=flags.indexOf('--reason'),reason=reasonAt>=0?flags[reasonAt+1]:undefined;
 if(!Number.isSafeInteger(value))throw Error('Invalid value');
 if(value<before){
  if(!allowLower)throw Error(`Refusing to lower ${file} from ${before} to ${value} without --allow-lower`);
  if(typeof reason!=='string'||reason.trim().length<8||reason.length>500||/[\x00-\x1f]/.test(reason))throw Error('Lowering an anchor needs --reason with at least 8 characters');
 }
 if(value!==before)write(directory,file,value);
 const entry={at:new Date(now()).toISOString(),user:userInfo().username,file,before,after:value,...(value<before?{lowered:true,reason}:{})};
 appendFileSync(join(directory,'anchor-admin.log'),JSON.stringify(entry)+'\n',{mode:0o600});
 return entry;
}
if(process.argv[1]?.endsWith('anchor-admin.mjs')){
 try{console.log(JSON.stringify(run(process.argv.slice(2)),null,1));}catch(error){console.error(error.message);process.exitCode=1;}
}
