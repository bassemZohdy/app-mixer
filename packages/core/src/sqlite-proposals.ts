import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ApplicationStore, type Patch } from './index.js';
import { isValidPatch, type DefinitionRepository } from './planes.js';
import { AppMixerError } from './errors.js';
import type { Proposal, ProposalStore } from './proposals.js';

type Row = Record<string, unknown>;
const STATUSES = ['pending', 'approved', 'rejected'];

/**
 * Durable proposal workflow: pending proposals survive a restart. Same contract as `DevelopmentProposals`: only pending proposals count toward `limit`, and the
 * newest `settledLimit` approved or rejected proposals stay readable. Approval applies the patches to the repository first and then records the decision; if the
 * process stops between the two, the proposal stays pending and a retry fails with a revision conflict, so reject it. Proposal authority must be separated from
 * approval authority by the host.
 */
export class SqliteDevelopmentProposals implements ProposalStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly repository: DefinitionRepository, private readonly limit = 100, private readonly settledLimit = 100) {
    if (typeof path !== 'string' || !path || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(settledLimit) || settledLimit < 0) throw Error('Invalid proposal limit');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS development_proposals (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, base_revision INTEGER NOT NULL, patches TEXT NOT NULL, preview TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), approved_revision INTEGER, settled_order INTEGER
        );
        CREATE INDEX IF NOT EXISTS development_proposals_status ON development_proposals(status,settled_order);`);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  propose(baseRevision: number, patches: unknown): Proposal {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Array.isArray(patches) || !patches.length || patches.length > 100 || !patches.every(isValidPatch)) throw new AppMixerError('invalid', 'Invalid proposal');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (Number(this.db.prepare("SELECT COUNT(*) AS n FROM development_proposals WHERE status='pending'").get()?.n) >= this.limit) throw new AppMixerError('limit', 'Proposal limit reached');
      const preview = new ApplicationStore(this.repository.getDraft()).apply(baseRevision, patches);
      const proposal: Proposal = { id: randomUUID(), baseRevision, patches: structuredClone(patches) as Patch[], preview, status: 'pending' };
      this.db.prepare('INSERT INTO development_proposals (id,base_revision,patches,preview,status) VALUES (?,?,?,?,?)').run(proposal.id, baseRevision, JSON.stringify(proposal.patches), JSON.stringify(preview), 'pending');
      this.db.exec('COMMIT');
      return structuredClone(proposal);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Proposal | undefined {
    const row = this.row(id);
    return row ? this.proposal(row) : undefined;
  }
  approve(id: string): Proposal {
    const row = this.pending(id), proposal = this.proposal(row);
    // Repository revision checking makes stale approvals fail without applying any patch.
    const draft = this.repository.apply(proposal.baseRevision, proposal.patches);
    this.settle(id, 'approved', draft.revision);
    return { ...proposal, status: 'approved', approvedRevision: draft.revision };
  }
  reject(id: string): Proposal {
    const proposal = this.proposal(this.pending(id));
    this.settle(id, 'rejected');
    return { ...proposal, status: 'rejected' };
  }
  private row(id: string): Row | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM development_proposals WHERE id=?').get(id) : undefined;
  }
  private pending(id: string): Row {
    const row = this.row(id);
    if (!row) throw new AppMixerError('not_found', 'Proposal not found');
    if (row.status !== 'pending') throw new AppMixerError('conflict', 'Proposal is not pending');
    return row;
  }
  private settle(id: string, status: 'approved' | 'rejected', approvedRevision?: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE development_proposals SET status=?,approved_revision=?,settled_order=(SELECT COALESCE(MAX(settled_order),0)+1 FROM development_proposals) WHERE id=? AND status='pending'").run(status, approvedRevision ?? null, id).changes;
      if (changed !== 1) throw new AppMixerError('conflict', 'Proposal is not pending');
      // Evict the oldest settled proposals beyond the bound.
      this.db.prepare("DELETE FROM development_proposals WHERE status<>'pending' AND id NOT IN (SELECT id FROM development_proposals WHERE status<>'pending' ORDER BY settled_order DESC LIMIT ?)").run(this.settledLimit);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private proposal(row: Row): Proposal {
    if (!STATUSES.includes(String(row.status))) throw Error('Invalid stored proposal');
    return { id: String(row.id), baseRevision: Number(row.base_revision), patches: JSON.parse(String(row.patches)) as Patch[], preview: JSON.parse(String(row.preview)), status: row.status as Proposal['status'], ...(row.approved_revision === null || row.approved_revision === undefined ? {} : { approvedRevision: Number(row.approved_revision) }) };
  }
}
