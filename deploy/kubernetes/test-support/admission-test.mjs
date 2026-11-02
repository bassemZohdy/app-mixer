import {execFileSync,spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
process.on('uncaughtException',error=>{console.log('::error title=Admission policy check::'+String(error.message).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A').slice(0,1500));process.exit(1);});
const namespace='app-mixer-test',path=join(process.env.RUNNER_TEMP,'admission-deployment.json'),image='registry.example/app-mixer@sha256:'+'a'.repeat(64);
const original=JSON.parse(execFileSync('kubectl',['get','deployment','app-mixer-data-plane','-n',namespace,'-o','json'],{encoding:'utf8'}));original.spec.template.spec.containers[0].image=image;
const apply=object=>{writeFileSync(path,JSON.stringify(object));return spawnSync('kubectl',['replace','--dry-run=server','-f',path],{encoding:'utf8'});};
let valid;for(let i=0;i<30;i++){valid=apply(original);if(valid.status===0)break;await delay(1000);}if(valid.status!==0){const live=spawnSync('kubectl',['get','validatingadmissionpolicy','app-mixer-data-plane-security','-o','jsonpath={.status}'],{encoding:'utf8'}).stdout;const e0=original.spec.template.spec.containers[0].env;throw Error('Expected approved deployment to pass: '+valid.stderr+' env='+e0.length+' names='+e0.map(e=>e.name).join(',')+' status='+live);}
const changed=(name,mutate)=>{const object=structuredClone(original),c=object.spec.template.spec.containers[0];mutate(object,c);const result=apply(object);if(result.status===0||!result.stderr.includes('app-mixer-data-plane-security'))throw Error(`${name} was not denied by the security policy: ${result.stderr}`);};
const env=(c,name)=>c.env.find(e=>e.name===name);
// Policy and binding propagation is asynchronous; wait for an unsafe update to
// be denied before asserting individual rejection cases.
const unsigned=structuredClone(original);env(unsigned.spec.template.spec.containers[0],'APP_MIXER_PUBLICATION_MODE').value='unsigned';
let enforced;for(let i=0;i<30;i++){enforced=apply(unsigned);if(enforced.status!==0&&enforced.stderr.includes('app-mixer-data-plane-security'))break;await delay(1000);}if(enforced.status===0||!enforced.stderr.includes('app-mixer-data-plane-security'))throw Error('Admission policy did not become active: '+enforced.stderr);
// The optional TLS reload interval must be unique and one of the approved values.
const reload=structuredClone(original);reload.spec.template.spec.containers[0].env.push({name:'APP_MIXER_TLS_RELOAD_MS',value:'60000'});const accepted=apply(reload);if(accepted.status!==0){const live=spawnSync('kubectl',['get','validatingadmissionpolicy','app-mixer-data-plane-security','-o','jsonpath={.status}'],{encoding:'utf8'}).stdout;const e0=reload.spec.template.spec.containers[0].env;throw Error('Expected TLS reload interval to pass: '+accepted.stderr+' env='+e0.length+' names='+e0.map(e=>e.name).join(',')+' status='+live);}
changed('unlisted TLS reload interval',(_,c)=>c.env.push({name:'APP_MIXER_TLS_RELOAD_MS',value:'1000'}));
changed('non-numeric TLS reload interval',(_,c)=>c.env.push({name:'APP_MIXER_TLS_RELOAD_MS',value:'soon'}));
changed('duplicate TLS reload interval',(_,c)=>c.env.push({name:'APP_MIXER_TLS_RELOAD_MS',value:'60000'},{name:'APP_MIXER_TLS_RELOAD_MS',value:'60000'}));
const metrics=structuredClone(original);metrics.spec.template.spec.containers[0].env=metrics.spec.template.spec.containers[0].env.filter(e=>e.name!=='APP_MIXER_METRICS_PORT');
const withMetrics=value=>{const object=structuredClone(metrics);object.spec.template.spec.containers[0].env.push({name:'APP_MIXER_METRICS_PORT',value});return object;};
for(const value of ['39092','65535']){const result=apply(withMetrics(value));if(result.status!==0)throw Error('Expected metrics port '+value+' to pass: '+result.stderr);}
for(const value of ['abc','0','65536','3002','070']){const result=apply(withMetrics(value));if(result.status===0||!result.stderr.includes('app-mixer-data-plane-security'))throw Error('Metrics port '+value+' was not denied: '+result.stderr);}
changed('duplicate metrics port',(_,c)=>c.env.push({name:'APP_MIXER_METRICS_PORT',value:'39093'}));
for(const [name,values] of [['APP_MIXER_PUBLICATION_AUTH_TIMEOUT_MS',['100','5000','30000']],['APP_MIXER_PUBLICATION_AUTH_MAX_PENDING',['1','20','100']]])for(const value of values){const object=structuredClone(original);object.spec.template.spec.containers[0].env.push({name,value});const result=apply(object);if(result.status!==0)throw Error('Expected '+name+'='+value+' to pass: '+result.stderr);}
for(const [name,values] of [['APP_MIXER_PUBLICATION_AUTH_TIMEOUT_MS',['0','99','30001','0100','1.5','invalid']],['APP_MIXER_PUBLICATION_AUTH_MAX_PENDING',['0','101','01','1.5','invalid']]])for(const value of values)changed('invalid '+name+'='+value,(_,c)=>c.env.push({name,value}));
for(const name of ['APP_MIXER_PUBLICATION_AUTH_TIMEOUT_MS','APP_MIXER_PUBLICATION_AUTH_MAX_PENDING'])changed('duplicate '+name,(_,c)=>c.env.push({name,value:name.endsWith('TIMEOUT_MS')?'5000':'20'},{name,value:name.endsWith('TIMEOUT_MS')?'5000':'20'}));
changed('unapproved extra variable',(_,c)=>c.env.push({name:'APP_MIXER_DEBUG',value:'1'}));
changed('unsigned publication',(_,c)=>env(c,'APP_MIXER_PUBLICATION_MODE').value='unsigned');
changed('public access',(_,c)=>env(c,'APP_MIXER_ACCESS_MODE').value='public');
changed('plaintext transport',(_,c)=>env(c,'APP_MIXER_TRANSPORT').value='http');
changed('disabled revocation',(_,c)=>env(c,'APP_MIXER_REVOCATION_MODE').value='disabled');
changed('disabled release floor',(_,c)=>env(c,'APP_MIXER_RELEASE_FLOOR_MODE').value='disabled');
changed('wrong issuer',(_,c)=>env(c,'APP_MIXER_JWT_ISSUER').value='https://other.example/');
changed('duplicate security variable',(_,c)=>c.env.push({name:'APP_MIXER_ACCESS_MODE',value:'public'}));
changed('unapproved image',(_,c)=>c.image='registry.example/app-mixer:latest');
changed('overridden entrypoint',(_,c)=>c.command=['sh']);
changed('privileged container',(_,c)=>{c.securityContext.privileged=true;c.securityContext.allowPrivilegeEscalation=true;});
changed('container user override',(_,c)=>c.securityContext.runAsUser=0);
changed('host networking',o=>o.spec.template.spec.hostNetwork=true);
changed('extra sidecar',o=>o.spec.template.spec.containers.push({name:'sidecar',image:'example:latest'}));
changed('untrusted key mount',o=>o.spec.template.spec.volumes.find(v=>v.name==='release-trust').configMap.name='untrusted');
changed('select alternate key',o=>o.spec.template.spec.volumes.find(v=>v.name==='release-trust').configMap.items=[{key:'other',path:'keys.json'}]);
changed('plaintext readiness probe',(_,c)=>c.readinessProbe.httpGet.scheme='HTTP');
execFileSync('kubectl',['delete','configmap','app-mixer-security-policy','-n',namespace]);const missing=apply(original);if(missing.status===0||!missing.stderr.includes('app-mixer-data-plane-security'))throw Error('Missing policy parameters did not fail closed: '+missing.stderr);
console.log('Admission policy accepted the approved deployment and denied unsafe changes and missing parameters.');
