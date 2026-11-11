#!/usr/bin/env node
// The control plane's inert record-editor preview (packages/core/src/data-editor-preview.ts) shares its JSON-Schema parser
// with the generated editor (packages/cli/templates/data-editor.mjs); divergence would let the preview accept a schema the
// editor rejects. This script copies that section from the template into the preview module, escaped for a template
// literal. `node scripts/sync-editor-previews.mjs` rewrites the preview; `--check` exits 1 when it is out of date.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=new URL('../',import.meta.url),templatePath=fileURLToPath(new URL('packages/cli/templates/data-editor.mjs',root)),previewPath=fileURLToPath(new URL('packages/core/src/data-editor-preview.ts',root));
const normalize=text=>text.replace(/\r\n/g,'\n');
const escape=text=>text.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$\{/g,'\\${');

/** Start and end offsets of the shared parser: from `function normalizeFields(` to the next top-level function after `fieldsFromJsonSchema`. */
export function sharedSection(source){
 const start=source.indexOf('function normalizeFields('),parser=source.indexOf('function fieldsFromJsonSchema(',start),end=source.indexOf('\nfunction ',parser+1);
 if(start<0||parser<start||end<parser)throw new Error('Shared parser section not found');
 return [start,end];
}
export function synced(templateSource,previewSource){
 const [templateStart,templateEnd]=sharedSection(normalize(templateSource)),section=escape(normalize(templateSource).slice(templateStart,templateEnd));
 const preview=normalize(previewSource),[previewStart,previewEnd]=sharedSection(preview);
 return preview.slice(0,previewStart)+section+preview.slice(previewEnd);
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const template=readFileSync(templatePath,'utf8'),preview=readFileSync(previewPath,'utf8'),crlf=preview.includes('\r\n'),expected=synced(template,preview),current=normalize(preview);
 if(process.argv.includes('--check')){if(current!==expected){console.error('data-editor-preview.ts is out of date; run node scripts/sync-editor-previews.mjs');process.exitCode=1;}else console.log('data-editor-preview.ts is up to date');}
 else if(current===expected)console.log('data-editor-preview.ts already up to date');
 else{writeFileSync(previewPath,crlf?expected.replace(/\n/g,'\r\n'):expected);console.log('Updated data-editor-preview.ts');}
}
