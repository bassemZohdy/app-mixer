import { randomUUID } from 'node:crypto';
import { ApplicationStore, type ApplicationDefinition, type Patch } from './index.js';
import { isValidPatch, type DefinitionRepository } from './planes.js';
import {AppMixerError} from './errors.js';

export type Proposal = {
  id:string; baseRevision:number; patches:Patch[]; preview:ApplicationDefinition;
  status:'pending'|'approved'|'rejected'; approvedRevision?:number;
};

/**
 * Local, in-memory proposal workflow. Proposal authority must be separated from approval authority by the host.
 * Only pending proposals count toward `limit`; the newest `settledLimit` approved or rejected proposals stay readable and older ones are evicted.
 */
export class DevelopmentProposals {
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly repository: DefinitionRepository, private readonly limit = 100, private readonly settledLimit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(settledLimit) || settledLimit < 0) throw Error('Invalid proposal limit');
  }
  private pendingCount = 0;
  propose(baseRevision: number, patches: unknown): Proposal {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Array.isArray(patches) || !patches.length || patches.length > 100 || !patches.every(isValidPatch)) throw new AppMixerError('invalid','Invalid proposal');
    if (this.pendingCount >= this.limit) throw new AppMixerError('limit','Proposal limit reached');
    const draft = this.repository.getDraft();
    const preview = new ApplicationStore(draft).apply(baseRevision, patches);
    const proposal:Proposal = {id:randomUUID(),baseRevision,patches:structuredClone(patches),preview,status:'pending'};
    this.proposals.set(proposal.id,proposal); this.pendingCount++;
    return structuredClone(proposal);
  }
  get(id: string): Proposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal ? structuredClone(proposal) : undefined;
  }
  approve(id: string): Proposal {
    const proposal = this.pending(id);
    // Repository revision checking makes stale approvals fail without applying any patch.
    const draft = this.repository.apply(proposal.baseRevision, proposal.patches);
    proposal.status='approved'; proposal.approvedRevision=draft.revision; this.settled(id);
    return structuredClone(proposal);
  }
  reject(id: string): Proposal {
    const proposal = this.pending(id);
    proposal.status='rejected'; this.settled(id);
    return structuredClone(proposal);
  }
  private settled(id: string): void {
    this.pendingCount--;
    // Re-insert so Map order follows settlement time; evict the oldest settled proposals beyond the bound.
    const proposal = this.proposals.get(id)!; this.proposals.delete(id); this.proposals.set(id,proposal);
    let settled = this.proposals.size - this.pendingCount;
    for (const [key,value] of this.proposals) { if (settled <= this.settledLimit) break; if (value.status !== 'pending') { this.proposals.delete(key); settled--; } }
  }
  private pending(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new AppMixerError('not_found','Proposal not found');
    if (proposal.status !== 'pending') throw new AppMixerError('conflict','Proposal is not pending');
    return proposal;
  }
}
