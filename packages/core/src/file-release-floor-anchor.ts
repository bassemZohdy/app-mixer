import type {PublicationReleaseFloorAnchor,PublicationReleaseScope} from './postgres-publication-releases.js';
import {createFileCounters} from './file-counters.js';

const pattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,id=(value:unknown):boolean=>typeof value==='string'&&pattern.test(value);
function name(scope:PublicationReleaseScope):string{
 if(!scope||!id(scope.tenantId)||!id(scope.applicationId)||!id(scope.environment))throw Error('Invalid publication release scope');
 return `${scope.tenantId}__${scope.applicationId}__${scope.environment}`;
}
/**
 * A release-floor anchor stored as one small file per scope in a directory. Point it at storage that a database restore cannot reach
 * (a separate volume, a mounted secret store or a host-owned path), never at the database's own volume. A missing file reads as 0, so
 * the first check adopts the database floor; a corrupt file throws, which makes `isAllowed` fail closed. Writes are atomic
 * (temporary file, fsync, rename) and never lower the floor. Deleting the file removes the protection.
 */
export function createFileReleaseFloorAnchor(directory:string):PublicationReleaseFloorAnchor{
 if(typeof directory!=='string'||!directory)throw Error('Invalid release floor anchor directory');
 const counters=createFileCounters(directory,'.floor');
 return {
  read:scope=>counters.read(name(scope)),
  advance:(scope,floor)=>{if(!Number.isSafeInteger(floor)||floor<0)throw Error('Invalid release floor');counters.advance(name(scope),floor);}
 };
}
