import { createHash, type KeyObject } from 'node:crypto';
import { signPromotionPackage, type SignedPromotionPackage } from './signed-promotion.js';
import type { PromotionPackage } from './promotion.js';
import type { PostgresJwtRevocationQuery } from './postgres-jwt-revocations.js';
import {
  promotionSigningAuditRow,
  signingAuditFields,
  unauditedPromotionImports,
  verifyPromotionSigningAuditChain,
  type PromotionImportRecord,
  type PromotionSigningAuditBody,
  type PromotionSigningAuditEntry,
  type PromotionSigningAuditHead,
  type UnauditedPromotionImport
} from './promotion-signing-audit.js';

/*
 * The PostgreSQL signing audit separates two trust domains that the SQLite audit keeps in one process. The audit operator's credential owns the
 * table, the append-only triggers and the append function; the release service's database role may only execute that function, which derives the
 * sequence, the previous hash and the hash from the table itself, and read the entries. A party holding the signing key but neither credential can
 * neither write, alter nor drop entries, so a signature produced outside the service stays `missing` in findUnaudited. Provision with the operator's
 * connection (initialize), then operate with the service's connection.
 */
type Options = { query: PostgresJwtRevocationQuery; clock?: () => number };
const GENESIS = '0'.repeat(64);
const text = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(x);
const fields = [
  'sequence',
  'previousHash',
  'recordedAt',
  'tenantId',
  'principalId',
  'applicationId',
  'sourceEnvironment',
  'sourceVersion',
  'packageDigest',
  'targetEnvironment',
  'keyId',
  'expectedVersion',
  'signerPrincipal',
  'signature'
] as const;
const hashOf = (body: PromotionSigningAuditBody) =>
  createHash('sha256')
    .update(JSON.stringify(fields.map(name => body[name])))
    .digest('hex');
const APPEND_PARAMETERS =
  '(p_recorded_at BIGINT,p_tenant_id TEXT,p_principal_id TEXT,p_application_id TEXT,p_source_environment TEXT,p_source_version BIGINT,' +
  'p_package_digest TEXT,p_target_environment TEXT,p_key_id TEXT,p_expected_version BIGINT,p_signer_principal TEXT,p_signature TEXT)';
// The function's hash is the same canonical JSON array the JavaScript audit hashes: strings as JSON strings, numbers bare, null as null.
const APPEND_BODY = `
    LOCK TABLE app_mixer_promotion_signing_audit IN EXCLUSIVE MODE;
    SELECT sequence,hash INTO v_sequence,v_previous FROM app_mixer_promotion_signing_audit ORDER BY sequence DESC LIMIT 1;
    v_sequence := coalesce(v_sequence,0)+1;
    v_previous := coalesce(v_previous,'${GENESIS}');
    v_hash := encode(sha256(convert_to('[' || concat_ws(',',
      to_json(v_sequence)::text,to_json(v_previous)::text,to_json(p_recorded_at)::text,to_json(p_tenant_id)::text,to_json(p_principal_id)::text,
      to_json(p_application_id)::text,to_json(p_source_environment)::text,to_json(p_source_version)::text,to_json(p_package_digest)::text,
      to_json(p_target_environment)::text,to_json(p_key_id)::text,to_json(p_expected_version)::text,to_json(p_signer_principal)::text,to_json(p_signature)::text
    ) || ']','UTF8')),'hex');
    INSERT INTO app_mixer_promotion_signing_audit VALUES (v_sequence,v_previous,p_recorded_at,p_tenant_id,p_principal_id,p_application_id,p_source_environment,p_source_version,
      p_package_digest,p_target_environment,p_key_id,p_expected_version,p_signer_principal,p_signature,v_hash);
    RETURN QUERY SELECT v_sequence,v_previous,v_hash;`;

