#!/usr/bin/env node
// Derives the "Overall progress" header, bar and table of TODO.md from its task checkboxes, so the counts cannot drift
// from the list. `node scripts/todo-progress.mjs` rewrites the file; `--check` exits 1 when the file is out of date.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const TASK=/^- \[( |x)\] (P\d)-(\d\d) /;
const BAR_WIDTH=20;

/** Compress sorted task numbers, joining runs of three or more: [1,2,4,5,6] -> "P2-01, P2-02, P2-04..P2-06". */
export function ranges(phase,numbers){
 const parts=[];let start,previous;
 const id=n=>`${phase}-${String(n).padStart(2,'0')}`;
 const flush=()=>{if(start===undefined)return;if(previous-start>=2)parts.push(`${id(start)}..${id(previous)}`);else for(let n=start;n<=previous;n++)parts.push(id(n));};
 for(const n of numbers){if(previous!==undefined&&n===previous+1){previous=n;continue;}flush();start=n;previous=n;}
 flush();return parts.join(', ');
}

/** Return the TODO text with the progress section recomputed from the checkboxes. */
export function render(text){
 const lines=text.split('\n'),phases=new Map();
 for(const line of lines){const match=TASK.exec(line);if(!match)continue;const [,mark,phase,number]=match,entry=phases.get(phase)??{done:0,open:[]};if(mark==='x')entry.done++;else entry.open.push(Number(number));phases.set(phase,entry);}
 let done=0,total=0;for(const entry of phases.values()){done+=entry.done;total+=entry.done+entry.open.length;}
 const percent=total?Math.round(done*100/total):0,filled=total?Math.round(done*BAR_WIDTH/total):0;
 return lines.map(line=>{
  if(/^\*\*\d+ \/ \d+ tasks complete \(\d+%\)\*\*$/.test(line))return `**${done} / ${total} tasks complete (${percent}%)**`;
  if(/^`[█░]+`$/.test(line))return '`'+'█'.repeat(filled)+'░'.repeat(BAR_WIDTH-filled)+'`';
  const row=/^\| (P\d) ([^|]*)\| [^|]*\| [^|]*\|$/.exec(line);
  if(row){const [,phase,label]=row,entry=phases.get(phase);if(!entry)return line;const open=entry.open.sort((a,b)=>a-b);return `| ${phase} ${label}| ${entry.done} / ${entry.done+open.length} | ${open.length?`${open.length} (${ranges(phase,open)})`:'0'} |`;}
  return line;
 }).join('\n');
}

if(process.argv[1]!==undefined&&resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()){
 const path=resolve(process.argv[2]&&process.argv[2]!=='--check'?process.argv[2]:'TODO.md'),check=process.argv.includes('--check');
 const current=readFileSync(path,'utf8'),updated=render(current);
 if(updated===current)console.log(`${path} is up to date`);
 else if(check){console.error(`${path} progress counts are out of date; run node scripts/todo-progress.mjs`);process.exitCode=1;}
 else{writeFileSync(path,updated);console.log(`${path} updated`);}
}
