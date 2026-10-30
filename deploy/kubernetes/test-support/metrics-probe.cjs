const assert=require('node:assert/strict');
const os=require('node:os');

async function main(){
 let input='';for await(const chunk of process.stdin)input+=chunk;const tokens=JSON.parse(input);
 const get=async(token,url='http://127.0.0.1:39092/metrics')=>fetch(url,{headers:token?{authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(5000)});
 const mode=process.argv[1];
 if(mode==='unavailable'){const status=(await get(tokens.metrics)).status;assert.ok(status===401||status===503,`unexpected status ${status}`);console.log('Metrics denied during revocation outage');return;}
 assert.equal(mode,'normal');
 assert.equal((await get()).status,401);
 assert.equal((await get(tokens.publication)).status,401);
 assert.equal((await get(tokens.wrongTenant)).status,401);
 assert.equal((await get(tokens.revoked)).status,401);
 const response=await get(tokens.metrics);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.text();assert.match(body,/app_mixer_data_plane_requests_total/);assert.doesNotMatch(body,/ci-user|demo-tenant|Bearer/);
 const address=(os.networkInterfaces().eth0||[]).find(item=>item.family==='IPv4'&&!item.internal)?.address;assert.ok(address,'pod IPv4 address unavailable');
 await assert.rejects(get(tokens.metrics,`http://${address}:39092/metrics`));
 console.log('Scoped metrics and loopback binding verified');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
