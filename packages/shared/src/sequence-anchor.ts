// The check every anchored store makes before it answers, shared by the core and agent stores (TASK-047.2.1). The file-backed anchor
// and the anchor keys stay in @app-mixer/core.
/** A high-water mark held outside a database (an audit sequence or a revocation or approval epoch), so a restored database whose value went back is detected. */
export type AuditSequenceAnchor = { read: (key: string) => number | Promise<number>; advance: (key: string, sequence: number) => void | Promise<void> };
/** Called when an anchor cannot be advanced after a database change committed; the check goes on, but protection is degraded until a later advance succeeds. */
export type AnchorErrorHandler = (error: unknown) => void;

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
