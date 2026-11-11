/** Why an agent operation was refused; each code maps to one HTTP status in `agentErrorStatus`. */
/** `lost_race`: another worker or node changed the same run or action first (stale revision, lease held, state moved on); a supervisor ignores it and the next pass re-reads. */
export type AgentErrorCode='invalid'|'denied'|'not_found'|'conflict'|'limit'|'lost_race'|'unavailable';
const STATUS:Record<AgentErrorCode,number>={invalid:400,denied:403,not_found:404,conflict:409,limit:429,lost_race:409,unavailable:503};

/** An expected refusal (denied access, missing resource, conflict, limit, invalid input). The HTTP servers answer with a fixed text for its status and never echo the message. */
export class AgentError extends Error {
  declare readonly code:AgentErrorCode;
  constructor(code:AgentErrorCode,message:string,options?:{cause?:unknown}){
    super(message,options);
    // Not enumerable, so an error that is logged or serialized shows no more than a plain Error does.
    Object.defineProperties(this,{name:{value:'AgentError',enumerable:false,writable:true,configurable:true},code:{value:code,enumerable:false,writable:false,configurable:true}});
  }
}
// Host-supplied stores (approvals, notices, triggers, metrics) may still throw plain errors with the documented messages; they keep their status.
const LEGACY_MESSAGES:Record<string,string[]>={
  invalid:['Invalid trigger payload'],
  denied:['Notice access denied','Approval access denied'],
  not_found:['Notice not found','Approval not found'],
  conflict:['Notice changed','Approval already decided','Approval expired','Approval changed','Run is terminal','Trigger identity conflict','Run revision conflict','Invalid run state','Run deadline expired','Run cannot be resumed','Run wait requires reconciliation','Run requires reconciliation','Approval required','Delegation renewal required','Run is archived'],
  limit:['Trigger backlog full'],
  unavailable:['Notice authorization unavailable','Approval authorization unavailable']
};
const LEGACY=new Map<string,AgentErrorCode>(Object.entries(LEGACY_MESSAGES).flatMap(([code,messages])=>messages.map(message=>[message,code as AgentErrorCode] as const)));
/** HTTP status of an expected refusal (an `AgentError`, or a plain error with a documented legacy message), or undefined for any other error. */
export function agentErrorStatus(error:unknown):number|undefined{
  if(error instanceof AgentError)return STATUS[error.code];
  const code=error instanceof Error?LEGACY.get(error.message):undefined;
  return code===undefined?undefined:STATUS[code];
}
