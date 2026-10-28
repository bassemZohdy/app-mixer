import { randomUUID } from 'node:crypto';
import { ApplicationStore, type ApplicationDefinition, type Patch } from './index.js';
import { isValidPatch, type DefinitionRepository } from './planes.js';

export type Proposal = {
  id:string; baseRevision:number; patches:Patch[]; preview:ApplicationDefinition;
  status:'pending'|'approved'|'rejected'; approvedRevision?:number;
};

/** Local, in-memory proposal workflow. Proposal authority must be separated from approval authority by the host. */
export class DevelopmentProposals {
  private readonly proposals = new Map<string, Proposal>();
  constructor(private readonly repository: DefinitionRepository, private readonly limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('Invalid proposal limit');
  }
  propose(baseRevision: number, patches: unknown): Proposal {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Array.isArray(patches) || !patches.length || patches.length > 100 || !patches.every(isValidPatch)) throw Error('Invalid proposal');
    if (this.proposals.size >= this.limit) throw Error('Proposal limit reached');
    const draft = this.repository.getDraft();
    const preview = new ApplicationStore(draft).apply(baseRevision, patches);
    const proposal:Proposal = {id:randomUUID(),baseRevision,patches:structuredClone(patches),preview,status:'pending'};
    this.proposals.set(proposal.id,proposal);
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
    proposal.status='approved'; proposal.approvedRevision=draft.revision;
    return structuredClone(proposal);
  }
  reject(id: string): Proposal {
    const proposal = this.pending(id);
    proposal.status='rejected';
    return structuredClone(proposal);
  }
  private pending(id: string): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw Error('Proposal not found');
    if (proposal.status !== 'pending') throw Error('Proposal is not pending');
    return proposal;
  }
}
