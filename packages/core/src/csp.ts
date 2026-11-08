import {createHash} from 'node:crypto';

/**
 * Content-Security-Policy source expressions ('sha256-...') for the inline <script> and <style> blocks of a trusted, static HTML page,
 * so the page needs no 'unsafe-inline'. Blocks with a src attribute are external and are skipped.
 */
export function inlineHashes(html:string,tag:'script'|'style'):string[]{
 const blocks=new RegExp('<'+tag+'(\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','g'),hashes:string[]=[];
 for(const match of html.matchAll(blocks)){if(/\ssrc=/.test(match[1]??''))continue;hashes.push("'sha256-"+createHash('sha256').update(match[2]??'').digest('base64')+"'");}
 return hashes;
}
