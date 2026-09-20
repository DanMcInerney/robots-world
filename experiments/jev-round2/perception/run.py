"""Freeze first, then actual image-only stereo and metric DA2 CPU inference."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import traceback
import cv2
import numpy as np
from common import ROOT,OUT,SOURCE,save,sha,rel,utc,inventory
from measurement import CONFIG,observe,preview


def freeze():
    if (OUT/'offline-freeze.json').exists():
        raise RuntimeError('Refusing overwrite of offline freeze')
    import torch
    import torchvision
    versions=dict(python=sys.version,torch=torch.__version__,torchvision=torchvision.__version__,numpy=np.__version__,opencv=cv2.__version__,platform=platform.platform(),processor=platform.processor(),cpuCount=os.cpu_count(),cudaAvailable=torch.cuda.is_available())
    assert torch.__version__=='2.7.1+cpu' and torchvision.__version__=='0.22.1+cpu'
    assert np.__version__=='2.2.6' and cv2.__version__=='4.12.0'
    save(OUT/'versions.json',versions);save(OUT/'config.json',CONFIG)
    inputs=json.loads((OUT/'input-manifest.json').read_text())
    baseline=ROOT/'experiments/jev-spatial-text/stereo/matching.py'
    files=list(SOURCE.glob('*.py'))+[baseline,ROOT/'experiments/jev-round2/protocol.ts',ROOT/'docs/jev-round2-plan.md']
    files+=list((OUT/'inputs').rglob('*'))+[OUT/p for p in ['input-manifest.json','evaluation-truth.json','config.json','versions.json','pip-freeze.txt','setup-manifest.json']]
    for item in inputs:
        files.extend(ROOT/p for p in item.get('sourcePaths',[]))
    vendors=list((OUT/'vendor').rglob('*'))+list((OUT/'weights').rglob('*'))
    vendor_files=inventory(vendors)
    save(OUT/'vendor-weight-files.json',vendor_files)
    files.append(OUT/'vendor-weight-files.json')
    archived=OUT/'frozen-source';archived.mkdir()
    for p in SOURCE.glob('*.py'):
        (archived/p.name).write_bytes(p.read_bytes())
    (archived/'historical_matching.py').write_bytes(baseline.read_bytes())
    save(OUT/'offline-freeze.json',dict(frozenAt=utc(),status='no model predictions executed yet',files=inventory(set(files)),vendorWeightFiles=vendor_files,
        settings=CONFIG,baselineSource=rel(baseline),baselineEnvironment='.runtime/vision-env',
        primaryGate=dict(split='confirmation',family='nominal',minimumUsable=5,total=6,p95AbsoluteMedianDepthErrorAtMostM=1,underestimateOver2m=0,unknownSceneFamilies=['ambiguous','missing','dark']),
        timing=dict(syntheticPasses=1,realPasses=3,warmup='one development image before retained mono predictions',load='separate',age='capture time unavailable; no acquisition-to-decision measurement'),
        selection='no pipeline tuning or scale fitting after freeze; development and confirmation both fixed before any predictions'))
    print(json.dumps(dict(frozenAt=utc(),files=len(files),vendorFiles=len(vendor_files),versions=versions)),flush=True)


def verify():
    frozen=json.loads((OUT/'offline-freeze.json').read_text())
    for entry in frozen['files']+frozen['vendorWeightFiles']:
        p=ROOT/entry['path']
        if not p.exists() or sha(p)!=entry['sha256']:
            raise RuntimeError(f'Frozen bytes changed: {entry["path"]}')


def run():
    verify()
    if (OUT/'prediction-start.json').exists():
        raise RuntimeError('Refusing repeated prediction attempt')
    save(OUT/'prediction-start.json',dict(startedAt=utc(),freezeSha256=sha(OUT/'offline-freeze.json')))
    inputs=json.loads((OUT/'input-manifest.json').read_text())
    with (OUT/'stereo-run.log').open('w',encoding='utf-8') as log:
        command=[str(ROOT/'.runtime/vision-env/Scripts/python.exe'),'-B','-u',str(SOURCE/'stereo_worker.py')]
        result=subprocess.run(command,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=300)
    if result.returncode:
        raise RuntimeError('Historical stereo worker failed; see stereo-run.log')
    import torch
    torch.set_num_threads(8);torch.set_num_interop_threads(1)
    cv2.setNumThreads(1)
    sys.path.insert(0,str(OUT/'vendor/metric_depth'))
    from depth_anything_v2.dpt import DepthAnythingV2
    began=time.perf_counter()
    model=DepthAnythingV2(encoder='vits',features=64,out_channels=[48,96,192,384],max_depth=80)
    weights=OUT/'weights/depth_anything_v2_metric_vkitti_vits.pth'
    model.load_state_dict(torch.load(weights,map_location='cpu',weights_only=True))
    model=model.float().cpu().eval()
    load_ms=(time.perf_counter()-began)*1000
    warm=cv2.imread(str(ROOT/inputs[0]['leftPath']));began=time.perf_counter()
    with torch.inference_mode():
        model.infer_image(warm,input_size=518)
    warm_ms=(time.perf_counter()-began)*1000
    timings=[]; observations=[]
    for item in inputs:
        directory=OUT/'predictions'/item['id']
        left=cv2.imread(str(ROOT/item['leftPath']));cal=json.loads((ROOT/item['calibrationPath']).read_text())
        times=[];started=utc()
        for i in range(3 if item['kind']=='real' else 1):
            began=time.perf_counter()
            with torch.inference_mode():
                depth=model.infer_image(left,input_size=518)
            times.append((time.perf_counter()-began)*1000)
            if i==0:
                saved_depth=depth.copy()
                np.save(directory/'monocular-depth.npy',saved_depth)
        timings.append(dict(sceneId=item['id'],startedAt=started,replayMs=times))
        mono_valid=np.isfinite(saved_depth)&(saved_depth>0)
        stereo=np.load(directory/'stereo.npz')
        for method,prediction,valid,disparity in [('stereo',stereo['depth'],stereo['valid'],stereo['disparity']),('monocular',saved_depth,mono_valid,None)]:
            cv2.imwrite(str(directory/f'{method}-depth.png'),preview(prediction,valid))
            cv2.imwrite(str(directory/f'{method}-valid.png'),valid.astype(np.uint8)*255)
            if item['kind']=='synthetic':
                observed,mask=observe(left,cal,prediction,valid,method,disparity)
                cv2.imwrite(str(directory/f'{method}-target-mask.png'),mask.astype(np.uint8)*255)
                observations.append(dict(id=item['id']+'-'+method,sceneId=item['id'],split=item['split'],method=method,leftPath=item['leftPath'],rightPath=item['rightPath'],depthPath=rel(directory/f'{method}-depth.png'),observation=observed))
        save(OUT/'observations-image-only.json',observations)
        print(json.dumps(timings[-1]),flush=True)
        if item['id']=='d12':
            save(OUT/'development-predictions-seal.json',dict(sealedAt=utc(),files=inventory((OUT/'predictions').glob('d*/*')),observations=observations.copy(),note='No tuning; stereo worker already executed both frozen splits; this seal precedes monocular confirmation only'))
    save(OUT/'monocular-timing.json',dict(loadMs=load_ms,warmupMs=warm_ms,threads=torch.get_num_threads(),interOpThreads=torch.get_num_interop_threads(),warmupScene=inputs[0]['id'],records=timings,measurement='wall time for upstream infer_image: preprocessing, forward pass, restored depth; excludes image read, disk writes, acquisition and Jev'))
    verify()
    save(OUT/'prediction-completion.json',dict(completedAt=utc(),syntheticPairs=24,realScenes=3,monocularInferenceCalls=34,stereoEstimateCalls=33,freezeSha256=sha(OUT/'offline-freeze.json')))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['freeze','run','verify'])
    args=parser.parse_args()
    try:
        dict(freeze=freeze,run=run,verify=verify)[args.command]()
    except Exception:
        save(OUT/f'{args.command}-failure-{int(time.time())}.json',dict(failedAt=utc(),traceback=traceback.format_exc()))
        raise
