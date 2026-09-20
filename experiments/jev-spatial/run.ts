import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {initialize,ROOT,freezeRound,runRound,syntheticResponse,state,save} from './campaign.ts';
import {runSpatialTrial,type Flight} from './trial.ts';
import type {Options} from './design.ts';

const command=process.argv[2],number=Number(process.argv[3]);
if(command==='init')await initialize();
else if(command==='smoke'){
 const f:Flight={id:'smoke',arm:'spatial-smoke',seed:3100,kind:'occlusion-course',seconds:Number(process.argv.find(a=>a.startsWith('--seconds='))?.slice(10)??8),options:JSON.parse(process.argv.find(a=>a.startsWith('--options='))?.slice(10)??'{"events":true,"explicit":true,"views":true}'),family:'mechanical-no-inference'};
 console.log(await runSpatialTrial(resolve(ROOT,`smoke-${process.argv[3]??'v1'}`),f,'',async r=>syntheticResponse(r)));
}else if(command==='freeze'){
 const plan=JSON.parse(await readFile(process.argv[4]!,'utf8'));await freezeRound(number,plan,process.argv.find(a=>a.startsWith('--amend='))?.slice(8));console.log(`Frozen round ${number}`);
}else if(command==='run'){
 assert(process.argv.includes('--real'));await runRound(number,process.env.TYPESAFE_API_KEY??process.env.JEV_API_KEY??'');
}else if(command==='analyzed'){
 const s=await state(),r=s.rounds.find((r:any)=>r.number===number);assert(r.status==='executed');r.status='analyzed';r.conclusion=await readFile(process.argv[4]!,'utf8');s.next=`Design round ${number+1} from retained evidence`;await save(s);
}else throw new Error('Use init, smoke, freeze N plan.json, run N --real, analyzed N conclusion.txt');
