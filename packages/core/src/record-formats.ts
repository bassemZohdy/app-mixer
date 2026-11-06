/**
 * The JSON Schema `format` values record forms support, shared by the server validator.
 * The generated editor carries an identical copy; a test checks they agree.
 */
const DAYS=[31,28,31,30,31,30,31,31,30,31,30,31];
const leap=(year:number)=>year%4===0&&(year%100!==0||year%400===0);

/** RFC 3339 full-date: YYYY-MM-DD with a real calendar day. */
export function isRecordDate(value:string):boolean{
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!match)return false;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
 return month>=1&&month<=12&&day>=1&&day<=(month===2&&leap(year)?29:DAYS[month-1]);
}
/** RFC 3339 date-time with an uppercase T and either Z or a numeric offset; leap seconds are not accepted. */
export function isRecordDateTime(value:string):boolean{
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
 if(!match||!isRecordDate(match[1]))return false;
 return Number(match[2])<24&&Number(match[3])<60&&Number(match[4])<60&&(match[5]==='Z'||(Number(match[6])<24&&Number(match[7])<60));
}
/** A conservative address subset: dot-atom local part and a DNS host name with a letter TLD. */
export function isRecordEmail(value:string):boolean{
 if(value.length>254)return false;const at=value.lastIndexOf('@');if(at<1||at>64)return false;
 const local=value.slice(0,at),domain=value.slice(at+1);
 return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)&&/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain);
}
export const RECORD_FORMATS={date:isRecordDate,'date-time':isRecordDateTime,email:isRecordEmail} as const;
