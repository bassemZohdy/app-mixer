import { createHash } from 'node:crypto';
import { createFileCounters } from './file-counters.js';

/** A high-water mark held outside a database (an audit sequence or a revocation or approval epoch), so a restored database whose value went back is detected. */
export type AuditSequenceAnchor = { read: (key: string) => number | Promise<number>; advance: (key: string, sequence: number) => void | Promise<void> };
/** Called when an anchor cannot be advanced after a database change committed; the check goes on, but protection is degraded until a later advance succeeds. */
export type AnchorErrorHandler = (error: unknown) => void;
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
/** The anchor key for one release scope's floor. Hashed so scopes cannot collide on separators or case and the name stays short. */
export const releaseFloorAnchorKey = (tenantId: string, applicationId: string, environment: string): string =>
  'release-floor-' + digest(tenantId + separator + applicationId + separator + environment);
/** The anchor key for the global authentication-failure audit sequence. */
export const authenticationFailureAnchorKey = 'authentication-failures';

/** Report an anchor failure to the host without letting the handler break the caller. */
export function reportAnchorError(handler: AnchorErrorHandler | undefined, error: unknown): void {
  try {
    handler?.(error);
  } catch {
    /* a failing handler must not change the outcome */
  }
}
/** Advance an anchor after a committed change. The change stays committed if the anchor cannot move, and the failure is reported. */
export async function advanceAnchor(anchor: AuditSequenceAnchor, key: string, value: number, handler?: AnchorErrorHandler): Promise<void> {
  try {
    await anchor.advance(key, value);
  } catch (error) {
    reportAnchorError(handler, error);
  }
}
/**
 * The check every anchored store makes before it answers: read the anchored value (an unreadable or invalid anchor fails closed), compare it
 * with the value the database holds now, refuse when the database is behind, and move a lagging anchor forward.
 */
export async function checkAgainstAnchor(options: {
  anchor: AuditSequenceAnchor;
  key: string;
  stored: () => Promise<number>;
  unavailable: string;
  rolledBack: string;
  onError?: AnchorErrorHandler | undefined;
}): Promise<void> {
  let anchored: unknown;
  try {
    anchored = await options.anchor.read(options.key);
  } catch {
    throw Error(options.unavailable);
  }
  if (!Number.isSafeInteger(anchored) || (anchored as number) < 0) throw Error(options.unavailable);
  const stored = await options.stored();
  if (stored < (anchored as number)) throw Error(options.rolledBack);
  if (stored > (anchored as number)) await advanceAnchor(options.anchor, options.key, stored, options.onError);
}

/**
 * An audit sequence or epoch anchor stored as one small file per key in a directory (see `createFileCounters` for how writes behave).
 * Point it at storage a database restore cannot reach, never the database's own volume. A missing file reads as 0, a corrupt file throws
 * (so the store fails closed), writes never lower the value, and deleting a file removes its protection.
 */
export function createFileSequenceAnchor(directory: string): AuditSequenceAnchor {
  const counters = createFileCounters(directory, '.sequence');
  return { read: key => counters.read(key), advance: (key, sequence) => counters.advance(key, sequence) };
}
