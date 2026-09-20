import json,sys,pathlib
from perception import Perception
root=pathlib.Path(sys.argv[1]);trial=sys.argv[2];mode=sys.argv[3]
inputs={};expected={}
for line in (root/(trial+'.jsonl')).open():
 e=json.loads(line)
 if e['kind']=='vision.input':inputs[e['data']['id']]=e['data']
 if e['kind']=='vision.result':expected[e['data']['frameId']]=e['data']['result']
tracker=Perception(mode);count=0
for i,req in inputs.items():
 if i not in expected:continue
 actual=tracker.update(req);want=dict(expected[i]);actual.pop('processingMs');want.pop('processingMs')
 assert actual==want,f'Pixel perception replay mismatch: frame {i}'
 count+=1
print(json.dumps({'processedFramesReplayed':count,'passed':True}))
