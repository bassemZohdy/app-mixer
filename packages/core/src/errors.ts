/** Why an operation was refused; each code maps to one HTTP status in `httpStatus`. */
export type AppMixerErrorCode='invalid'|'not_found'|'conflict'|'limit';
const STATUS:Record<AppMixerErrorCode,number>={invalid:400,not_found:404,conflict:409,limit:429};

/** An expected refusal (validation, missing resource, conflict, limit). The message is safe to return to a client and is never reworded by the HTTP layer; `cause` is kept for logs. */
export class AppMixerError extends Error {
  readonly code:AppMixerErrorCode;
  constructor(code:AppMixerErrorCode,message:string,options?:{cause?:unknown}){
    super(message,options);this.name='AppMixerError';this.code=code;
  }
}
/** HTTP status for an expected refusal, or undefined for any other error. */
export function httpStatus(error:unknown):number|undefined{return error instanceof AppMixerError?STATUS[error.code]:undefined;}
