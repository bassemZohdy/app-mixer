import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

// Run only against a disposable kind cluster created with multi-node-kind.yaml.
const cluster=process.env.APP_MIXER_KIND_CLUSTER??'app-mixer-nodes',namespace=process.env.APP_MIXER_NODE_TEST_NAMESPACE??'app-mixer-node-test',selector='app.kubernetes.io/name=app-mixer,app.kubernetes.io/component=data-plane';
if(!/^[a-z][a-z0-9-]{0,30}$/.test(cluster)||!/^app-mixer-node-test(?:-[a-z0-9]+)?$/.test(namespace))throw Error('Invalid test cluster or namespace');
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',timeout:30000,...options});
const kubectl=(...args)=>run('kubectl',args);
const json=(...args)=>JSON.parse(kubectl(...args,'-o','json'));
const waitFor=async(label,condition,timeout=180000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await condition();if(last)return last;}catch(error){last=error;}await delay(2000);}throw Error(`Timed out waiting for ${label}: ${String(last)}`);};
const readyPods=()=>json('get','pods','-n',namespace,'-l',selector).items.filter(p=>!p.metadata.deletionTimestamp&&p.status.phase==='Running'&&p.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True'));
const serviceTargets=()=>{const slices=json('get','endpointslices','-n',namespace,'-l','kubernetes.io/service-name=app-mixer-data-plane');return [...new Set(slices.items.flatMap(slice=>(slice.endpoints??[]).filter(endpoint=>endpoint.conditions?.ready!==false).map(endpoint=>endpoint.targetRef?.name).filter(Boolean)))];};
async function checkPublication(target){
 const child=spawn('kubectl',['port-forward','-n',namespace,target,'0:3002','--address','127.0.0.1'],{stdio:['ignore','pipe','pipe']});let output='',port;
 try{child.stdout.on('data',chunk=>output+=String(chunk));child.stderr.on('data',chunk=>output+=String(chunk));await waitFor('port forward',()=>{const match=/Forwarding from 127\.0\.0\.1:(\d+) -> 3002/.exec(output);if(match){port=Number(match[1]);return true;}if(child.exitCode!==null)throw Error(output);return false;},30000);
  await waitFor('ready publication',async()=>{const ready=await fetch(`http://127.0.0.1:${port}/health/ready`,{signal:AbortSignal.timeout(5000)});if(!ready.ok)return false;const result=await fetch(`http://127.0.0.1:${port}/application`,{signal:AbortSignal.timeout(5000)});if(!result.ok)return false;const value=await result.json();return value.version===1&&value.definition?.id==='demo';},30000);
 }finally{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}}
}
let stoppedNode,controlPlaneUntainted=false;
try{
 const context=kubectl('config','current-context').trim();if(context!==`kind-${cluster}`)throw Error(`Expected disposable kind context kind-${cluster}, got ${context}`);
 kubectl('create','namespace',namespace);kubectl('apply','-n',namespace,'-k','deploy/kubernetes/test-support/strict-placement');kubectl('scale','deployment','app-mixer-data-plane','-n',namespace,'--replicas=0');await waitFor('initial pods to stop',()=>json('get','pods','-n',namespace,'-l',selector).items.length===0,90000);kubectl('set','image','deployment/app-mixer-data-plane','data-plane=app-mixer-node-recovery-test:local','-n',namespace);
 kubectl('scale','deployment','app-mixer-data-plane','-n',namespace,'--replicas=2');
 const initial=await waitFor('two ready replicas on different worker nodes',()=>{const pods=readyPods();return pods.length===2&&new Set(pods.map(p=>p.spec.nodeName)).size===2&&pods.every(p=>p.spec.nodeName.startsWith(`${cluster}-worker`))?pods:false;},240000);
 const survivor=initial[0],failed=initial[1];console.log('Ready replicas on',survivor.spec.nodeName,'and',failed.spec.nodeName);await checkPublication(`pod/${survivor.metadata.name}`);await checkPublication(`pod/${failed.metadata.name}`);await checkPublication('service/app-mixer-data-plane');
 stoppedNode=failed.spec.nodeName;run('docker',['stop','--time','0',stoppedNode]);
 await waitFor('failed node removal from ready Service endpoints',()=>{const targets=serviceTargets();return targets.length===1&&targets[0]===survivor.metadata.name;},180000);
 console.log('Service removed the failed-node endpoint; checking the surviving replica.');await checkPublication('service/app-mixer-data-plane');await checkPublication(`pod/${survivor.metadata.name}`);
 run('docker',['start',stoppedNode]);stoppedNode=undefined;
 const restored=await waitFor('two ready replicas and Service endpoints after node recovery',()=>{const pods=readyPods(),targets=serviceTargets();return pods.length===2&&new Set(pods.map(p=>p.spec.nodeName)).size===2&&targets.length===2&&pods.every(p=>targets.includes(p.metadata.name))?pods:false;},300000);
 for(const pod of restored)await checkPublication(`pod/${pod.metadata.name}`);await checkPublication('service/app-mixer-data-plane');
 console.log('Both replicas recovered; checking a rollout with a third eligible host.');
 // Make the disposable control-plane node a third eligible host to exercise maxUnavailable=0 with a surge replica.
 const controlPlane=`${cluster}-control-plane`;kubectl('taint','nodes',controlPlane,'node-role.kubernetes.io/control-plane:NoSchedule-');controlPlaneUntainted=true;
 kubectl('patch','deployment','app-mixer-data-plane','-n',namespace,'--type=merge','-p',JSON.stringify({spec:{template:{metadata:{annotations:{'app-mixer.dev/node-test-rollout':'verified'}}}}}));let emptyEndpoints=false;
 await waitFor('strict-placement rollout with spare node',()=>{const deployment=json('get','deployment','app-mixer-data-plane','-n',namespace),targets=serviceTargets();if(targets.length===0)emptyEndpoints=true;const status=deployment.status??{};return status.observedGeneration>=deployment.metadata.generation&&status.updatedReplicas===2&&status.readyReplicas===2&&status.availableReplicas===2&&(status.replicas??0)===2;},240000);
 if(emptyEndpoints)throw Error('Service had no ready endpoints during rollout');const rolled=readyPods();if(rolled.length!==2||new Set(rolled.map(p=>p.spec.nodeName)).size!==2)throw Error('Rollout did not retain strict host placement');for(const pod of rolled)await checkPublication(`pod/${pod.metadata.name}`);await checkPublication('service/app-mixer-data-plane');
 console.log('Data Plane survived node loss, recovered both replicas and rolled out with a third eligible host.');
}catch(error){try{console.error(kubectl('get','nodes','-o','wide'));console.error(kubectl('get','pods,endpointslices','-n',namespace,'-o','wide'));}catch{}throw error;}
finally{if(stoppedNode)try{run('docker',['start',stoppedNode]);}catch(error){console.error('Could not restart test node:',error);}if(controlPlaneUntainted)try{kubectl('taint','nodes',`${cluster}-control-plane`,'node-role.kubernetes.io/control-plane=:NoSchedule','--overwrite');}catch(error){console.error('Could not restore test node taint:',error);}}

