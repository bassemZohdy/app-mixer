// Checks the namespace-wide admission policies (admission-example/workload-policy.yaml) against a real Kubernetes API
// server. It uses its own namespace and server-side dry runs, impersonating the controller identities where the
// policies trust them.
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const ns='app-mixer-admission',image='registry.example/app-mixer@sha256:'+'a'.repeat(64),tool='registry.example/tool@sha256:'+'b'.repeat(64);
const rsController='system:serviceaccount:kube-system:replicaset-controller',deployController='system:serviceaccount:kube-system:deployment-controller';
const dataPlane={'app.kubernetes.io/name':'app-mixer','app.kubernetes.io/component':'data-plane'};
const kubectl=(args,input)=>spawnSync('kubectl',args,{encoding:'utf8',input});
const must=(args,input)=>{const result=kubectl(args,input);if(result.status!==0)throw Error(`kubectl ${args.join(' ')} failed: ${result.stderr}`);return result.stdout;};
const submit=(object,{as,real=false}={})=>kubectl(['create','-n',ns,'-f','-',...(real?[]:['--dry-run=server']),...(as?['--as',as]:[])],JSON.stringify(object));
let checks=0;
function allowed(name,result){checks++;if(result.status!==0)throw Error(`${name} should be allowed: ${result.stderr}`);}
function denied(name,policy,result){checks++;if(result.status===0||!result.stderr.includes(policy))throw Error(`${name} should be denied by ${policy}: ${result.status===0?'it was allowed':result.stderr}`);}

const pod=(name,{labels={},containers=[{name:'main',image:tool}],...spec}={})=>({apiVersion:'v1',kind:'Pod',metadata:{name,labels},spec:{containers,...spec}});
const template=(labels=dataPlane)=>({metadata:{labels},spec:{containers:[{name:'data-plane',image}]}});
const workload=(kind,name,labels=dataPlane)=>{
 const apiVersion=kind==='Job'||kind==='CronJob'?'batch/v1':'apps/v1',selector={matchLabels:labels};
 if(kind==='Job')return {apiVersion,kind,metadata:{name},spec:{template:{...template(labels),spec:{...template(labels).spec,restartPolicy:'Never'}}}};
 if(kind==='CronJob')return {apiVersion,kind,metadata:{name},spec:{schedule:'0 * * * *',jobTemplate:{spec:{template:{...template(labels),spec:{...template(labels).spec,restartPolicy:'Never'}}}}}};
 return {apiVersion,kind,metadata:{name},spec:{...(kind==='StatefulSet'?{serviceName:name}:{}),selector,template:template(labels)}};
};
const service=(name,{selector=dataPlane,...spec}={})=>({apiVersion:'v1',kind:'Service',metadata:{name},spec:{selector,ports:[{port:3002}],...spec}});

kubectl(['delete','namespace',ns,'--wait=true','--ignore-not-found']);
must(['create','namespace',ns]);must(['label','namespace',ns,'app-mixer.dev/enforce-data-plane=true']);
must(['create','configmap','-n',ns,'app-mixer-security-policy','--from-literal=image='+image]);
for(let i=0;i<60&&kubectl(['get','serviceaccount','default','-n',ns]).status!==0;i++)await delay(500);
must(['apply','-f','deploy/kubernetes/admission-example/workload-policy.yaml']);
// Policy propagation is asynchronous: wait until a privileged pod is denied.
let active;for(let i=0;i<60;i++){active=submit(pod('probe',{containers:[{name:'main',image:tool,securityContext:{privileged:true}}]}));if(active.status!==0&&active.stderr.includes('app-mixer-namespace-pods'))break;await delay(1000);}
if(active.status===0)throw Error('The workload policies did not become active');

// Every pod: digest-pinned images, no privilege, no host access.
allowed('a hardened ordinary pod',submit(pod('ordinary')));
denied('a tag-only image','app-mixer-namespace-pods',submit(pod('tagged',{containers:[{name:'main',image:'registry.example/tool:latest'}]})));
denied('a privileged container','app-mixer-namespace-pods',submit(pod('privileged',{containers:[{name:'main',image:tool,securityContext:{privileged:true}}]})));
denied('an added capability','app-mixer-namespace-pods',submit(pod('capable',{containers:[{name:'main',image:tool,securityContext:{capabilities:{add:['NET_ADMIN']}}}]})));
denied('a privileged init container','app-mixer-namespace-pods',submit(pod('init',{initContainers:[{name:'init',image:tool,securityContext:{privileged:true}}]})));
denied('host networking','app-mixer-namespace-pods',submit(pod('host-network',{hostNetwork:true})));
denied('host PID','app-mixer-namespace-pods',submit(pod('host-pid',{hostPID:true})));
denied('a hostPath volume','app-mixer-namespace-pods',submit(pod('host-path',{volumes:[{name:'root',hostPath:{path:'/'}}]})));

