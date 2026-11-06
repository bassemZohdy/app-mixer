/** Why an agent operation was refused; each code maps to one HTTP status in `agentErrorStatus`. */
export type AgentErrorCode='invalid'|'denied'|'not_found'|'conflict'|'limit';
const STATUS:Record<AgentErrorCode,number>={invalid:400,denied:403,not_found:404,conflict:409,limit:429};

/** An expected refusal (denied access, missing resource, conflict, limit, invalid input). The HTTP servers answer with a fixed text for its status and never echo the message. */
export class AgentError extends Error {
  readonly code:AgentErrorCode;
  constructor(code:AgentErrorCode,message:string,options?:{cause?:unknown}){
    super(message,options);this.name='AgentError';this.code=code;
  }
}
// Host-supplied stores (approvals, notices, metrics) may still throw plain errors with the documented messages; they keep their status.
const LEGACY:Record<string,AgentErrorCode>={'Notice access denied':'denied','Notice not found':'not_found','Notice changed':'conflict','Approval access denied':'denied','Approval not found':'not_found','Approval already decided':'conflict','Approval expired':'conflict','Run is terminal':'conflict','Trigger identity conflict':'conflict','Trigger backlog full':'limit','Invalid trigger payload':'invalid','Agent metrics access denied':'denied','Invalid agent metrics actor':'denied'};
/** HTTP status of an expected refusal (an `AgentError`, or a plain error with a documented legacy message), or undefined for any other error. */
export function agentErrorStatus(error:unknown):number|undefined{
  if(error instanceof AgentError)return STATUS[error.code];
  const code=error instanceof Error&&Object.hasOwn(LEGACY,error.message)?LEGACY[error.message]:undefined;
  return code===undefined?undefined:STATUS[code];
}
