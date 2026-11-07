#!/usr/bin/env node
// Operator tool for the file-based rollback anchors (release floor, revocation epoch, audit sequences, approval epoch). Needs `npm run build`.
//   node scripts/anchor-admin.mjs <directory> list
//   node scripts/anchor-admin.mjs <directory> get <file>
//   node scripts/anchor-admin.mjs <directory> set <file> <value> [--allow-lower --reason "<why>"]
//   node scripts/anchor-admin.mjs key <kind> <identifiers...>        (prints the file name an anchor uses; kinds below)
// Anchor files are named by a hash of what they protect, so use `key` to find one:
//   key release-floor <tenant> <application> <environment>   key jwt-revocations <issuer>   key extension-approvals <tenant> <application>
//   key capability-audit <tenant>                            key authentication-failures
// Raising an anchor is always allowed. Lowering one removes the protection a restored database was refused by, so it needs `--allow-lower` and
// a `--reason` (at least eight characters). Every change is logged to `anchor-admin.log` in the directory as JSON lines: an `intent` line
// is written first and the change is made only if that write succeeded, then an `applied` line records the outcome. Writes use the same lock
// and atomic replacement as the running services, so the tool and a service cannot lose each other's updates.
// Lower an anchor only after the lost state (revocations, approval revocations, the release floor, a note in the audit trail) has been
// re-applied to the restored database. See docs/kubernetes-data-plane.md, "Recovering after a rollback refusal".
import {appendFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {userInfo} from 'node:os';
import {createFileCounters,capabilityAuditAnchorKey,jwtRevocationAnchorKey,extensionApprovalAnchorKey,releaseFloorAnchorKey,authenticationFailureAnchorKey} from '../packages/core/dist/index.js';

const name=/^([A-Za-z0-9][A-Za-z0-9._-]{0,200})\.(floor|sequence)$/;
const usage='Usage: anchor-admin.mjs <directory> list|get <file>|set <file> <value> [--allow-lower --reason "<why>"]  or  anchor-admin.mjs key <kind> <identifiers...>';
const parse=file=>{const match=typeof file==='string'?name.exec(file):null;if(!match)throw Error('Invalid anchor file name');return {key:match[1],suffix:'.'+match[2]};};
const counters=(directory,suffix)=>createFileCounters(directory,suffix);
const keys={
 'release-floor':[3,(t,a,e)=>releaseFloorAnchorKey(t,a,e)+'.floor'],'jwt-revocations':[1,issuer=>jwtRevocationAnchorKey(issuer)+'.sequence'],
 'extension-approvals':[2,(t,a)=>extensionApprovalAnchorKey(t,a)+'.sequence'],'capability-audit':[1,tenant=>capabilityAuditAnchorKey(tenant)+'.sequence'],
 'authentication-failures':[0,()=>authenticationFailureAnchorKey+'.sequence']
};
export async function run(argv,now=()=>Date.now()){
 if(argv[0]==='key'){
  const [,kind,...identifiers]=argv,entry=keys[kind];
  if(!entry||identifiers.length!==entry[0]||identifiers.some(value=>typeof value!=='string'||!value))throw Error(usage);
  return {file:entry[1](...identifiers)};
 }
 const [directory,command,file,rawValue,...flags]=argv;
 if(!directory)throw Error(usage);try{await access(directory);}catch{throw Error(usage);}
 if(command==='list'){
  const entries=(await readdir(directory)).filter(entry=>name.test(entry)).sort(),result=[];
  for(const entry of entries){const {key,suffix}=parse(entry);result.push({file:entry,value:await counters(directory,suffix).read(key)});}
  return result;
 }
 if(command!=='get'&&command!=='set')throw Error('Unknown command');
 const {key,suffix}=parse(file),store=counters(directory,suffix);
 if(command==='get')return {file,value:await store.read(key)};
 if(typeof rawValue!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(rawValue))throw Error('Invalid value');
 const value=Number(rawValue),before=await store.read(key),allowLower=flags.includes('--allow-lower'),reasonAt=flags.indexOf('--reason'),reason=reasonAt>=0?flags[reasonAt+1]:undefined;
 if(!Number.isSafeInteger(value))throw Error('Invalid value');
 const lowering=value<before;
 if(lowering){
  if(!allowLower)throw Error(`Refusing to lower ${file} from ${before} to ${value} without --allow-lower`);
  if(typeof reason!=='string'||reason.startsWith('--')||reason.trim().length<8||reason.length>500||/[\x00-\x1f]/.test(reason))throw Error('Lowering an anchor needs --reason "<why>" with at least 8 characters');
 }
 const logPath=join(directory,'anchor-admin.log'),entry=phase=>({at:new Date(now()).toISOString(),user:userInfo().username,phase,file,before,after:value,...(lowering?{lowered:true,reason}:{})});
 // The intent is on record before anything changes; if it cannot be written, nothing changes.
 await appendFile(logPath,JSON.stringify(entry('intent'))+'\n',{mode:0o600});
 // Raising can never lower the value even if a running service raised it meanwhile; only an explicit lowering uses `set`. Both take the same lock as the services.
 const replaced=lowering?await store.set(key,value):(await store.advance(key,value),{before});
 const applied={...entry('applied'),before:replaced.before};
 await appendFile(logPath,JSON.stringify(applied)+'\n',{mode:0o600});
 return applied;
}
if(process.argv[1]?.endsWith('anchor-admin.mjs')){
 try{console.log(JSON.stringify(await run(process.argv.slice(2)),null,1));}catch(error){console.error(error.message);process.exitCode=1;}
}
