import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readCheckpoint,writeCheckpoint} from '../experiments/jev-spatial/checkpoint.ts';
test('checkpoint crash recovery ignores partial proposals and mirror; stale writers fail closed',async()=>{
 await mkdir('.runtime/jev-spatial-test',{recursive:true});const root=await mkdtemp(resolve('.runtime/jev-spatial-test/checkpoint-')),directory=resolve(root,'states'),legacy=resolve(root,'legacy.json'),mirror=resolve(root,'mirror.json');
 await writeFile(legacy,JSON.stringify({attempt:'legacy'}));assert.equal((await readCheckpoint(directory,legacy)).attempt,'legacy');
 const s:any={attempt:'started'};await writeCheckpoint(directory,mirror,s);const first=await readFile(resolve(directory,'state-00000001.json'),'utf8');
 await writeFile(resolve(directory,'state-00000002.json.partial.tmp'),'{');await writeFile(mirror,'broken');assert.equal((await readCheckpoint(directory,legacy)).attempt,'started');
 await assert.rejects(writeCheckpoint(directory,mirror,{attempt:'stale'}),/Stale state writer/);s.attempt='completed';await writeCheckpoint(directory,mirror,s);assert.equal((await readCheckpoint(directory,legacy)).attempt,'completed');assert.equal(await readFile(resolve(directory,'state-00000001.json'),'utf8'),first);
 await writeFile(resolve(directory,'state-00000003.json'),'{');await assert.rejects(readCheckpoint(directory,legacy),SyntaxError);
});
