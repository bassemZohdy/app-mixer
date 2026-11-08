#!/usr/bin/env node
// A small mutation tester. It changes one operator at a time in a compiled module, runs the tests that cover it, and
// reports the changes the tests did not notice ("survivors"). A survivor is a condition that no test pins down, or an
// equivalent change that cannot matter; each one needs a human look.
//
// Usage: node scripts/mutate.mjs <compiled file> <test file>... [--limit=N] [--timeout=SECONDS] [--lines=57,63] [--list]
//   node scripts/mutate.mjs packages/core/dist/jwt-capability-auth.js packages/core/test/jwt-capability-auth.test.mjs
//
// Build first (npm run build). The original file is restored afterwards, also on Ctrl-C. Operators inside strings,
// template literals, regular expressions and comments are left alone. Mutants that do not parse count as "invalid".
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const args=process.argv.slice(2),flags=Object.fromEntries(args.filter(a=>a.startsWith('--')).map(a=>{const [k,v]=a.slice(2).split('=');return [k,v??true];}));
const [file,...tests]=args.filter(a=>!a.startsWith('--'));
if(!file||tests.length===0){console.error('Usage: node scripts/mutate.mjs <compiled file> <test file>... [--limit=N] [--timeout=SECONDS] [--lines=57,63] [--list]');process.exit(2);}
const path=resolve(file),original=readFileSync(path,'utf8'),timeout=Number(flags.timeout??120)*1000,limit=flags.limit===undefined?Infinity:Number(flags.limit);

// Positions of operators outside strings, templates, regular expressions and comments.
function sites(source){
  const found=[];let i=0,last='';const n=source.length;
  const regexAllowed=()=>last===''||'(,=:[!&|?{};+-*%<>~^'.includes(last)||/(?:return|typeof|case|in|of|else|do)$/.test(source.slice(Math.max(0,i-8),i).trimEnd());
  while(i<n){
    const c=source[i],d=source[i+1];
    if(c==='/'&&d==='/'){while(i<n&&source[i]!=='\n')i++;continue;}
    if(c==='/'&&d==='*'){i=source.indexOf('*/',i+2);i=i<0?n:i+2;continue;}
    if(c==='"'||c==="'"){const q=c;i++;while(i<n&&source[i]!==q){if(source[i]==='\\')i++;i++;}i++;last='x';continue;}
    if(c==='`'){let depth=0;i++;while(i<n){if(source[i]==='\\'){i+=2;continue;}if(depth===0&&source[i]==='`')break;if(source[i]==='$'&&source[i+1]==='{'){depth++;i+=2;continue;}if(depth>0&&source[i]==='}'){depth--;}i++;}i++;last='x';continue;}
    if(c==='/'&&regexAllowed()){i++;let cls=false;while(i<n&&(source[i]!=='/'||cls)){if(source[i]==='\\')i++;else if(source[i]==='[')cls=true;else if(source[i]===']')cls=false;i++;}i++;while(/[a-z]/.test(source[i]??''))i++;last='x';continue;}
    const three=source.slice(i,i+3),two=source.slice(i,i+2);
    if(three==='==='){found.push([i,3,'!==']);i+=3;last='=';continue;}
    if(three==='!=='){found.push([i,3,'===']);i+=3;last='=';continue;}
    if(two==='&&'){found.push([i,2,'||']);i+=2;last='&';continue;}
    if(two==='||'){found.push([i,2,'&&']);i+=2;last='|';continue;}
    if(two==='<='){found.push([i,2,'<']);i+=2;last='<';continue;}
    if(two==='>='){found.push([i,2,'>']);i+=2;last='>';continue;}
    if(c==='<'&&d!=='<'&&source[i-1]!=='<'){found.push([i,1,'<=']);i++;last='<';continue;}
    if(c==='>'&&d!=='>'&&source[i-1]!=='>'&&source[i-1]!=='='&&source[i-1]!=='-'){found.push([i,1,'>=']);i++;last='>';continue;}
    if(c==='!'&&d!=='='&&source[i-1]!=='!'){found.push([i,1,'']);i++;last='!';continue;}
    const word=/^[A-Za-z_$][\w$]*/.exec(source.slice(i,i+12));
    if(word&&!/[\w$.]/.test(source[i-1]??'')){
      if(word[0]==='true'){found.push([i,4,'false']);}
      if(word[0]==='false'){found.push([i,5,'true']);}
      i+=word[0].length;last='x';continue;
    }
    if(!/\s/.test(c))last=c;
    i++;
  }
  return found;
}

const only=flags.lines?new Set(String(flags.lines).split(',').map(Number)):undefined;
const all=sites(original),mutants=all.filter(([p])=>!only||only.has(original.slice(0,p).split(String.fromCharCode(10)).length)).slice(0,limit);
const lineOf=position=>original.slice(0,position).split('\n').length,snippet=(position,length)=>original.slice(Math.max(0,position-30),position+length+30).replaceAll('\n',' ');
if(flags.list){for(const [p,len,to] of mutants)console.log(`${lineOf(p)}: ${original.slice(p,p+len)||'(!)'} -> ${to||'(removed)'}   ${snippet(p,len)}`);console.log(all.length+' mutation sites');process.exit(0);}

const restore=()=>writeFileSync(path,original);
process.on('SIGINT',()=>{restore();process.exit(130);});process.on('exit',restore);
const run=()=>spawnSync(process.execPath,['--test',...tests.map(t=>resolve(t))],{encoding:'utf8',timeout,stdio:['ignore','ignore','ignore']});

// The unchanged module must pass, or every mutant would count as killed.
restore();const baseline=run();if(baseline.status!==0){console.error('The tests fail on the unchanged module; fix them first.');process.exit(1);}
const survivors=[];let killed=0,invalid=0,index=0;
for(const [p,len,to] of mutants){
  index++;const source=original.slice(0,p)+to+original.slice(p+len);
  writeFileSync(path,source);
  const parse=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  if(parse.status!==0){invalid++;continue;}
  const result=run();
  if(result.status===0)survivors.push({line:lineOf(p),change:`${original.slice(p,p+len)||'!'} -> ${to||'(removed)'}`,context:snippet(p,len)});else killed++;
  if(index%25===0)process.stderr.write(`${index}/${mutants.length} mutants, ${survivors.length} survivors\n`);
}
restore();
const tested=killed+survivors.length;
console.log(`\n${file}: ${tested} mutants tested, ${killed} killed, ${survivors.length} survived, ${invalid} did not parse. Score ${(100*killed/Math.max(1,tested)).toFixed(1)}%\n`);
for(const s of survivors)console.log(`line ${s.line}: ${s.change}\n    ${s.context}`);
