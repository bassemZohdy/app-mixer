import {createPrivateKey} from 'node:crypto';
import {open,writeFile} from 'node:fs/promises';
import {signPublicationRelease} from '../../packages/core/dist/index.js';
// Read a file through one handle and enforce the size limit on that handle, so the check and the read cannot see
// different files (a path checked with stat() and then read can change in between).
const readBounded=async(path,limit,tooLarge,encoding)=>{const handle=await open(path,'r');try{if((await handle.stat()).size>limit)throw Error(tooLarge);const data=await handle.readFile();if(data.length>limit)throw Error(tooLarge);return encoding?data.toString(encoding):data;}finally{await handle.close();}};
const [inputPath,outputPath,keyPath,keyId,environment,...extra]=process.argv.slice(2);
if(!inputPath||!outputPath||!keyPath||!keyId||!environment||extra.length)throw Error('Usage: node sign-publication.mjs INPUT OUTPUT PRIVATE_KEY KEY_ID ENVIRONMENT');
const input=JSON.parse(await readBounded(inputPath,1024*1024,'Release input too large','utf8')),key=createPrivateKey(await readBounded(keyPath,16384,'Release input too large'));
const release=signPublicationRelease(input,environment,keyId,key);
await writeFile(outputPath,JSON.stringify(release)+'\n',{flag:'wx',mode:0o600});
