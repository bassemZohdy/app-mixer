/** Why an operation was refused; each code maps to one HTTP status in `httpStatus`. */
export type AppMixerErrorCode='invalid'|'denied'|'not_found'|'conflict'|'limit'|'unavailable';
const STATUS:Record<AppMixerErrorCode,number>={invalid:400,denied:403,not_found:404,conflict:409,limit:429,unavailable:503};

/** An expected refusal (validation, missing resource, conflict, limit). The message is safe to return to a client and is never reworded by the HTTP layer; `cause` is kept for logs. */
export class AppMixerError extends Error {
  readonly code:AppMixerErrorCode;
  constructor(code:AppMixerErrorCode,message:string,options?:{cause?:unknown}){
    super(message,options);this.name='AppMixerError';this.code=code;
  }
}
/** HTTP status for an expected refusal, or undefined for any other error. */
export function httpStatus(error:unknown):number|undefined{return error instanceof AppMixerError?STATUS[error.code]:undefined;}

// Host-supplied repositories, providers and capability executors have always reported these refusals by message (documented for the capability endpoint), so
// plain errors with exactly these messages keep their status. Code in this repository throws `AppMixerError`, whose code decides.
const LEGACY:Record<string,AppMixerErrorCode>={
  'Revision conflict':'conflict','Unsupported schema migration':'conflict','Migration would lose page descriptions':'conflict','Proposal is not pending':'conflict','Extension compatibility failed':'conflict','Publication version conflict':'conflict','Rollback requires an earlier version':'conflict',
  'Proposal not found':'not_found','Publication not found':'not_found','Proposal limit reached':'limit',
  'Duplicate or invalid page':'invalid','Invalid component':'invalid','Unknown page':'invalid','Invalid manifest':'invalid','Unknown patch operation':'invalid','Invalid proposal':'invalid','Invalid promotion package':'invalid','Invalid page description':'invalid','Invalid migration request':'invalid',
  'Data schema guard unavailable':'unavailable','Capability not found':'not_found','Capability forbidden':'denied','Shared offline key forbidden':'denied','Invalid capability input':'invalid',
  'Data revision conflict':'conflict','Data schema version conflict':'conflict','Staging request conflict':'conflict','Operation not staged':'conflict','Shared offline request conflict':'conflict','Shared offline slot conflict':'conflict','Shared offline operation in progress':'conflict','Shared offline outcome uncertain':'conflict'
};
/** Status of an expected refusal: the error's code, or for a plain error one of the documented messages above; undefined for anything else. */
export function refusalStatus(error:unknown):number|undefined{
  if(error instanceof AppMixerError)return STATUS[error.code];
  const code=error instanceof Error&&Object.hasOwn(LEGACY,error.message)?LEGACY[error.message]:undefined;
  return code===undefined?undefined:STATUS[code];
}
