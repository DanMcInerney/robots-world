"""Evaluate frozen image sequences; evaluation labels never enter Perception.update."""
import json,pathlib,sys,time,numpy as np,hashlib
from perception import Perception,overlap,plain
root=pathlib.Path(sys.argv[1]);fixtures=json.loads((root/'fixtures.json').read_text());models=pathlib.Path('.runtime/vision-models');rows=[]
for sequence in fixtures['sequences']:
 for mode in ['colour','klt','nano']:
  tracker=Perception(mode,models);samples=[];last_id=None;switches=0;lost=False;recovered=None
  for f in sequence['frames']:
   req={k:f[k] for k in ['id','acquiredMs','calibration','objects','camera']};req['file']=str(root/f['file'])
   assert hashlib.sha256(pathlib.Path(req['file']).read_bytes()).hexdigest()==f['sha256']
   result=tracker.update(req);box=f['evaluation']['box'];matching=sorted(result['objects'],key=lambda o:overlap(o['box'],box),reverse=True) if box else []
   obj=matching[0] if matching and overlap(matching[0]['box'],box)>.25 else None
   # For neutral targets, exclude differently coloured covering regions; geometry is scoring only.
   expected='neutral' if sequence['variant']=='gray' else 'blue'
   obj=obj if obj and obj['color']==expected else None
   covered=f['evaluation']['fullOcclusion']
   if obj and last_id and obj['id']!=last_id:switches+=1
   if obj:last_id=obj['id']
   if covered:lost=True
   if lost and not covered and obj and recovered is None:recovered=f['acquiredMs']
   samples.append({'at':f['acquiredMs'],'matched':obj is not None,'iou':overlap(obj['box'],box) if obj else None,'fullOcclusion':covered,'flagged':bool(obj and obj.get('possibleOcclusion')),'processingMs':result['processingMs'],'result':result})
  rows.append({'phase':sequence['phase'],'seed':sequence['seed'],'variant':sequence['variant'],'mode':mode,'frames':len(samples),'matchedVisible':sum(s['matched'] and not s['fullOcclusion'] for s in samples),'visibleFrames':sum(not s['fullOcclusion'] for s in samples),'falseObservedWhileFullyOccluded':sum(s['matched'] and s['fullOcclusion'] for s in samples),'falseOcclusionFlagsUnoccluded':sum(s['flagged'] for s in samples if sequence['variant']!='occlusion'),'identityChanges':switches,'recoveredAtMs':recovered,'processingP50Ms':float(np.median([s['processingMs'] for s in samples])),'samples':samples})
  print(json.dumps({k:v for k,v in rows[-1].items() if k!='samples'}),flush=True)
out={'rows':rows,'models':[{ 'file':f.name,'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size} for f in models.glob('*.onnx')],'limits':'Synthetic fixtures, desktop timing. Observed requires a current pixel detection; a tracker prediction never establishes visible. No real camera or board qualification. Initial region discovery is colour plus neutral edge components, not a semantic detector.'}
(root/'qualification.json').write_text(json.dumps(out,default=plain,allow_nan=False))
