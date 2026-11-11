import {createHmac,timingSafeEqual} from 'node:crypto';
import {parse,stringify} from 'node:querystring';

/** Twilio request signature (HMAC-SHA1 over the URL and the sorted form fields), implemented locally so the Twilio SDK is not a dependency. */
function split(url:string){
 const match=/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)/i.exec(url);if(!match)return undefined;
 const [prefix,scheme,authority]=match as unknown as [string,string,string],userInfoEnd=authority.lastIndexOf('@'),hostAndPort=authority.slice(userInfoEnd+1),portStart=hostAndPort.indexOf(':',hostAndPort.lastIndexOf(']')+1);
 return {scheme,userInfo:authority.slice(0,userInfoEnd+1),host:portStart===-1?hostAndPort:hostAndPort.slice(0,portStart),port:portStart===-1?'':hostAndPort.slice(portStart),rest:url.slice(prefix.length)};
}
const addPort=(url:string):string=>{const parts=split(url);if(!parts||parts.port)return url;return parts.scheme+parts.userInfo+parts.host+(parts.scheme.toLowerCase()==='https://'?':443':':80')+parts.rest;};
const removePort=(url:string):string=>{const parts=split(url);return parts?parts.scheme+parts.userInfo+parts.host+parts.rest:url;};
const legacyQuery=(url:string):string=>{const start=url.indexOf('?');if(start===-1||start===url.length-1)return url;return url.slice(0,start)+'?'+stringify(parse(url.slice(start+1)));};

/** The signature Twilio sends for `url` and the form fields `params`. */
export function twilioSignature(authToken:string,url:string,params:Record<string,string>):string{
 const data=Object.keys(params).sort().reduce((text,key)=>text+key+params[key],url);
 return createHmac('sha1',authToken).update(Buffer.from(data,'utf8')).digest('base64');
}

/** True when `signature` matches the URL as configured (with or without its default port) or as normalized by the URL parser. Every candidate is compared in constant time. */
export function validTwilioSignature(authToken:string,signature:string,url:string,params:Record<string,string>):boolean{
 const normalized=new URL(url).toString(),candidates=[removePort(url),addPort(url),removePort(normalized),addPort(normalized),legacyQuery(removePort(normalized)),legacyQuery(addPort(normalized))];
 const received=Buffer.from(signature);let valid=false;
 for(const candidate of candidates){const expected=Buffer.from(twilioSignature(authToken,candidate,params));valid=(expected.length===received.length&&timingSafeEqual(expected,received))||valid;}
 return valid;
}
