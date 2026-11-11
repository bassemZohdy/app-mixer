// The Data Plane image must carry core's and web's production dependencies and nothing from the agent package (FIX-005).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const required=['pg','jose','ajv'];
const forbidden=name=>name==='twilio'||name==='openai'||name.startsWith('@langchain/');
/** Names of every package a production install of the given workspaces places in node_modules. */
function productionPackages(workspaces){
 const flags=workspaces.flatMap(name=>['--workspace',name]);
 const tree=JSON.parse(execFileSync(process.platform==='win32'?'npm.cmd':'npm',['ls','--omit=dev','--all','--json',...flags],{cwd:root,encoding:'utf8',shell:process.platform==='win32',maxBuffer:1e8,stdio:['ignore','pipe','ignore']}));
 const names=new Set(),walk=dependencies=>{for(const [name,entry] of Object.entries(dependencies??{})){names.add(name);walk(entry.dependencies);}};walk(tree.dependencies);return names;
}
/** The workspaces the Dockerfile's install step names; an install without --workspace takes all of them. */
function installedWorkspaces(){
 const install=readFileSync(root+'Dockerfile.data-plane','utf8').replaceAll('\r\n','\n').split('\n').find(line=>/^RUN npm ci\b/.test(line));
 assert.ok(install,'Dockerfile.data-plane installs with npm ci');
 const named=[...install.matchAll(/--workspace (@app-mixer\/[a-z-]+)/g)].map(match=>match[1]);
 return named.length>0?named:['@app-mixer/core','@app-mixer/web','@app-mixer/agent','@app-mixer/cli','@app-mixer/native'];
}

test('FIX-005 the dependency set the image installs has pg, jose and ajv and no agent-only package',()=>{
 const names=productionPackages(installedWorkspaces());
 for(const name of required)assert.ok(names.has(name),name+' is installed');
 assert.deepEqual([...names].filter(forbidden),[],'agent-only packages in the image');
});

test('FIX-005 the check names the packages that must stay out of the image',()=>{
 const withAgent=new Set([...required,'twilio','@langchain/core','openai','zod']);
 assert.deepEqual([...withAgent].filter(forbidden).sort(),['@langchain/core','openai','twilio']);
 assert.deepEqual(['pg','jose','ajv','@opentelemetry/api'].filter(forbidden),[]);
});

test('FIX-005 core and web do not depend on the agent package',()=>{
 for(const name of ['core','web']){const manifest=JSON.parse(readFileSync(root+'packages/'+name+'/package.json','utf8'));assert.equal(Object.keys({...manifest.dependencies,...manifest.optionalDependencies}).some(dependency=>dependency==='@app-mixer/agent'||forbidden(dependency)),false,name+' keeps agent-only packages out');}
});
