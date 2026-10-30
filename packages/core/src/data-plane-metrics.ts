import type {DataPlaneRequestObservation} from './planes.js';

const routes=new Set(['application','version','live','ready','other']);
const statuses=new Set(['2xx','3xx','4xx','5xx','other']);
const bounds=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10] as const;
type Series={route:DataPlaneRequestObservation['route'];outcome:DataPlaneRequestObservation['outcome'];statusClass:DataPlaneRequestObservation['statusClass'];count:number;sum:number;buckets:number[]};

/** Process-local, fixed-cardinality Prometheus counters and cumulative latency histograms. */
export class DataPlaneRequestMetrics {
 private readonly series=new Map<string,Series>();
 observe=(event:DataPlaneRequestObservation):void=>{
  if(!event||!routes.has(event.route)||!['completed','aborted'].includes(event.outcome)||(event.outcome==='aborted'?event.statusClass!=='none':!statuses.has(event.statusClass))||typeof event.durationMs!=='number'||!Number.isFinite(event.durationMs)||event.durationMs<0)throw Error('Invalid request observation');
  const key=JSON.stringify([event.route,event.outcome,event.statusClass]),previous=this.series.get(key),seconds=event.durationMs/1000,count=(previous?.count??0)+1,sum=(previous?.sum??0)+seconds;
  if(!Number.isSafeInteger(count)||!Number.isFinite(sum))throw Error('Request metrics overflow');
  const series=previous??{route:event.route,outcome:event.outcome,statusClass:event.statusClass,count:0,sum:0,buckets:bounds.map(()=>0)};
  series.count=count;series.sum=sum;for(let i=0;i<bounds.length;i++)if(seconds<=bounds[i])series.buckets[i]++;
  if(!previous)this.series.set(key,series);
 };
 /** Prometheus text exposition; expose only through a host-controlled scrape boundary. */
 render():string{
  const lines=['# HELP app_mixer_data_plane_requests_total Completed or aborted Data Plane requests.','# TYPE app_mixer_data_plane_requests_total counter'],items=[...this.series.values()].sort((a,b)=>JSON.stringify([a.route,a.outcome,a.statusClass]).localeCompare(JSON.stringify([b.route,b.outcome,b.statusClass])));
  for(const item of items){const labels=`route="${item.route}",outcome="${item.outcome}",status_class="${item.statusClass}"`;lines.push(`app_mixer_data_plane_requests_total{${labels}} ${item.count}`);}
  lines.push('# HELP app_mixer_data_plane_request_duration_seconds Data Plane request handling duration in seconds.','# TYPE app_mixer_data_plane_request_duration_seconds histogram');
  for(const item of items){
   const labels=`route="${item.route}",outcome="${item.outcome}",status_class="${item.statusClass}"`;
   for(let i=0;i<bounds.length;i++)lines.push(`app_mixer_data_plane_request_duration_seconds_bucket{${labels},le="${bounds[i]}"} ${item.buckets[i]}`);
   lines.push(`app_mixer_data_plane_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`,`app_mixer_data_plane_request_duration_seconds_sum{${labels}} ${item.sum}`,`app_mixer_data_plane_request_duration_seconds_count{${labels}} ${item.count}`);
  }
  return lines.join('\n')+'\n';
 }
}
