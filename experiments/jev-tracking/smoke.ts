// Mechanical integration only: synthetic responses are never scored as AI evidence.
import {runTrial} from './trial.ts';
import {MODEL,type Response} from '../jev-strategies/strategies.ts';
const root=process.argv[2]??'.runtime/experiments/jev-tracking-smoke-v1';
for(const arm of ['colour-direct','klt-servo'] as const){
 const row=await runTrial(root,arm,1601,'constant','mechanical-fixture',async r=>({model:MODEL,answers:Object.fromEntries(Object.entries(r.questions).map(([id,q])=>{const keys=Object.keys(q.criteria),chosen=id==='target'?keys.find(k=>k!=='none')??'none':keys.find(k=>k==='follow'||k==='hold'||k==='wide')??keys[0]!;return[id,{type:'choice',choice:chosen,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===chosen?1:0]))}];}))} as Response),3);
 console.log(JSON.stringify({mechanicalOnly:true,...row}));
}
