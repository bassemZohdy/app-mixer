import { randomUUID } from 'node:crypto';
import { checkKey, dataCopy, type DataScope } from './data-provider.js';
import { PostgresOfflineRequestKeys } from './postgres-offline-request-keys.js';
import type { PostgresJwtRevocationQuery } from './postgres-jwt-revocations.js';
import { AppMixerError } from './errors.js';
import { offlineExecutionAnchorKey, checkAgainstAnchor, advanceAnchor } from './file-sequence-anchor.js';
import type { AuditSequenceAnchor, AnchorErrorHandler } from './file-sequence-anchor.js';

type Options = {
  query: PostgresJwtRevocationQuery;
  requestKeys: PostgresOfflineRequestKeys;
  /** A high-water mark of the execution version per tenant and application, held outside the database (ADR 0013). */
  versionAnchor?: AuditSequenceAnchor;
  onAnchorError?: AnchorErrorHandler;
};
export type SharedOfflineExecution = { status: 'ready' | 'running' | 'uncertain' | 'succeeded'; attemptToken: string; result?: unknown };
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const versionSequence = 'app_mixer_offline_execution_version';
const resultJSON = (value: unknown): string => JSON.stringify(dataCopy({ value }).value);
/** Shared execution state; caller owns authorization, worker fencing and external reconciliation. */
export class PostgresOfflineExecutions {
  private readonly query: PostgresJwtRevocationQuery;
  private readonly keys: PostgresOfflineRequestKeys;
  private readonly anchor: AuditSequenceAnchor | undefined;
  private readonly onAnchorError: AnchorErrorHandler | undefined;
  /** With an anchor every change draws a new version from the sequence in the same statement and returns it; without one the statements are unchanged. */
  private readonly bump: string;
  private readonly returning: string;
  constructor(options: Options) {
    if (
      !options ||
      typeof options.query !== 'function' ||
      !(options.requestKeys instanceof PostgresOfflineRequestKeys) ||
      (options.versionAnchor !== undefined && (!options.versionAnchor || typeof options.versionAnchor.read !== 'function' || typeof options.versionAnchor.advance !== 'function')) ||
      (options.onAnchorError !== undefined && typeof options.onAnchorError !== 'function')
    )
      throw Error('Invalid shared offline executions');
    this.query = options.query;
    this.keys = options.requestKeys;
    this.anchor = options.versionAnchor;
    this.onAnchorError = options.onAnchorError;
    this.bump = this.anchor ? ",version=nextval('" + versionSequence + "')" : '';
    this.returning = this.anchor ? ',version' : '';
  }
  usesKeys(keys: PostgresOfflineRequestKeys): boolean {
    return this.keys === keys;
  }
  async initialize(): Promise<void> {
    await this.query(
      'CREATE TABLE IF NOT EXISTS app_mixer_offline_executions (idempotency_key TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,principal_id TEXT NOT NULL,' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        "operation_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('ready','running','uncertain','succeeded')),attempt_token TEXT NOT NULL,result_json TEXT)",
      []
    );
    if (!this.anchor) return;
    // A database that already holds executions gains the version column; its rows draw their versions from the sequence.
    await this.query('CREATE SEQUENCE IF NOT EXISTS ' + versionSequence, []);
    await this.query("ALTER TABLE app_mixer_offline_executions ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT nextval('" + versionSequence + "')", []);
    await this.query('CREATE INDEX IF NOT EXISTS app_mixer_offline_executions_newest ON app_mixer_offline_executions (tenant_id,application_id,version)', []);
  }
  /** Refuses to answer when the newest version in the database is below the anchored high-water mark, which means the database was restored to an older state. */
  private async checkAnchor(tenantId: string, applicationId: string): Promise<void> {
    if (!this.anchor) return;
    await checkAgainstAnchor({
      anchor: this.anchor,
      key: offlineExecutionAnchorKey(tenantId, applicationId),
      unavailable: 'Offline executions anchor unavailable',
      rolledBack: 'Offline executions were rolled back',
      onError: this.onAnchorError,
      stored: async () => {
        const result = await this.query('SELECT COALESCE(max(version),0) AS stored FROM app_mixer_offline_executions WHERE tenant_id=$1 AND application_id=$2', [tenantId, applicationId]);
        const stored = Number(result.rows?.[0]?.stored);
        if (!Array.isArray(result.rows) || result.rows.length !== 1 || !Number.isSafeInteger(stored) || stored < 0) throw Error('Invalid shared offline execution');
        return stored;
      }
    });
  }
  /** The change is committed; an anchor failure leaves the anchor behind until the next call catches it up. */
  private async advance(tenantId: string, applicationId: string, result: { rows: Record<string, unknown>[] }): Promise<void> {
    if (!this.anchor) return;
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) throw Error('Invalid shared offline execution');
    await advanceAnchor(this.anchor, offlineExecutionAnchorKey(tenantId, applicationId), version, this.onAnchorError);
  }
  private identity(scope: DataScope, principalId: string, key: string): [string, string, string, string] {
    checkKey(scope, 'principal', principalId);
    if (!uuid(key)) throw Error('Invalid shared offline key');
    return [scope.tenantId, scope.applicationId, principalId, key];
  }
  async get(scope: DataScope, principalId: string, key: string): Promise<SharedOfflineExecution | undefined> {
    const args = this.identity(scope, principalId, key);
    await this.checkAnchor(args[0], args[1]);
    return this.fetch(args);
  }
  private async fetch(args: [string, string, string, string]): Promise<SharedOfflineExecution | undefined> {
    const response = await this.query(
      'SELECT status,attempt_token,result_json FROM app_mixer_offline_executions WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4',
      args
    );
    if (!Array.isArray(response.rows) || response.rows.length > 1) throw Error('Invalid shared offline execution');
    if (!response.rows.length) return undefined;
    const row = response.rows[0]!;
    if (!['ready', 'running', 'uncertain', 'succeeded'].includes(String(row.status)) || !uuid(row.attempt_token)) throw Error('Invalid shared offline execution');
    const status = row.status as SharedOfflineExecution['status'];
    if (status === 'succeeded') {
      if (typeof row.result_json !== 'string') throw Error('Invalid shared offline execution');
      return { status, attemptToken: row.attempt_token, result: dataCopy({ value: JSON.parse(row.result_json) }).value };
    }
    if (row.result_json !== null) throw Error('Invalid shared offline execution');
    return { status, attemptToken: row.attempt_token };
  }
  async execute(
    scope: DataScope,
    principalId: string,
    operationId: string,
    payload: Record<string, unknown>,
    key: string,
    dispatch: (payload: Record<string, unknown>) => Promise<unknown>
  ): Promise<unknown> {
    const identity = this.identity(scope, principalId, key),
      safeScope = { tenantId: identity[0], applicationId: identity[1] },
      safePayload = dataCopy(payload);
    checkKey(safeScope, operationId, 'validation');
    if (typeof dispatch !== 'function') throw Error('Invalid shared offline dispatch');
    await this.checkAnchor(identity[0], identity[1]);
    if (!(await this.keys.verify(safeScope, principalId, operationId, safePayload, key))) throw new AppMixerError('denied', 'Shared offline key forbidden');
    const attempt = randomUUID();
    const claim = await this.query(
      'INSERT INTO app_mixer_offline_executions (idempotency_key,tenant_id,application_id,principal_id,operation_id,status,attempt_token,result_json) SELECT idempotency_key,tenant_id,' +
        "application_id,principal_id,operation_id,'running',$6,NULL FROM app_mixer_offline_request_keys WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND " +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        "operation_id=$5 ON CONFLICT (idempotency_key) DO UPDATE SET status='running',attempt_token=EXCLUDED.attempt_token" +
        this.bump +
        ',' +
        "result_json=NULL WHERE app_mixer_offline_executions.status='ready' AND app_mixer_offline_executions.tenant_id=EXCLUDED.tenant_id AND " +
        'app_mixer_offline_executions.application_id=EXCLUDED.application_id AND app_mixer_offline_executions.principal_id=EXCLUDED.principal_id AND ' +
        'app_mixer_offline_executions.operation_id=EXCLUDED.operation_id RETURNING attempt_token' +
        this.returning,
      [...identity, operationId, attempt]
    );
    if (!Array.isArray(claim.rows) || claim.rows.length > 1 || (claim.rows.length === 1 && claim.rows[0]!.attempt_token !== attempt)) throw Error('Invalid shared offline execution');
    if (claim.rows.length) await this.advance(identity[0], identity[1], claim);
    if (!claim.rows.length) {
      const existing = await this.fetch(identity);
      if (!existing) throw new AppMixerError('denied', 'Shared offline key forbidden');
      if (existing.status === 'succeeded') return existing.result;
      if (existing.status === 'running') throw new AppMixerError('conflict', 'Shared offline operation in progress');
      throw new AppMixerError('conflict', 'Shared offline outcome uncertain');
    }
    try {
      const result = await dispatch(dataCopy(safePayload)),
        serialized = resultJSON(result);
      const written = await this.query(
        "UPDATE app_mixer_offline_executions SET status='succeeded',result_json=$6" +
          this.bump +
          ' WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND attempt_token=$5 AND ' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          '' +
          "status='running' RETURNING attempt_token" +
          this.returning,
        [...identity, attempt, serialized]
      );
      if (!Array.isArray(written.rows) || written.rows.length !== 1 || written.rows[0]!.attempt_token !== attempt) throw Error('Shared offline execution fence lost');
      await this.advance(identity[0], identity[1], written);
      return JSON.parse(serialized);
    } catch {
      try {
        await this.markUncertain(safeScope, principalId, key, attempt);
      } catch {}
      throw new AppMixerError('conflict', 'Shared offline outcome uncertain');
    }
  }
  /** Only after confirming the prior dispatcher cannot still perform the effect. */
  async markUncertain(scope: DataScope, principalId: string, key: string, attemptToken: string): Promise<void> {
    const identity = this.identity(scope, principalId, key);
    if (!uuid(attemptToken)) throw Error('Invalid shared offline attempt');
    await this.checkAnchor(identity[0], identity[1]);
    const result = await this.query(
      "UPDATE app_mixer_offline_executions SET status='uncertain'" +
        this.bump +
        " WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND attempt_token=$5 AND status='running' " +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        'RETURNING attempt_token' +
        this.returning,
      [...identity, attemptToken]
    );
    if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rows[0]!.attempt_token !== attemptToken) throw Error('Shared offline execution changed');
    await this.advance(identity[0], identity[1], result);
  }
  /** The trusted host must independently establish the outcome before reconciliation. */
  async reconcile(scope: DataScope, principalId: string, key: string, attemptToken: string, decision: { outcome: 'applied'; result: unknown } | { outcome: 'not_applied' }): Promise<void> {
    const identity = this.identity(scope, principalId, key);
    if (!uuid(attemptToken) || !decision || !['applied', 'not_applied'].includes(decision.outcome)) throw Error('Invalid shared offline reconciliation');
    const outcome = decision.outcome,
      status = outcome === 'applied' ? 'succeeded' : 'ready',
      resultJson = outcome === 'applied' ? resultJSON(decision.result) : null;
    await this.checkAnchor(identity[0], identity[1]);
    const result = await this.query(
      'UPDATE app_mixer_offline_executions SET status=$6,result_json=$7' +
        this.bump +
        ' WHERE tenant_id=$1 AND application_id=$2 AND principal_id=$3 AND idempotency_key=$4 AND attempt_token=$5 AND ' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        '' +
        "status='uncertain' RETURNING attempt_token" +
        this.returning,
      [...identity, attemptToken, status, resultJson]
    );
    if (!Array.isArray(result.rows) || result.rows.length !== 1 || result.rows[0]!.attempt_token !== attemptToken) throw Error('Shared offline execution changed');
    await this.advance(identity[0], identity[1], result);
  }
}
export type { Options as PostgresOfflineExecutionsOptions };
