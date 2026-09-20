// Post-inference integrity audit. No inference, actuator effects or evaluator data enter a controller.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {sourceHash} from '../reactive/run.ts';
import {colorTracker} from '../../src/perception/color-tracks.ts';
import {readFramePng} from '../../src/devices/pixel-camera.ts';
import {hypothesisDesign} from './design.ts';

const root=resolve(process.argv[2]??'.runtime/experiments/jev-hypotheses-v1');
const json=async path=>JSON.parse(await readFile(resolve(root,path),'utf8'));
const wire=value=>JSON.parse(JSON.stringify(value));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const freeze=await json('freeze.json'),analysis=await json('analysis.json');
assert.equal(await sourceHash(),freeze.sourceHash,'Current runtime source differs from frozen source');
assert.equal(createHash('sha256').update(freeze.sourceHash).update(await readFile('experiments/jev-hypotheses/flow.py')).update(await readFile('docs/jev-hypothesis-tests.md')).digest('hex'),freeze.hash);
for(const file of freeze.files)assert.deepEqual(await readFile(file),await readFile(resolve(root,'source',file)),`Frozen file differs: ${file}`);

const cases=await json('static/cases.json'),statics=await json('static/report.json');
assert(statics.complete);assert.deepEqual(statics.errors,[]);assert.equal(statics.sourceHash,freeze.hash);
assert.equal(cases.length,24);assert.equal(statics.rows.length,144);
for(const c of cases){
  const png=await readFile(resolve(root,'static',c.observation.sensors.camera.value.frame));
  assert.equal(hash(png),c.sha256);
  const replay=wire(colorTracker()(readFramePng(png),c.calibration,c.observation.sensors.camera.acquiredSimMs));
  assert.deepEqual(replay.objects,c.observation.sensors.camera.value.objects);
}
for(const row of statics.rows){
  assert.deepEqual(row.observation,cases.find(c=>c.id===row.case).observation);
  const design=hypothesisDesign({representation:row.representation});
  assert.deepEqual(wire(design.request(row.observation,row.representation,[])),row.request);
  assert.deepEqual(wire(design.map(row.request,row.response)),row.mapping);
}

const flights=await json('flights/report.json'),trajectories=new Map();
assert.equal(flights.runs.length,22);assert(!flights.stopped);assert.deepEqual(flights.invalid,[]);
let completed=0,requests=0,frames=0,unseenSameGoal=0,checkedSameGoal=0;
for(const row of flights.runs){
  const run=await json(`flights/${row.file}`);
  assert.equal(run.sourceHash,freeze.sourceHash);assert.equal(run.metrics.errors,0);
  for(const key of ['pixelReplay','exactRequests','exactMapping'])assert.equal(run.audit[key],true);
  completed+=run.metrics.completed;requests+=run.metrics.requestsAudited;frames+=run.metrics.framesAudited;
  const external=run.evaluation.trajectory.map(({simMs,target,crossing,goalVersion})=>({simMs,target,crossing,goalVersion}));
  if(trajectories.has(row.seed))assert.deepEqual(external,trajectories.get(row.seed),`External stimuli differ: ${row.id}`);
  else trajectories.set(row.seed,external);
  if(flights.manifest.definitions[row.arm].wait){
    const decisions=run.decisions.filter(d=>d.mapping);
    for(let i=1;i<decisions.length;i++){
      const prior=decisions[i-1],next=decisions[i];
      if(prior.firstApplication&&prior.observation.goal===next.observation.goal){
        checkedSameGoal++;
        if(next.observation.sensors.camera.acquiredSimMs<prior.firstApplication.simMs)unseenSameGoal++;
      }
    }
  }
}
assert.equal(completed,analysis.totals.flightDecisions);assert.equal(requests,analysis.totals.requestAudits);assert.equal(frames,analysis.totals.frameAudits);
assert.equal(unseenSameGoal,0);assert.equal(checkedSameGoal,637);

// Archive the posthoc methods separately; they were not in the frozen controller cohort.
await mkdir(resolve(root,'methods'),{recursive:true});
const methods=[];
for(const path of ['experiments/jev-hypotheses/analyze.mjs','experiments/jev-hypotheses/verify.mjs','experiments/jev-hypotheses/report.html','docs/jev-hypothesis-results.md','docs/design-failures.md']){
  const bytes=await readFile(path);const dest=`methods/${basename(path)}`;
  await copyFile(path,resolve(root,dest));methods.push({source:path,archive:dest,sha256:hash(bytes)});
}
const result={passed:true,recordedAt:new Date().toISOString(),experimentHash:freeze.hash,frozenFiles:freeze.files.length,
  staticPngReplay:cases.length,staticRequestAndMappingReplay:statics.rows.length,
  flights:flights.runs.length,completed,requests,frames,matchedExternalTrajectories:true,checkedSameGoal,unseenSameGoal,
  note:'Flight RGB/request/mapping audits ran during report construction. This verification checks those successful audit records, frozen source, matched external stimuli, and independently replays all static cases. Posthoc methods are archived separately.',methods};
await writeFile(resolve(root,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
