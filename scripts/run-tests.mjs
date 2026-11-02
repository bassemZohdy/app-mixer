import {readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configured=process.env.APP_MIXER_TEST_CONCURRENCY;
if(configured!==undefined&&(!/^[1-9]\d?$/.test(configured)||Number(configured)>32)){
 console.error('APP_MIXER_TEST_CONCURRENCY must be an integer from 1 to 32');process.exitCode=1;
}else{
 const concurrency=configured??(process.platform==='win32'?'2':'8');
 const files=['core','cli','web','native','agent'].flatMap(name=>{
  const folder=join(root,'packages',name,'test');return readdirSync(folder,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.test.mjs')).map(entry=>join('packages',name,'test',entry.name)).sort();
 });
 if(files.length===0){console.error('No test files found');process.exitCode=1;}else{
  const child=spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,...files],{cwd:root,stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});
  child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
 }
}
