// Prints the pinned Docker images the opt-in container tests start, one per line, so CI can cache them.
// Images are found as quoted references with a registry-style name, a tag and optionally a digest.
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url)),reference=/['"]((?:[a-z0-9.-]+\/)+[a-z0-9._-]+:[A-Za-z0-9._-]+(?:@sha256:[a-f0-9]{64})?)['"]/g;
const sources=['agent','cli','core'].flatMap(name=>{const dir=join(root,'packages',name,'test');return [dir,join(dir,'fixtures')].flatMap(folder=>{try{return readdirSync(folder).filter(file=>file.endsWith('.mjs')).map(file=>join(folder,file));}catch{return [];}});});
const images=new Set();
for(const file of sources){const text=readFileSync(file,'utf8');if(!/docker/i.test(text))continue;for(const match of text.matchAll(reference))if(/^(quay\.io|prom|otel|chrislusf|[a-z0-9-]+\/[a-z0-9-]+:)/.test(match[1])&&!match[1].startsWith('node:'))images.add(match[1]);}
console.log([...images].sort().join('\n'));
