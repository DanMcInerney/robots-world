import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, ledger, readCompleted } from '../jev-spatial-text/transport.ts';
import type { RefineCase } from './types.ts';

export const PRIOR_ROOT = resolve('.runtime/experiments/jev-spatial-text-v1');
export const HISTORY_ARMS = ['receipts','linked-eight','diary-eight','tuple-eight','linked-two','neutral-padding'] as const;
const COLUMNS = ['id','commandId','atMs','kind','value'] as const;
export function tupleHistory(cards: any[]) {
  return {columns:[...COLUMNS],rows:cards.flatMap(c=>c.facts.map((f:any)=>COLUMNS.map(k=>f[k])))};
}
export function decodeTupleHistory(table: ReturnType<typeof tupleHistory>) {
  assert.deepEqual(table.columns,[...COLUMNS]);
  return table.rows.map((r:any[])=>Object.fromEntries(COLUMNS.map((k,i)=>[k,r[i]])));
}
const wrap = (x:number) => ((x+180)%360+360)%360-180;
const YAW = {left_30:30,left_10:10,left_3:3,retain:0,right_3:-3,right_10:-10,right_30:-30};
/** Evaluator-only stationary full-settling proxy. It is NOT a realized future outcome. */
export function snapshotProgress(request: RefineCase['request']) {
  const s=request.state, objects=s.snapshot.objects.filter((o:any)=>o.color==='blue');
  if(objects.length!==1 || s.snapshot.overflow || objects[0].clipped) return {scorable:false,reason:'No unique unclipped current region',acceptable:[] as string[],perAction:{}};
  const [left,,right]=objects[0].box, {fx,cx}=s.camera.calibration;
  const initial=((left+right)/2-cx)/cx, halfFov=s.camera.horizontalFovDeg/2;
  const radians=Math.PI/180, leftAngle=Math.atan((left-cx)/fx)/radians, rightAngle=Math.atan((right-cx)/fx)/radians;
  const perAction=Object.fromEntries(Object.entries(YAW).map(([action,amount])=>{
    const delta=action==='retain'?wrap(s.controls.lastAcceptedHeadingDeg-s.controls.acquiredHeadingDeg):amount;
    const a=leftAngle+delta,b=rightAngle+delta,unclipped=a>=-halfFov && b<=halfFov;
    const normalized=unclipped?(Math.tan(a*radians)+Math.tan(b*radians))*fx/(2*cx):null;
    const inside=normalized!==null && Math.abs(normalized)<=.3;
    const improves=normalized!==null && Math.abs(normalized)<Math.abs(initial)-1e-9;
    return [action,{deltaDeg:delta,normalizedCenter:normalized,unclipped,inside,improves,
      acceptable:Math.abs(initial)<=.3?inside:unclipped&&improves}];
  }));
  const acceptable=Object.entries(perAction).filter(([,v])=>v.acceptable).map(([k])=>k);
  assert(acceptable.length,'Valid measured geometry should have a progress or maintain option');
  return {scorable:true,reason:'Measured-box reprojection if target were stationary and selected setpoint fully completed; not observed control success',initialNormalizedCenter:initial,acceptable,perAction};
}
export async function generateHistoryCases():Promise<RefineCase[]> {
  const rows=new Map(ledger(PRIOR_ROOT).map(r=>[r.id,r])), result:RefineCase[]=[];
  // Preregistered fixed ordinals: not selected by an answer, confidence or later outcome.
  for(let pattern=0;pattern<4;pattern++)for(let mirror=0;mirror<2;mirror++)for(const ordinal of [4,12,28]) {
    const id=`yaw-v2-${pattern}-${mirror}-linked-q${String(ordinal).padStart(4,'0')}`;
    const request=JSON.parse(await readFile(resolve(PRIOR_ROOT,'requests',id+'.json'),'utf8'));
    await readCompleted(request,id,rows.get(id),PRIOR_ROOT);
    assert(Array.isArray(request.state.history));
    const originalBytes=JSON.stringify(request), cards=structuredClone(request.state.history), facts=cards.flatMap((c:any)=>c.facts);
    assert.deepEqual(decodeTupleHistory(tupleHistory(cards)),facts);
    const base=structuredClone(request); delete base.state.history;
    base.state.replayContext='Recorded decision snapshot. Evaluate at its stated snapshot and control state; old wall-clock dates do not mean newly stale evidence. This replay does not execute a command or observe its future.';
    const linked=structuredClone(base); linked.state.history=cards;
    const proxy=snapshotProgress(base), bytes=Buffer.byteLength(JSON.stringify(linked));
    const variants=HISTORY_ARMS.map(arm=>{
      const r=structuredClone(base);
      if(arm==='linked-eight')r.state.history=cards;
      if(arm==='diary-eight')r.state.history=[...facts].sort((a:any,b:any)=>a.atMs-b.atMs || a.id.localeCompare(b.id));
      if(arm==='tuple-eight')r.state.history=tupleHistory(cards);
      if(arm==='linked-two')r.state.history=cards.slice(-2);
      if(arm==='neutral-padding') {
        r.state.paddingDescription='The padding field is unrelated text, with no sensor observations or command information.';
        r.state.padding=''; const n=bytes-Buffer.byteLength(JSON.stringify(r)); assert(n>0);
        r.state.padding='unused '.repeat(Math.ceil(n/7)).slice(0,n);
        assert.equal(Buffer.byteLength(JSON.stringify(r)),bytes);
      }
      return {arm,request:r};
    });
    for(const {arm,request:r} of variants)for(let replicate=0;replicate<3;replicate++)result.push({
      id:`history-p${pattern}-m${mirror}-q${ordinal}-${arm}-r${replicate}`,stage:'history',split:'regression',
      unit:`history-p${pattern}-q${ordinal}`,arm,replicate,request:structuredClone(r),
      expected:proxy.scorable?{yaw:proxy.acceptable}:{},
      meta:{sourceRequestId:id,sourceRequestSha256:digest(originalBytes),pattern,mirror,ordinal,proxyOnly:true,
        sourceHistoryCards:cards.length,sourceAtomicFacts:facts.length,fullFactManifest:digest(JSON.stringify(facts)),
        factTreatment:arm==='linked-two'?'Only latest two supplied episodes retained':arm==='receipts'||arm==='neutral-padding'?'History removed; original two receipts retained':'Same full atomic history facts, lossless layout change',
        paddingMatches:'Exact UTF-8 request bytes of linked-eight, not model tokens',proxy,
        provenance:'Archived actual Jev command/measurement history; repeated counterfactual text replay, not a new executed trajectory or fresh holdout'}});
  }
  assert.equal(result.length,432);return result;
}
