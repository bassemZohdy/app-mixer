import test from 'node:test';
import assert from 'node:assert/strict';
import {DataPlaneRequestMetrics,computeExtensionIntegrity,verifyExtensionIntegrity} from '../dist/index.js';

function rng(seed){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
const pick=(random,list)=>list[Math.floor(random()*list.length)];

test('arbitrary request observations never grow metric cardinality or break the exposition format',()=>{
 const random=rng(7),metrics=new DataPlaneRequestMetrics();
 const routes=['application','other','user-42','/etc/passwd','','x'.repeat(300),null,undefined,1,{},'__proto__','a"b','a\nb'],outcomes=['completed','aborted','failed','error','',null,5,'a{b}'],classes=['2xx','3xx','4xx','5xx','none','999','private',null,'2XX'],durations=[0,1,5,50,900,20000,-1,NaN,Infinity,'5',null,1e308,0.001];
 const lineCount=()=>metrics.render().split('\n').filter(Boolean).length;let accepted=0,rejected=0,afterWarmup=0;
 for(let i=0;i<8000;i++){
  try{metrics.observe({route:pick(random,routes),outcome:pick(random,outcomes),statusClass:pick(random,classes),durationMs:pick(random,durations)});accepted++;}
  catch(error){rejected++;assert.match(error.message,/observation/,`unexpected error: ${error.message}`);}
  if(i===3999)afterWarmup=lineCount();
 }
 const text=metrics.render(),lines=text.split('\n').filter(Boolean);
 assert.ok(accepted>0&&rejected>0);
 // Series are bounded by fixed label sets: four thousand more hostile observations add no new series.
 assert.equal(lines.length,afterWarmup);
 for(const line of lines)assert.match(line,/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_:][a-z0-9_:]*(\{[a-z_]+="[A-Za-z0-9_.+-]*"(,[a-z_]+="[A-Za-z0-9_.+-]*")*\})? (\d+|\d+\.\d+|\d(\.\d+)?e[+-]?\d+|\+Inf))$/,`malformed exposition line: ${JSON.stringify(line)}`);
 assert.ok(!/user-42|passwd|__proto__|private/.test(text));
});

test('extension digest verification is exact, canonical and never throws on hostile input',()=>{
 const random=rng(11),bytes=Buffer.from('extension package bytes'),good=computeExtensionIntegrity(bytes);
 assert.match(good,/^sha256-[A-Za-z0-9+/]{43}=$/);assert.equal(verifyExtensionIntegrity(good,bytes),true);
 assert.equal(verifyExtensionIntegrity(good,Buffer.from('extension package bytes!')),false);
 assert.equal(verifyExtensionIntegrity(computeExtensionIntegrity(Buffer.alloc(0)),Buffer.alloc(0)),true);
 // Any single-character change to a valid digest is rejected.
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
 for(let i=7;i<good.length-1;i++){const replacement=alphabet[(alphabet.indexOf(good[i])+1)%alphabet.length];assert.equal(verifyExtensionIntegrity(good.slice(0,i)+replacement+good.slice(i+1),bytes),false,`position ${i}`);}
 // Wrong algorithm, case, padding, length and types never verify and never throw.
 const hostile=[undefined,null,0,{},[],'',' ',good.toUpperCase(),good.replace('sha256-','sha512-'),good.replace('sha256-','SHA256-'),good.slice(0,-1),good+'=',good+'A',' '+good,good+'\n',good.replace('=','A'),'sha256-'+'A'.repeat(43)+'=','sha256-'+'A'.repeat(44),'sha256-%%%','__proto__',{toString:()=>good},[good]];
 for(const value of hostile)assert.equal(verifyExtensionIntegrity(value,bytes),false,JSON.stringify(value));
 for(let i=0;i<2000;i++){const length=Math.floor(random()*80),text=Array.from({length},()=>String.fromCharCode(32+Math.floor(random()*95))).join('');assert.equal(verifyExtensionIntegrity(random()<0.5?'sha256-'+text:text,bytes),false);}
 assert.throws(()=>computeExtensionIntegrity('not bytes'),/Invalid extension package/);assert.throws(()=>computeExtensionIntegrity(null),/Invalid extension package/);
});
