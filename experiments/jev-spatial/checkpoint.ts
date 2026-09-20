import assert from 'node:assert/strict';
import {mkdir,readdir,readFile,writeFile,link,unlink} from 'node:fs/promises';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
async function generations(directory:string){try{return(await readdir(directory)).filter(n=>/^state-\d{8}\.json$/.test(n)).sort();}catch(e:any){if(e.code==='ENOENT')return[];throw e;}}
export async function readCheckpoint(directory:string,legacy:string){const files=await generations(directory);return JSON.parse(await readFile(files.length?resolve(directory,files.at(-1)!):legacy,'utf8'));}
export async function writeCheckpoint(directory:string,mirror:string,s:any){
 await mkdir(directory,{recursive:true});const files=await generations(directory),previous=files.length?Number(files.at(-1)!.slice(6,14)):0;
 assert.equal(s.durability?.generation??0,previous,'Stale state writer; reload authoritative checkpoint');
 const generation=previous+1,final=resolve(directory,`state-${String(generation).padStart(8,'0')}.json`),durability={authority:'Latest complete numbered state-checkpoints/state-XXXXXXXX.json; temporary files are uncommitted',generation,reportMirror:'campaign-state-view.json; nonauthoritative'};
 const bytes=JSON.stringify({...s,durability},null,2),tmp=final+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx');try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 await link(tmp,final); // Atomic exclusive publication of fsynced bytes. EEXIST fails closed; never replace an open file.
 s.durability=durability;try{await unlink(tmp);}catch{} // A leftover temporary link is ignored by readers.
 try{await writeFile(mirror,bytes);}catch(e){console.warn(`Durable checkpoint committed; report mirror update failed: ${String(e)}`);}
}
