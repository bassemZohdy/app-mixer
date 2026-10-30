import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {signPublicationRelease,verifyPublicationRelease} from '../dist/index.js';
const publication={version:7,definition:{id:'demo',schemaVersion:1,revision:1,pages:[]}},first=generateKeyPairSync('ed25519'),second=generateKeyPairSync('ed25519'),keyId='release-1',keys=[{keyId,publicKey:first.publicKey}];
test('signed releases bind content, version, environment, application and trusted signing key',()=>{
 const release=signPublicationRelease(publication,'production',keyId,first.privateKey);assert.deepEqual(verifyPublicationRelease(release,'production','demo',keys),publication);publication.definition.revision=2;assert.equal(release.publication.definition.revision,1);publication.definition.revision=1;
 for(const changed of [{...release,environment:'staging'},{...release,keyId:'other'},{...release,publication:{...release.publication,version:8}},{...release,publication:{...release.publication,definition:{...release.publication.definition,id:'other'}}},{...release,signature:'A'.repeat(86)},{...release,extra:true}])assert.throws(()=>verifyPublicationRelease(changed,'production','demo',keys),/Invalid signed publication/);
 assert.throws(()=>verifyPublicationRelease(release,'staging','demo',keys),/Invalid signed publication/);assert.throws(()=>verifyPublicationRelease(release,'production','other',keys),/Invalid signed publication/);assert.throws(()=>verifyPublicationRelease(release,'production','demo',[{keyId,publicKey:second.publicKey}]),/Invalid signed publication/);assert.deepEqual(verifyPublicationRelease(release,'production','demo',[{keyId:'new',publicKey:second.publicKey},...keys]),release.publication);assert.throws(()=>verifyPublicationRelease(release,'production','demo',[{keyId:'new',publicKey:second.publicKey}]),/Invalid signed publication/);
});
test('invalid signing keys, publication and trust settings fail closed',()=>{
 assert.throws(()=>signPublicationRelease(publication,'production','id',first.publicKey),/configuration/);assert.throws(()=>signPublicationRelease({...publication,version:0},'production','id',first.privateKey),/publication/);const release=signPublicationRelease(publication,'production',keyId,first.privateKey);assert.throws(()=>verifyPublicationRelease(release,'production','demo',[]),/configuration/);assert.throws(()=>verifyPublicationRelease(release,'production','demo',[...keys,...keys]),/configuration/);
});