/** Shared PostgreSQL audit; authorization, database and connection lifecycle remain host-owned. */
export class PostgresPromotionSigningAudit {
  private readonly query: PostgresJwtRevocationQuery;
  private readonly clock: () => number;
  constructor(options: Options) {
    if (!options || typeof options.query !== 'function' || (options.clock !== undefined && typeof options.clock !== 'function')) throw Error('Invalid promotion signing audit configuration');
    this.query = options.query;
    this.clock = options.clock ?? Date.now;
  }
  /**
   * Provision once using the audit operator's connection, which will own the table, the triggers and the append function. The release service's role,
   * `appendRole`, receives EXECUTE on the append function and SELECT on the table and nothing else; PUBLIC loses everything. Run it before accepting traffic.
   */
  async initialize(provision: { appendRole?: string } = {}): Promise<void> {
    if (!provision || (provision.appendRole !== undefined && !identifier(provision.appendRole))) throw Error('Invalid promotion signing audit provisioning');
    const schema = await this.query('SELECT current_schema() AS schema', []);
    if (schema.rows.length !== 1 || !identifier(schema.rows[0]!.schema)) throw Error('Invalid promotion signing audit schema');
    const searchPath = `pg_catalog, ${schema.rows[0]!.schema}`;
    await this.query(
      'CREATE TABLE IF NOT EXISTS app_mixer_promotion_signing_audit (sequence BIGINT PRIMARY KEY,previous_hash TEXT NOT NULL,recorded_at BIGINT NOT NULL,tenant_id TEXT NOT NULL,' +
        'principal_id TEXT NOT NULL,application_id TEXT NOT NULL,source_environment TEXT NOT NULL,source_version BIGINT NOT NULL,package_digest TEXT NOT NULL,' +
        'target_environment TEXT NOT NULL,key_id TEXT NOT NULL,expected_version BIGINT,signer_principal TEXT,signature TEXT NOT NULL,hash TEXT NOT NULL UNIQUE)',
      []
    );
    await this.query('CREATE INDEX IF NOT EXISTS app_mixer_promotion_signing_audit_signature ON app_mixer_promotion_signing_audit(signature)', []);
    await this.query(
      'CREATE OR REPLACE FUNCTION app_mixer_promotion_signing_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ ' +
        "BEGIN RAISE EXCEPTION 'promotion signing audit is append-only' USING ERRCODE = 'restrict_violation'; END $$",
      []
    );
    await this.query('DROP TRIGGER IF EXISTS app_mixer_promotion_signing_audit_no_change ON app_mixer_promotion_signing_audit', []);
    await this.query(
      'CREATE TRIGGER app_mixer_promotion_signing_audit_no_change BEFORE UPDATE OR DELETE ON app_mixer_promotion_signing_audit FOR EACH ROW EXECUTE FUNCTION app_mixer_promotion_signing_audit_guard()',
      []
    );
    await this.query(
      `CREATE OR REPLACE FUNCTION app_mixer_promotion_signing_audit_append${APPEND_PARAMETERS} RETURNS TABLE(entry_sequence BIGINT,entry_previous_hash TEXT,entry_hash TEXT) ` +
        `LANGUAGE plpgsql SECURITY DEFINER SET search_path = ${searchPath} AS $$ DECLARE v_sequence BIGINT; v_previous TEXT; v_hash TEXT; BEGIN${APPEND_BODY} END $$`,
      []
    );
    await this.query('REVOKE ALL ON TABLE app_mixer_promotion_signing_audit FROM PUBLIC', []);
    await this.query(`REVOKE ALL ON FUNCTION app_mixer_promotion_signing_audit_append${APPEND_PARAMETERS} FROM PUBLIC`, []);
    if (provision.appendRole !== undefined) {
      await this.query(`GRANT EXECUTE ON FUNCTION app_mixer_promotion_signing_audit_append${APPEND_PARAMETERS} TO "${provision.appendRole}"`, []);
      await this.query(`GRANT SELECT ON app_mixer_promotion_signing_audit TO "${provision.appendRole}"`, []);
    }
  }
  /** Record one signature through the append function; the entry commits before the caller may release the envelope. */
  async record(actor: { tenantId: string; principalId: string }, signed: SignedPromotionPackage): Promise<PromotionSigningAuditEntry> {
    const entry = signingAuditFields(actor, signed, this.clock());
    const result = await this.query(
      'SELECT entry_sequence AS sequence,entry_previous_hash AS previous_hash,entry_hash AS hash FROM app_mixer_promotion_signing_audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        entry.recordedAt,
        entry.tenantId,
        entry.principalId,
        entry.applicationId,
        entry.sourceEnvironment,
        entry.sourceVersion,
        entry.packageDigest,
        entry.targetEnvironment,
        entry.keyId,
        entry.expectedVersion,
        entry.signerPrincipal,
        entry.signature
      ]
    );
    if (result.rows.length !== 1) throw Error('Invalid promotion signing audit result');
    const body: PromotionSigningAuditBody = { ...entry, sequence: Number(result.rows[0]!.sequence), previousHash: String(result.rows[0]!.previous_hash) },
      hash = String(result.rows[0]!.hash);
    // The function derives the hash in SQL; it must equal the one JavaScript verifies against, or the two disagree on what an entry is.
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 1 || !/^([a-f0-9]{64})$/.test(hash) || hashOf(body) !== hash) throw Error('Promotion signing audit hash mismatch');
    return { ...body, hash };
  }
  async list(options: { after?: number; limit?: number } = {}): Promise<PromotionSigningAuditEntry[]> {
    const after = options?.after ?? 0,
      limit = options?.limit ?? 100;
    if (!integer(after) || !integer(limit) || limit < 1 || limit > 1000) throw Error('Invalid promotion signing audit query');
    const result = await this.query('SELECT * FROM app_mixer_promotion_signing_audit WHERE sequence>$1 ORDER BY sequence LIMIT $2', [after, limit]);
    return result.rows.map(promotionSigningAuditRow);
  }
  /** The latest sequence and hash; publish or retain it elsewhere so truncation of the tail can be detected. */
  async head(): Promise<PromotionSigningAuditHead> {
    const result = await this.query('SELECT sequence,hash FROM app_mixer_promotion_signing_audit ORDER BY sequence DESC LIMIT 1', []);
    return result.rows.length ? { sequence: Number(result.rows[0]!.sequence), hash: String(result.rows[0]!.hash) } : { sequence: 0, hash: GENESIS };
  }
  /** Recompute the chain; optionally require that a previously retained head is still present. */
  async verify(checkpoint?: PromotionSigningAuditHead): Promise<{ valid: boolean; head: PromotionSigningAuditHead; error?: string }> {
    const result = await this.query('SELECT * FROM app_mixer_promotion_signing_audit ORDER BY sequence', []);
    return verifyPromotionSigningAuditChain(result.rows.map(promotionSigningAuditRow), checkpoint);
  }
  /** Compare a target's imported signature evidence with this log. Returns imports the signing service did not record. */
  async findUnaudited(imports: PromotionImportRecord[]): Promise<UnauditedPromotionImport[]> {
    if (!Array.isArray(imports) || imports.length > 10000) throw Error('Invalid promotion import records');
    const signatures = [...new Set(imports.map(item => item?.evidence?.signature).filter((signature): signature is string => typeof signature === 'string'))];
    const result = signatures.length ? await this.query('SELECT * FROM app_mixer_promotion_signing_audit WHERE signature=ANY($1::text[]) ORDER BY sequence', [signatures]) : { rows: [], rowCount: 0 };
    const entries = result.rows.map(promotionSigningAuditRow);
    return unauditedPromotionImports(imports, signature => entries.filter(entry => entry.signature === signature));
  }
}

/** A control-plane export signer that records every signature in the shared audit before releasing it. */
export function createPostgresAuditedPromotionSigner(options: {
  audit: PostgresPromotionSigningAudit;
  actor: { tenantId: string; principalId: string };
  keyId: string;
  privateKey: KeyObject;
  signerPrincipal?: string;
}) {
  if (
    !options ||
    !(options.audit instanceof PostgresPromotionSigningAudit) ||
    !options.actor ||
    !text(options.actor.tenantId) ||
    !text(options.actor.principalId) ||
    !text(options.keyId) ||
    !options.privateKey ||
    (options.signerPrincipal !== undefined && !text(options.signerPrincipal))
  )
    throw Error('Invalid audited promotion signer configuration');
  const { audit, keyId, privateKey, signerPrincipal } = options,
    actor = { ...options.actor };
  return async (pkg: PromotionPackage, targetEnvironment: string, expectedVersion?: number): Promise<SignedPromotionPackage> => {
    if (signerPrincipal !== undefined && expectedVersion === undefined) throw Error('Signer identity requires a target version');
    const signed = signPromotionPackage(pkg, targetEnvironment, keyId, privateKey, expectedVersion, signerPrincipal);
    await audit.record(actor, signed);
    return signed;
  };
}
