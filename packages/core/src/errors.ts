/** Why an operation was refused; each code maps to one HTTP status in `httpStatus`. */
export type AppMixerErrorCode='invalid'|'denied'|'not_found'|'conflict'|'limit'|'unavailable';
const STATUS:Record<AppMixerErrorCode,number>={invalid:400,denied:403,not_found:404,conflict:409,limit:429,unavailable:503};

/** An expected refusal (validation, missing resource, conflict, limit). The message is safe to return to a client and is never reworded by the HTTP layer; `cause` is kept for logs. */
export class AppMixerError extends Error {
  declare readonly code:AppMixerErrorCode;
  constructor(code:AppMixerErrorCode,message:string,options?:{cause?:unknown}){
    super(message,options);
    // Not enumerable, so an error that is logged or serialized shows no more than a plain Error does.
    Object.defineProperties(this,{name:{value:'AppMixerError',enumerable:false,writable:true,configurable:true},code:{value:code,enumerable:false,writable:false,configurable:true}});
  }
}
/** HTTP status for an expected refusal, or undefined for any other error. */
export function httpStatus(error:unknown):number|undefined{return error instanceof AppMixerError?STATUS[error.code]:undefined;}

// Host-supplied repositories, providers, capability executors and the agent package have always reported these refusals by message (documented for the
// capability endpoint), so a plain error with exactly one of these messages keeps its status. Code in this package throws `AppMixerError`, whose code decides.
const LEGACY_MESSAGES:Record<AppMixerErrorCode,string[]>={
  invalid:['Duplicate or invalid page','Invalid capability input','Invalid component','Invalid manifest','Invalid migration request','Invalid page description','Invalid promotion package','Invalid proposal','Unknown page','Unknown patch operation'],
  denied:['Capability forbidden','Extension approval forbidden','Shared offline key forbidden'],
  not_found:['Capability not found','Definition read not found','Definition status not found','Delegation not found','Operation not found','Proposal not found','Publication not found','Run inspection not found'],
  conflict:['Data list changed','Data revision conflict','Data schema version conflict','Definition control conflict','Definition read changed','Definition status changed','Definition write conflict','Delegation conflict','Extension approval revision conflict','Extension compatibility failed','Invalid offline operation state','Invalid operation state','Lease discovery changed','Lease recovery not eligible','Lease recovery stale','Manual start conflict','Migration output conflict','Migration plan conflict','Migration snapshot conflict','Migration would lose page descriptions','No rollout requires recovery','Operation not staged','Proposal is not pending','Publication version conflict','Remote rollout state changed','Revision conflict','Rollback requires an earlier version','Rollout poller already running','Rollout poller requires review','Rollout recovery not verified','Rollout status changed','Run control conflict','Run inspection changed','Shared offline operation in progress','Shared offline outcome uncertain','Shared offline request conflict','Shared offline slot conflict','Staging request conflict','Stale offline recovery','Stale staged recovery','Stale staged verification','Unsupported schema migration'],
  limit:['Manual start backlog full','Proposal limit reached'],
  unavailable:['Budget recovery discovery unavailable','Budget recovery unavailable','Data ID prefix listing unavailable','Data capability unavailable','Data list unavailable','Data reverse listing unavailable','Data schema guard unavailable','Definition control history unavailable','Definition control unavailable','Definition history unavailable','Definition read unavailable','Definition status unavailable','Definition write unavailable','Delegation authorization unavailable','Delegation policy unavailable','Extension approval manage unavailable','Extension approval read unavailable','Extension decision policy unavailable','Extension policy unavailable','Extension validation unavailable','Lease discovery unavailable','Lease recovery history unavailable','Lease recovery unavailable','Manual start unavailable','Migration audit unavailable','Migration policy unavailable','Migration rehearsal unavailable','Migration status unavailable','Offline evidence unavailable','Offline listing unavailable','Offline recovery unavailable','Rollout control audit unavailable','Rollout evidence unavailable','Rollout poller unavailable','Rollout recovery unavailable','Rollout status unavailable','Run control history unavailable','Run control unavailable','Run inspection unavailable','Shared cost access unavailable','Shared cost capability unavailable','Staged evidence unavailable','Staged listing unavailable','Staged recovery unavailable','Staged summary unavailable','Staged verification unavailable']
};
const LEGACY=new Map<string,AppMixerErrorCode>(Object.entries(LEGACY_MESSAGES).flatMap(([code,messages])=>messages.map(message=>[message,code as AppMixerErrorCode] as const)));
/** Status of an expected refusal: the error's code, or for a plain error one of the documented messages above; undefined for anything else. */
export function refusalStatus(error:unknown):number|undefined{
  if(error instanceof AppMixerError)return STATUS[error.code];
  const code=error instanceof Error?LEGACY.get(error.message):undefined;
  return code===undefined?undefined:STATUS[code];
}
