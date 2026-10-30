import {createPrivateKey} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {signPublicationRelease} from '../../packages/core/dist/index.js';
const [inputPath,outputPath,keyPath,keyId,environment,...extra]=process.argv.slice(2);
if(!inputPath||!outputPath||!keyPath||!keyId||!environment||extra.length)throw Error('Usage: node sign-publication.mjs INPUT OUTPUT PRIVATE_KEY KEY_ID ENVIRONMENT');
if((await stat(inputPath)).size>1024*1024||(await stat(keyPath)).size>16384)throw Error('Release input too large');
const input=JSON.parse(await readFile(inputPath,'utf8')),key=createPrivateKey(await readFile(keyPath));
const release=signPublicationRelease(input,environment,keyId,key);
await writeFile(outputPath,JSON.stringify(release)+'\n',{flag:'wx',mode:0o600});
