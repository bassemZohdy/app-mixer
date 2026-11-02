import {execFileSync,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

// Run only against a disposable kind cluster with the zone test Deployment installed.
const namespace='app-mixer-node-test-zone',cluster=process.env.APP_MIXER_KIND_CLUSTER??'app-mixer-nodes',run=(...args)=>execFileSync('kubectl',args,{encoding:'utf8',timeout:30000}),apply=value=>spawnSync('kubectl',['replace','--dry-run=server','-f','-'],{input:JSON.stringify(value),encoding:'utf8',timeout:30000});
if(!/^[a-z][a-z0-9-]{0,30}$/.test(cluster)||run('config','current-context').trim()!==`kind-${cluster}`)throw Error('Expected the disposable kind test cluster');
run('apply','-f','deploy/kubernetes/strict-placement-admission/policy.yaml');run('apply','-f','deploy/kubernetes/strict-placement-admission/binding.yaml');run('apply','-f','deploy/kubernetes/zone-placement-admission/policy.yaml');run('apply','-f','deploy/kubernetes/zone-placement-admission/binding.yaml');run('label','namespace',namespace,'app-mixer.dev/enforce-zone-placement=true','app-mixer.dev/enforce-strict-placement=false','--overwrite');
const original=JSON.parse(run('get','deployment','app-mixer-data-plane','-n',namespace,'-o','json'));
const mutate=(label,change)=>{const value=structuredClone(original);change(value.spec.template.spec);return {label,value};};
const terms=pod=>pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution;
const zone=pod=>terms(pod).find(term=>term.topologyKey==='topology.kubernetes.io/zone');
const host=pod=>terms(pod).find(term=>term.topologyKey==='kubernetes.io/hostname');
const bad=[
 mutate('missing zone rule',pod=>pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution=terms(pod).filter(term=>term.topologyKey!=='topology.kubernetes.io/zone')),
 mutate('missing host rule',pod=>pod.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution=terms(pod).filter(term=>term.topologyKey!=='kubernetes.io/hostname')),
 mutate('wrong zone topology',pod=>zone(pod).topologyKey='topology.kubernetes.io/region'),
 mutate('duplicate host topology',pod=>zone(pod).topologyKey='kubernetes.io/hostname'),
 mutate('duplicate zone topology',pod=>host(pod).topologyKey='topology.kubernetes.io/zone'),
 mutate('extra required term',pod=>terms(pod).push(structuredClone(host(pod)))),
 mutate('wrong zone selector',pod=>zone(pod).labelSelector.matchLabels['app.kubernetes.io/component']='other'),
 mutate('extra zone selector',pod=>zone(pod).labelSelector.matchLabels.extra='value'),
 mutate('zone selector expression',pod=>zone(pod).labelSelector.matchExpressions=[{key:'other',operator:'Exists'}]),
 mutate('zone alternate namespace',pod=>zone(pod).namespaces=['elsewhere']),
 mutate('zone namespace selector',pod=>zone(pod).namespaceSelector={}),
 mutate('zone dynamic label',pod=>zone(pod).matchLabelKeys=['pod-template-hash']),
 mutate('zone dynamic mismatch',pod=>zone(pod).mismatchLabelKeys=['tenant']),
 mutate('wrong host selector',pod=>host(pod).labelSelector.matchLabels['app.kubernetes.io/name']='other'),
 mutate('direct node assignment',pod=>pod.nodeName='some-node'),
 mutate('custom scheduler',pod=>pod.schedulerName='other-scheduler'),
];
let rejected;for(let i=0;i<45;i++){rejected=apply(bad[0].value);if(rejected.status!==0&&rejected.stderr.includes('app-mixer-zone-placement'))break;await delay(1000);}if(rejected.status===0||!rejected.stderr.includes('app-mixer-zone-placement'))throw Error('Zone placement policy did not become active: '+rejected.stderr);
const approved=apply(original);if(approved.status!==0)throw Error('Approved zone placement was denied: '+approved.stderr);
for(const {label,value} of bad){const result=apply(value);if(result.status===0||!result.stderr.includes('app-mixer-zone-placement'))throw Error(`${label} was not denied by zone placement policy: ${result.stderr}`);}
// Exercise the zone policy in isolation first: Kubernetes may report only the first of multiple denials.
// Then enable the host policy too and confirm their approved overlay remains compatible.
run('label','namespace',namespace,'app-mixer.dev/enforce-strict-placement=true','--overwrite');const combined=apply(original);if(combined.status!==0)throw Error('Approved placement was denied with both guards: '+combined.stderr);const missingZone=apply(bad[0].value);if(missingZone.status===0||!missingZone.stderr.includes('app-mixer-zone-placement'))throw Error('Zone rule removal was not denied with both guards: '+missingZone.stderr);
const unrelated=structuredClone(original);unrelated.metadata.name='unrelated-service';delete unrelated.metadata.resourceVersion;delete unrelated.metadata.uid;delete unrelated.metadata.creationTimestamp;delete unrelated.metadata.managedFields;delete unrelated.status;delete unrelated.spec.template.spec.affinity;const unrelatedResult=spawnSync('kubectl',['create','--dry-run=server','-f','-'],{input:JSON.stringify(unrelated),encoding:'utf8',timeout:30000});if(unrelatedResult.status!==0)throw Error('Unrelated deployment was denied: '+unrelatedResult.stderr);
const creationNamespace='app-mixer-zone-create-test';run('create','namespace',creationNamespace);try{const changed=structuredClone(original);changed.metadata={name:'app-mixer-data-plane',namespace:creationNamespace};delete changed.status;changed.spec.template.metadata.labels['app.kubernetes.io/component']='other';changed.spec.selector.matchLabels['app.kubernetes.io/component']='other';const create=value=>spawnSync('kubectl',['create','--dry-run=server','-f','-'],{input:JSON.stringify(value),encoding:'utf8',timeout:30000});if(create(changed).status!==0)throw Error('Unlabeled namespace was unexpectedly restricted');run('label','namespace',creationNamespace,'app-mixer.dev/enforce-zone-placement=true');let result;for(let i=0;i<45;i++){result=create(changed);if(result.status!==0&&result.stderr.includes('app-mixer-zone-placement'))break;await delay(1000);}if(result.status===0||!result.stderr.includes('app-mixer-zone-placement'))throw Error('Wrong pod label at creation was not denied: '+result.stderr);changed.spec.template.metadata.labels['app.kubernetes.io/component']='data-plane';changed.spec.selector.matchLabels['app.kubernetes.io/component']='data-plane';result=create(changed);if(result.status!==0)throw Error('Approved zone creation was denied: '+result.stderr);}finally{run('delete','namespace',creationNamespace,'--wait=false');}
const status=JSON.parse(run('get','validatingadmissionpolicy','app-mixer-zone-placement','-o','json'));const warnings=status.status?.typeChecking?.expressionWarnings??[];if(warnings.length)throw Error('Zone placement policy type warnings: '+JSON.stringify(warnings));
console.log('Zone placement policy accepts the approved Deployment and rejects host and zone bypasses.');
