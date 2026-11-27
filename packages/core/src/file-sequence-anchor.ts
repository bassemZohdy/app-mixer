import { createHash } from 'node:crypto';
import { createFileCounters } from './file-counters.js';
import { reportAnchorError, advanceAnchor, checkAgainstAnchor } from '@app-mixer/shared';
import type { AuditSequenceAnchor, AnchorErrorHandler } from '@app-mixer/shared';

// The check and its types moved to @app-mixer/shared so the agent stores can use them; core keeps exporting them from here.
export { reportAnchorError, advanceAnchor, checkAgainstAnchor };
export type { AuditSequenceAnchor, AnchorErrorHandler };
const separator = String.fromCharCode(0),
  digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/** The anchor key for one tenant's capability audit sequence (tenant IDs may contain characters that are not safe in file names). */
export const capabilityAuditAnchorKey = (tenantId: string): string => 'capability-audit-' + digest(tenantId);
/** The anchor key for one issuer's revocation epoch. */
export const jwtRevocationAnchorKey = (issuer: string): string => 'jwt-revocations-' + digest(issuer);
/** The anchor key for one tenant and application's extension approval epoch. */
export const extensionApprovalAnchorKey = (tenantId: string, applicationId: string): string => 'extension-approvals-' + digest(tenantId + separator + applicationId);
/** The anchor key for one tenant and application's offline recovery event sequence. */
export const offlineRecoveryAnchorKey = (tenantId: string, applicationId: string): string => 'offline-recovery-' + digest(tenantId + separator + applicationId);
/** The anchor key for one tenant and application's offline execution version. */
export const offlineExecutionAnchorKey = (tenantId: string, applicationId: string): string => 'offline-executions-' + digest(tenantId + separator + applicationId);
/** The anchor key for one release scope's floor. Hashed so scopes cannot collide on separators or case and the name stays short. */
export const releaseFloorAnchorKey = (tenantId: string, applicationId: string, environment: string): string =>
  'release-floor-' + digest(tenantId + separator + applicationId + separator + environment);
/** The anchor key for the global authentication-failure audit sequence. */
export const authenticationFailureAnchorKey = 'authentication-failures';
/**
 * An audit sequence or epoch anchor stored as one small file per key in a directory (see `createFileCounters` for how writes behave).
 * Point it at storage a database restore cannot reach, never the database's own volume. A missing file reads as 0, a corrupt file throws
 * (so the store fails closed), writes never lower the value, and deleting a file removes its protection.
 */
export function createFileSequenceAnchor(directory: string): AuditSequenceAnchor {
  const counters = createFileCounters(directory, '.sequence');
  return { read: key => counters.read(key), advance: (key, sequence) => counters.advance(key, sequence) };
}
