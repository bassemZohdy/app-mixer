import type {PostgresJwtRevocationQuery} from './postgres-jwt-revocations.js';

export type PublicationReleaseScope={tenantId:string;applicationId:string;environment:string};
type Options={query:PostgresJwtRevocationQuery};
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const version=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>0;
const digest=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function args(scope:PublicationReleaseScope):[string,string,string]{if(!scope||!id(scope.tenantId)||!id(scope.applicationId)||!id(scope.environment))throw Error('Invalid publication release scope');return [scope.tenantId,scope.applicationId,scope.environment];}
/** Shared release allowlist and monotonic floor; host owns authorization and the primary database. */
export class PostgresPublicationReleaseRegistry {
 private readonly query:PostgresJwtRevocationQuery;
 constructor(options:Options){if(!options||typeof options.query!=='function')throw Error('Invalid publication release configuration');this.query=options.query;}
 /** Provision with a trusted migration identity before accepting traffic. */
 async initialize():Promise<void>{
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_release_authorizations (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,environment TEXT NOT NULL,version BIGINT NOT NULL,definition_digest TEXT NOT NULL,PRIMARY KEY(tenant_id,application_id,environment,version))',[]);
  await this.query('CREATE TABLE IF NOT EXISTS app_mixer_release_floors (tenant_id TEXT NOT NULL,application_id TEXT NOT NULL,environment TEXT NOT NULL,minimum_version BIGINT NOT NULL,PRIMARY KEY(tenant_id,application_id,environment))',[]);
 }
 /** Trusted administration must independently approve the version and digest. */
 async register(scope:PublicationReleaseScope,releaseVersion:number,definitionDigest:string):Promise<void>{
  const identity=args(scope);if(!version(releaseVersion)||!digest(definitionDigest))throw Error('Invalid publication release');
  const result=await this.query('INSERT INTO app_mixer_release_authorizations (tenant_id,application_id,environment,version,definition_digest) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,application_id,environment,version) DO UPDATE SET definition_digest=app_mixer_release_authorizations.definition_digest WHERE app_mixer_release_authorizations.definition_digest=EXCLUDED.definition_digest RETURNING definition_digest',[...identity,releaseVersion,definitionDigest]);
  if(!Array.isArray(result.rows)||result.rows.length!==1||result.rows[0].definition_digest!==definitionDigest)throw Error('Publication release conflict');
 }
 /** Advance only to an already registered version; concurrent advances cannot lower the floor. */
 async advanceFloor(scope:PublicationReleaseScope,minimumVersion:number):Promise<number>{
  const identity=args(scope);if(!version(minimumVersion))throw Error('Invalid publication release floor');
  const result=await this.query('INSERT INTO app_mixer_release_floors (tenant_id,application_id,environment,minimum_version) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM app_mixer_release_authorizations WHERE tenant_id=$1 AND application_id=$2 AND environment=$3 AND version=$4) ON CONFLICT (tenant_id,application_id,environment) DO UPDATE SET minimum_version=GREATEST(app_mixer_release_floors.minimum_version,EXCLUDED.minimum_version) RETURNING minimum_version',[...identity,minimumVersion]);
  const value=Number(result.rows?.[0]?.minimum_version);if(!Array.isArray(result.rows)||result.rows.length!==1||!version(value)||value<minimumVersion)throw Error('Invalid publication release floor result');return value;
 }
 /** Runtime reads must use the authoritative primary and separately verify the release signature. */
 async isAllowed(scope:PublicationReleaseScope,releaseVersion:number,definitionDigest:string):Promise<boolean>{
  const identity=args(scope);if(!version(releaseVersion)||!digest(definitionDigest))throw Error('Invalid publication release');
  const result=await this.query('SELECT 1 AS allowed FROM app_mixer_release_floors AS f JOIN app_mixer_release_authorizations AS a ON a.tenant_id=f.tenant_id AND a.application_id=f.application_id AND a.environment=f.environment WHERE f.tenant_id=$1 AND f.application_id=$2 AND f.environment=$3 AND a.version=$4 AND a.definition_digest=$5 AND a.version>=f.minimum_version',[...identity,releaseVersion,definitionDigest]);
  if(!Array.isArray(result.rows)||result.rows.length>1||(result.rows.length===1&&result.rows[0].allowed!==1))throw Error('Invalid publication release result');return result.rows.length===1;
 }
}
export type {Options as PostgresPublicationReleaseRegistryOptions};