// Data Plane pods come only from the ReplicaSet controller, with the approved image.
const dataPlanePod=(name,containers=[{name:'data-plane',image}],extra={})=>pod(name,{labels:dataPlane,containers,...extra});
denied('a Data Plane pod created by a user','app-mixer-namespace-pods',submit(dataPlanePod('spoof')));
allowed('a Data Plane pod from the ReplicaSet controller',submit(dataPlanePod('replica'),{as:rsController}));
denied('a Data Plane pod with another image','app-mixer-namespace-pods',submit(dataPlanePod('other-image',[{name:'data-plane',image:tool}]),{as:rsController}));
denied('a Data Plane pod with a sidecar','app-mixer-namespace-pods',submit(dataPlanePod('sidecar',[{name:'data-plane',image},{name:'sidecar',image:tool}]),{as:rsController}));
denied('a Data Plane pod with an init container','app-mixer-namespace-pods',submit(dataPlanePod('init',[{name:'data-plane',image}],{initContainers:[{name:'init',image:tool}]}),{as:rsController}));

// Existing pods cannot join the Data Plane or receive debug containers.
allowed('creating a bystander pod',submit(pod('bystander'),{real:true}));
allowed('creating a Data Plane pod as the ReplicaSet controller',submit(dataPlanePod('live'),{as:rsController,real:true}));
denied('relabelling a bystander into the Data Plane','app-mixer-namespace-pods',kubectl(['label','pod','bystander','-n',ns,'app.kubernetes.io/component=data-plane','--dry-run=server']));
allowed('relabelling a bystander otherwise',kubectl(['label','pod','bystander','-n',ns,'team=tools','--dry-run=server']));
const debug=(name,debugImage)=>kubectl(['patch','pod',name,'-n',ns,'--subresource=ephemeralcontainers','--type=strategic','--dry-run=server','-p',JSON.stringify({spec:{ephemeralContainers:[{name:'debug',image:debugImage}]}})]);
denied('a debug container in a Data Plane pod','app-mixer-namespace-pods',debug('live',tool));
allowed('a pinned debug container in a bystander pod',debug('bystander',tool));
denied('an unpinned debug container in a bystander pod','app-mixer-namespace-pods',debug('bystander','busybox:latest'));

// Only the approved Deployment runs the Data Plane template.
for(const kind of ['StatefulSet','DaemonSet','Job','CronJob'])denied(`a ${kind} with the Data Plane template`,'app-mixer-data-plane-controllers',submit(workload(kind,'rogue')));
denied('another Deployment with the Data Plane template','app-mixer-data-plane-controllers',submit(workload('Deployment','rogue')));
allowed('another Deployment with its own template',submit(workload('Deployment','tools',{app:'tools'})));
denied('a Data Plane ReplicaSet created by a user','app-mixer-data-plane-controllers',submit(workload('ReplicaSet','app-mixer-data-plane-x')));
allowed('a Data Plane ReplicaSet from the Deployment controller',submit(workload('ReplicaSet','app-mixer-data-plane-x'),{as:deployController}));

// Only the approved ClusterIP Service selects the Data Plane.
allowed('the approved Service',submit(service('app-mixer-data-plane')));
denied('another Service selecting the Data Plane','app-mixer-data-plane-service',submit(service('rogue')));
denied('a NodePort Data Plane Service','app-mixer-data-plane-service',submit(service('app-mixer-data-plane',{type:'NodePort'})));
denied('a LoadBalancer Data Plane Service','app-mixer-data-plane-service',submit(service('app-mixer-data-plane',{type:'LoadBalancer'})));
denied('a Data Plane Service with external IPs','app-mixer-data-plane-service',submit(service('app-mixer-data-plane',{externalIPs:['203.0.113.10']})));
allowed('a Service for other pods',submit(service('tools',{selector:{app:'tools'},type:'NodePort'})));

// Without the trusted parameters, Data Plane pods fail closed.
must(['delete','configmap','app-mixer-security-policy','-n',ns]);
denied('a Data Plane pod without policy parameters','app-mixer-namespace-pods',submit(dataPlanePod('unparameterized'),{as:rsController}));
kubectl(['delete','namespace',ns,'--wait=false']);
console.log(`Workload admission policies held in ${checks} checks: bare, relabelled and debugged Data Plane pods, other workload kinds, rogue Services and unsafe pods were denied.`);
