import {createHash} from 'node:crypto';
import {createFileCounters} from './file-counters.js';

/** A high-water mark for an audit sequence held outside the audit database, so a restored database whose sequence went back is detected. */
export type AuditSequenceAnchor={read:(key:string)=>number|Promise<number>;advance:(key:string,sequence:number)=>void|Promise<void>};
/** The anchor key for one tenant's capability audit sequence (tenant IDs may contain characters that are not safe in file names). */
export const capabilityAuditAnchorKey=(tenantId:string):string=>'capability-audit-'+createHash('sha256').update(tenantId).digest('hex');
/** The anchor key for the global authentication-failure audit sequence. */
export const authenticationFailureAnchorKey='authentication-failures';
/**
 * An audit sequence anchor stored as one small file per key in a directory. Point it at storage a database restore cannot reach, never
 * the database's own volume. A missing file reads as 0, a corrupt file throws (so the audit sink fails closed), writes are atomic and
 * never lower the value, and deleting a file removes its protection.
 */
export function createFileSequenceAnchor(directory:string):AuditSequenceAnchor{
 const counters=createFileCounters(directory,'.sequence');
 return {read:key=>counters.read(key),advance:(key,sequence)=>counters.advance(key,sequence)};
}
