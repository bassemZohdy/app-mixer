import type {DataPlaneRequestObservation} from './planes.js';

const routes=new Set(['application','version','live','ready','other']);
const statuses=new Set(['2xx','3xx','4xx','5xx','other']);
const bounds=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10] as const;
type Series={route:DataPlaneRequestObservation['route'];outcome:DataPlaneRequestObservation['outcome'];statusClass:DataPlaneRequestObservation['statusClass'];count:number;sum:number;buckets:number[]};

/** Process-local, fixed-cardinality Prometheus counters and cumulative latency histograms. */
export class DataPlaneRequestMetrics {
 private readonly series=new Map<string,Series>();
 private publicationVersion:number|undefined;private draining=false;private readonly startSeconds:number;private readonly clock:()=>number;private lastReadiness:{ready:boolean;observedAtSeconds:number}|undefined;
 constructor(clock:()=>number=Date.now){if(typeof clock!=='function')throw Error('Invalid metrics clock');const now=clock();if(!Number.isFinite(now)||now<0)throw Error('Invalid metrics clock');this.startSeconds=Math.floor(now/1000);this.clock=clock;}
 /** Record the publication version this process serves. Only the number is exposed, never the definition. */
 setPublicationVersion(version:number):void{if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid publication version');this.publicationVersion=version;}
 /** Record whether the process has begun draining for shutdown. */
 setDraining(draining:boolean):void{if(typeof draining!=='boolean')throw Error('Invalid draining state');this.draining=draining;}
 observe=(event:DataPlaneRequestObservation):void=>{
  if(!event||!routes.has(event.route)||!['completed','aborted'].includes(event.outcome)||(event.outcome==='aborted'?event.statusClass!=='none':!statuses.has(event.statusClass))||typeof event.durationMs!=='number'||!Number.isFinite(event.durationMs)||event.durationMs<0)throw Error('Invalid request observation');
  let readiness:{ready:boolean;observedAtSeconds:number}|undefined;if(event.route==='ready'&&event.outcome==='completed'){const now=this.clock();if(!Number.isFinite(now)||now<0)throw Error('Invalid metrics clock');readiness={ready:event.statusClass==='2xx',observedAtSeconds:Math.floor(now/1000)};}
  const key=JSON.stringify([event.route,event.outcome,event.statusClass]),previous=this.series.get(key),seconds=event.durationMs/1000,count=(previous?.count??0)+1,sum=(previous?.sum??0)+seconds;
  if(!Number.isSafeInteger(count)||!Number.isFinite(sum))throw Error('Request metrics overflow');
  const series=previous??{route:event.route,outcome:event.outcome,statusClass:event.statusClass,count:0,sum:0,buckets:bounds.map(()=>0)};
  series.count=count;series.sum=sum;for(let i=0;i<bounds.length;i++)if(seconds<=bounds[i])series.buckets[i]++;
  if(!previous)this.series.set(key,series);if(readiness)this.lastReadiness=readiness;
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
  lines.push('# HELP app_mixer_data_plane_start_time_seconds Process start time as a Unix timestamp.','# TYPE app_mixer_data_plane_start_time_seconds gauge',`app_mixer_data_plane_start_time_seconds ${this.startSeconds}`);
  lines.push('# HELP app_mixer_data_plane_draining Whether the process is draining for shutdown (1) or serving normally (0).','# TYPE app_mixer_data_plane_draining gauge',`app_mixer_data_plane_draining ${this.draining?1:0}`);
  if(this.lastReadiness)lines.push('# HELP app_mixer_data_plane_last_readiness Last completed readiness response (1 for 2xx, otherwise 0).','# TYPE app_mixer_data_plane_last_readiness gauge',`app_mixer_data_plane_last_readiness ${this.lastReadiness.ready?1:0}`,'# HELP app_mixer_data_plane_last_readiness_time_seconds Unix timestamp of the last completed readiness response.','# TYPE app_mixer_data_plane_last_readiness_time_seconds gauge',`app_mixer_data_plane_last_readiness_time_seconds ${this.lastReadiness.observedAtSeconds}`);
  if(this.publicationVersion!==undefined)lines.push('# HELP app_mixer_data_plane_publication_version Publication version served by this process.','# TYPE app_mixer_data_plane_publication_version gauge',`app_mixer_data_plane_publication_version ${this.publicationVersion}`);
  return lines.join('\n')+'\n';
 }
}
