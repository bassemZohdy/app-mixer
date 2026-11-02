import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

// Run only on the disposable two-worker kind cluster used by node-failure-test.mjs.
const cluster=process.env.APP_MIXER_KIND_CLUSTER??'app-mixer-nodes',namespace='app-mixer-node-test-capacity',selector='app.kubernetes.io/name=app-mixer,app.kubernetes.io/component=data-plane';
if(!/^[a-z][a-z0-9-]{0,30}$/.test(cluster))throw Error('Invalid test cluster');
const kubectl=(...args)=>execFileSync('kubectl',args,{encoding:'utf8',timeout:30000});
const json=(...args)=>JSON.parse(kubectl(...args,'-o','json'));
const waitFor=async(label,condition,timeout=180000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{last=await condition();if(last)return last;}catch(error){last=error;}await delay(2000);}throw Error(`Timed out waiting for ${label}: ${String(last)}`);};
const pods=()=>json('get','pods','-n',namespace,'-l',selector).items.filter(p=>!p.metadata.deletionTimestamp);
const ready=p=>p.status.phase==='Running'&&p.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True');
const unschedulable=p=>p.status.phase==='Pending'&&p.status.conditions?.some(c=>c.type==='PodScheduled'&&c.status==='False'&&c.reason==='Unschedulable');
const zoneOf=p=>json('get','node',p.spec.nodeName).metadata.labels?.['topology.kubernetes.io/zone'];
const endpoints=()=>json('get','endpointslices','-n',namespace,'-l','kubernetes.io/service-name=app-mixer-data-plane').items.flatMap(slice=>(slice.endpoints??[]).filter(endpoint=>endpoint.conditions?.ready!==false));
let untainted=false;
try{
 if(kubectl('config','current-context').trim()!==`kind-${cluster}`)throw Error('Expected the disposable kind test cluster');
 for(const [node,zone] of [[`${cluster}-worker`,'test-zone-a'],[`${cluster}-worker2`,'test-zone-a'],[`${cluster}-control-plane`,'test-zone-c']])kubectl('label','node',node,`topology.kubernetes.io/zone=${zone}`,'--overwrite');
 kubectl('create','namespace',namespace);kubectl('apply','-n',namespace,'-k','deploy/kubernetes/test-support/zone-placement');kubectl('scale','deployment','app-mixer-data-plane','-n',namespace,'--replicas=0');await waitFor('initial pods to stop',()=>pods().length===0,90000);kubectl('set','image','deployment/app-mixer-data-plane','data-plane=app-mixer-node-recovery-test:local','-n',namespace);kubectl('scale','deployment','app-mixer-data-plane','-n',namespace,'--replicas=2');
 await waitFor('one ready replica and one unschedulable replica in a single zone',()=>{const current=pods();return current.filter(ready).length===1&&current.some(unschedulable);},240000);
 console.log('A second replica stayed pending when only one eligible zone existed.');
 kubectl('label','node',`${cluster}-worker2`,'topology.kubernetes.io/zone=test-zone-b','--overwrite');
 await waitFor('two ready replicas in separate zones',()=>{const current=pods().filter(ready);return current.length===2&&new Set(current.map(zoneOf)).size===2&&endpoints().length===2;},180000);
 kubectl('patch','deployment','app-mixer-data-plane','-n',namespace,'--type=merge','-p',JSON.stringify({spec:{template:{metadata:{annotations:{'app-mixer.dev/capacity-test-rollout':'verified'}}}}}));
 await waitFor('surge replica to wait without a third zone',()=>{const current=pods();return current.filter(ready).length===2&&current.some(unschedulable)&&endpoints().length>=2;},180000);
 console.log('The rollout retained two ready endpoints while its surge replica waited for a third zone.');
 kubectl('taint','nodes',`${cluster}-control-plane`,'node-role.kubernetes.io/control-plane:NoSchedule-');untainted=true;
 await waitFor('rollout completion after adding a third eligible zone',()=>{const deployment=json('get','deployment','app-mixer-data-plane','-n',namespace),status=deployment.status??{},current=pods().filter(ready);return status.observedGeneration>=deployment.metadata.generation&&status.updatedReplicas===2&&status.readyReplicas===2&&status.availableReplicas===2&&(status.replicas??0)===2&&current.length===2&&new Set(current.map(zoneOf)).size===2&&endpoints().length===2;},240000);
 console.log('Zone placement recovered when capacity was added, and the rollout completed.');
}catch(error){try{console.error(kubectl('get','nodes','-o','wide'));console.error(kubectl('get','pods,endpointslices','-n',namespace,'-o','wide'));console.error(kubectl('describe','pods','-n',namespace));}catch{}throw error;}
finally{if(untainted)try{kubectl('taint','nodes',`${cluster}-control-plane`,'node-role.kubernetes.io/control-plane=:NoSchedule','--overwrite');}catch(error){console.error('Could not restore test node taint:',error);}}
