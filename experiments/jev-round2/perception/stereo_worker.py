"""Run the unchanged historical matcher under its original Python/OpenCV."""
import json
import sys
import time
import cv2
import numpy as np
from common import ROOT,OUT,save,rel,utc
sys.path.insert(0,str(ROOT/'experiments/jev-spatial-text/stereo'))
from matching import estimate, PARAMETERS


def main():
    records=json.loads((OUT/'input-manifest.json').read_text())
    timings=[]
    for record in records:
        cal=json.loads((ROOT/record['calibrationPath']).read_text())
        # Both methods start from these identical retained BGR arrays. The
        # unchanged stereo baseline requires grayscale; conversion is explicit.
        left=cv2.cvtColor(cv2.imread(str(ROOT/record['leftPath'])),cv2.COLOR_BGR2GRAY)
        right=cv2.cvtColor(cv2.imread(str(ROOT/record['rightPath'])),cv2.COLOR_BGR2GRAY)
        replay=[]; start_at=utc()
        for i in range(3 if record['kind']=='real' else 1):
            began=time.perf_counter();result=estimate(left,right,cal);replay.append((time.perf_counter()-began)*1000)
            if i==0:
                destination=OUT/'predictions'/record['id'];destination.mkdir(parents=True,exist_ok=True)
                np.savez_compressed(destination/'stereo.npz',**{k:result[k] for k in ['depth','disparity','rawLeft','rawRight','rawValid','valid','leftRightErrorPx','textureStd']})
        timings.append(dict(sceneId=record['id'],startedAt=start_at,replayMs=replay,initializationMs=result['initializationMs'],estimateMs=result['estimateMs']))
        print(json.dumps(timings[-1]),flush=True)
    save(OUT/'stereo-timing.json',dict(python=sys.version,opencv=cv2.__version__,numpy=np.__version__,parameters=PARAMETERS,records=timings))


if __name__=='__main__':
    main()
