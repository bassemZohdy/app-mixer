import type {Server} from 'node:http';
import type {Server as HttpsServer} from 'node:https';

export type ServerLimits={headersTimeoutMs?:number;requestTimeoutMs?:number;keepAliveTimeoutMs?:number;idleTimeoutMs?:number};
/**
 * Conservative defaults for the HTTP servers this package creates. Node waits 60 s for headers and 300 s for a request by default, but only checks
 * for expired connections every 30 s, so a socket idle timeout (`idleTimeoutMs`, no bytes in either direction; 0 disables it) cuts stalled clients promptly.
 */
export const DEFAULT_SERVER_LIMITS={headersTimeoutMs:10000,requestTimeoutMs:30000,keepAliveTimeoutMs:5000,idleTimeoutMs:30000} as const;
/** AEAD cipher suites with forward secrecy for TLS 1.2; TLS 1.3 suites are not affected by this list. */
export const TLS_CIPHERS='ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';
/** TLS options shared by every HTTPS server and certificate reload. */
export const TLS_POLICY={minVersion:'TLSv1.2',ciphers:TLS_CIPHERS,honorCipherOrder:true} as const;

/** Apply request, header and keep-alive timeouts so a slow or stalled client cannot hold a connection open indefinitely. Returns the same server. */
export function limitServer<T extends Server|HttpsServer>(server:T,limits:ServerLimits={}):T{
 const {headersTimeoutMs,requestTimeoutMs,keepAliveTimeoutMs,idleTimeoutMs}={...DEFAULT_SERVER_LIMITS,...limits};
 if(![headersTimeoutMs,requestTimeoutMs,keepAliveTimeoutMs].every(value=>Number.isSafeInteger(value)&&value>=1)||!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<0||headersTimeoutMs>requestTimeoutMs)throw Error('Invalid server limits');
 server.headersTimeout=headersTimeoutMs;server.requestTimeout=requestTimeoutMs;server.keepAliveTimeout=keepAliveTimeoutMs;
 server.setTimeout(idleTimeoutMs);
 return server;
}
