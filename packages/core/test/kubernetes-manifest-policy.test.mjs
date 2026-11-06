import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../deploy/kubernetes/',import.meta.url));
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?(entry.name==='test-support'?[]:files(join(dir,entry.name))):/\.ya?ml$/.test(entry.name)?[join(dir,entry.name)]:[]);
const workloads=files(root).flatMap(file=>readFileSync(file,'utf8').split(/^---\s*$/m).filter(doc=>/^kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/m.test(doc)).map(doc=>({file:file.slice(root.length).replaceAll(String.fromCharCode(92),'/'),doc})));

test('production workload manifests keep their pod hardening, probes and resource bounds',()=>{
 assert.ok(workloads.length>=1,'no production workload manifests were found, so the policy would pass vacuously');
 for(const {file,doc} of workloads){
  const has=(pattern,message)=>assert.match(doc,pattern,`${file}: ${message}`);
  const lacks=(pattern,message)=>assert.doesNotMatch(doc,pattern,`${file}: ${message}`);
  has(/automountServiceAccountToken:\s*false/,'must not mount a service account token');
  has(/runAsNonRoot:\s*true/,'must run as non-root');
  has(/runAsUser:\s*[1-9]\d*/,'must pin a non-zero user');
  has(/seccompProfile:\s*\{\s*type:\s*RuntimeDefault\s*\}/,'must use the RuntimeDefault seccomp profile');
  has(/allowPrivilegeEscalation:\s*false/,'must forbid privilege escalation');
  has(/readOnlyRootFilesystem:\s*true/,'must use a read-only root filesystem');
  has(/capabilities:\s*\{\s*drop:\s*\[\s*ALL\s*\]\s*\}/,'must drop all capabilities');
  has(/requests:\s*\{[^}]*cpu:[^}]*memory:[^}]*\}/,'must request cpu and memory');
  has(/limits:\s*\{[^}]*cpu:[^}]*memory:[^}]*\}/,'must limit cpu and memory');
  has(/readinessProbe:/,'must define a readiness probe');has(/livenessProbe:/,'must define a liveness probe');has(/startupProbe:/,'must define a startup probe');
  has(/terminationGracePeriodSeconds:\s*\d+/,'must set a termination grace period for draining');
  lacks(/privileged:\s*true/,'must not be privileged');
  lacks(/host(Network|PID|IPC):\s*true/i,'must not share host namespaces');
  lacks(/hostPath:/,'must not mount host paths');
  for(const match of doc.matchAll(/^\s*image:\s*(\S+)/gm))assert.doesNotMatch(match[1],/(:latest|^[^:@]+)$/,`${file}: image ${match[1]} must be pinned to a tag or digest, not latest or untagged`);
 }
});

test('replicated workloads keep a rolling update that never drops below availability',()=>{
 for(const {file,doc} of workloads.filter(item=>/kind:\s*Deployment/.test(item.doc))){
  const replicas=Number(/replicas:\s*(\d+)/.exec(doc)?.[1]??1);
  if(replicas>1)assert.match(doc,/maxUnavailable:\s*0/,`${file}: replicated Deployments must roll without losing capacity`);
 }
});
