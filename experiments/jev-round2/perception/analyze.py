"""Evaluator-only summaries. No fitting, filtering or revised model settings."""
import json
import numpy as np
from common import ROOT,OUT,save,sha,rel,utc,inventory


def errors(pred,gt,support):
    difference=pred[support].astype(np.float64)-gt[support].astype(np.float64)
    return dict(pixels=int(support.sum()),maeM=float(np.mean(np.abs(difference))) if difference.size else None,
                signedBiasM=float(np.mean(difference)) if difference.size else None,
                p95AbsoluteErrorM=float(np.quantile(np.abs(difference),.95)) if difference.size else None,
                absoluteErrorSumM=float(np.sum(np.abs(difference))) if difference.size else 0)


def metric(pred,gt,support,gtvalid):
    support=support&gtvalid&np.isfinite(pred)&(pred>0)
    n=int(gtvalid.sum()); m=int(support.sum())
    return dict(allGTPixels=n,retainedPixels=m,unknownGTPixels=n-m,validCoverage=m/n if n else None,
                allGTMAEM=errors(pred,gt,support)['maeM'] if n==m and n else None,
                allGTMAEMeaning='null when any GT pixel is unknown; missing pixels are not scored as zero error',
                retained=errors(pred,gt,support))


def synthetic(records):
    rows=[]
    for split in ['development','confirmation']:
        for method in ['stereo','monocular']:
            items=[r for r in records if r['split']==split and r['method']==method]
            nominal=[r for r in items if r['evaluation']['family']=='nominal']
            usable=[r for r in nominal if r['observation']['axialDepthM'] is not None]
            delta=[r['observation']['axialDepthM']-r['evaluation']['referenceAxialDepthM'] for r in usable]
            unknown=[r for r in items if r['evaluation']['family'] in ['ambiguous','missing','dark']]
            unknown_pass=all(r['observation']['axialDepthM'] is None and r['observation']['axialDepthIntervalM'] is None for r in unknown)
            # Frozen finite-scene gate uses nearest rank (maximum for six).
            p95=float(sorted(np.abs(delta))[int(np.ceil(.95*len(delta)))-1]) if delta else None
            row=dict(split=split,method=method,nominalScenes=len(nominal),usableNominal=len(usable),usableFraction=len(usable)/len(nominal),maeM=float(np.mean(np.abs(delta))) if delta else None,signedBiasM=float(np.mean(delta)) if delta else None,p95AbsoluteMedianDepthErrorM=p95,underestimateOver2m=sum(x < -2 for x in delta),unknownScenes=len(unknown),allUnknownScenesAbstain=unknown_pass)
            row['gatePass']=len(usable)>=5 and p95 is not None and p95<=1 and row['underestimateOver2m']==0 and unknown_pass
            rows.append(row)
    return dict(completedAt=utc(),primary='predeclared nominal confirmation gate; challenges reported separately',sceneCount=24,sensorRecords=48,rows=rows,
                challenges=[dict(recordId=r['id'],family=r['evaluation']['family'],referenceAxialDepthM=r['evaluation']['referenceAxialDepthM'],observation=r['observation'],errorM=(r['observation']['axialDepthM']-r['evaluation']['referenceAxialDepthM']) if r['observation']['axialDepthM'] is not None and r['evaluation']['referenceAxialDepthM'] is not None else None) for r in records if r['evaluation']['family']!='nominal'],
                limits=['Fresh procedural textured planes are calibration/mechanics cases, not natural-image generalization evidence.','Metric monocular q10/q90 is spatial spread, not calibrated uncertainty.','No temporal scale stability, 3D clearance, semantic cars, acquired latency or flight was tested.'])


def real(inputs):
    rows=[]
    bins=[(0,2),(2,4),(4,6),(6,8),(8,9),(9,11),(11,14),(14,100)]
    for item in inputs:
        if item['kind']!='real':
            continue
        directory=OUT/'predictions'/item['id']
        gt=np.load(ROOT/item['calibrationPath'].replace('calibration.json','reference-depth-evaluator-only.npy'))
        gtvalid=np.isfinite(gt)&(gt>0)
        stereo=np.load(directory/'stereo.npz');mono=np.load(directory/'monocular-depth.npy')
        mv=np.isfinite(mono)&(mono>0);common=gtvalid&stereo['valid']&mv
        methods={}
        for name,pred,support in [('stereo',stereo['depth'],stereo['valid']),('monocular',mono,mv)]:
            stats=metric(pred,gt,support,gtvalid)
            stats['commonSupport']=errors(pred,gt,common)
            stats['commonSupportFractionOfAllGT']=float(common.sum()/gtvalid.sum())
            stats['depthBins']=[dict(referenceBinM=[low,high],**metric(pred,gt,support,gtvalid&(gt>=low)&(gt<high))) for low,high in bins]
            if name=='stereo':
                stats['rawBeforeTextureAndLRFiltering']=metric(pred,gt,stereo['rawValid'],gtvalid)
            methods[name]=stats
        rows.append(dict(sceneId=item['id'],resolution=[gt.shape[1],gt.shape[0]],gtPixels=int(gtvalid.sum()),referenceDepthRangeM=[float(gt[gtvalid].min()),float(gt[gtvalid].max())],reference9to11mPixels=int((gtvalid&(gt>=9)&(gt<=11)).sum()),methods=methods))
    return dict(completedAt=utc(),sceneCount=3,reusedRegressionData=True,scaleFitToGT=False,rows=rows,reference9to11mPixels=sum(r['reference9to11mPixels'] for r in rows),denominatorContract='All-GT support/unknown counts always retained. Error summaries use each method retained support; common support is secondary. No unknown prediction contributes zero error.',boundary='Three static, previously used Middlebury scenes resized to 768 wide; no real 10m target evidence, capture clock or temporal qualification.')


def main():
    if (OUT/'manifest.json').exists():
        raise RuntimeError('Refusing overwrite of completed analysis')
    observations=json.loads((OUT/'observations-image-only.json').read_text())
    truth={r['sceneId']:r for r in json.loads((OUT/'evaluation-truth.json').read_text())}
    records=[]
    for r in observations:
        t=truth[r['sceneId']]
        r['evaluation']=dict(referenceAxialDepthM=t['referenceAxialDepthM'],family=t['family'])
        records.append(r)
    assert len(records)==48
    save(OUT/'sensor-records.json',records)
    synthetic_summary=synthetic(records);save(OUT/'synthetic-summary.json',synthetic_summary)
    real_summary=real(json.loads((OUT/'input-manifest.json').read_text()));save(OUT/'real-summary.json',real_summary)
    mono_time=json.loads((OUT/'monocular-timing.json').read_text());stereo_time=json.loads((OUT/'stereo-timing.json').read_text())
    timings={}
    for name,data in [('stereo',stereo_time),('monocular',mono_time)]:
        values=[v for r in data['records'] for v in r['replayMs']]
        timings[name]=dict(p50Ms=float(np.median(values)),p95Ms=float(np.quantile(values,.95)),minimumMs=min(values),maximumMs=max(values),timedPasses=len(values))
    save(OUT/'timing-summary.json',timings)
    lines=['# Round 2 offline metric-depth experiment','',
        'Actual Depth Anything V2 Metric VKITTI Small and the unchanged historical SGBM matcher ran on all 24 fresh synthetic stereo pairs and three reused Middlebury scenes. No Jev API calls or flight were executed by this offline pipeline.','',
        '## Frozen methods','',
        'The source/config/input/vendor/weight freeze preceded every model prediction. CPU DA2: official source a561b849ebae10a6f5ef49e26c83cbbcd36c71bf, checkpoint SHA256 9203e538d35255c90dda4b7fedb47ff33fe725497bcca3b1e53b3a65ee63f0cb, vits, 80m max depth, 518 input, float32, eight threads, no per-image GT scale fit. Python 3.12.4, torch 2.7.1+cpu, torchvision 0.22.1+cpu, NumPy 2.2.6, OpenCV 4.12.0. Exact transitive packages are in pip-freeze.txt.','',
        'SGBM runs the unmodified experiments/jev-spatial-text/stereo/matching.py under existing Python 3.14.6 / OpenCV 5.0.0 / NumPy 2.5.3; all settings and source hash are retained. Both pipelines read identical saved BGR images, with explicit grayscale conversion for SGBM. Render generation/resize, HSV measurement and display use OpenCV 4.12.0. This preprocessing environment boundary is disclosed; the historical matcher is unchanged.','',
        'Shared image-only blue HSV connected components (minimum 100 pixels), exactly one component and 3-pixel erosion define the target ROI. No reference depth or known physical target size enters measurement. At least 50% positive/valid ROI support is required. Ambiguous, missing and dark images emit null depth. Stereo quantiles expand disparity by +/-0.5 px; DA2 depth quantiles are descriptive spatial spread. Neither is calibrated confidence. A dense finite monocular output does not establish certainty.','',
        '## Synthetic results','',
        'Six nominal planes per split span 7.5–13.8m; challenge cases separately include two 40% occlusions, low texture, two blue components, missing blue and darkness. Images are 640x360, 70-degree horizontal FOV, 0.20m baseline. Each target frontplane is 1.8x1.2m; background is 22m. Split texture seeds are independent. These tiny procedural images cannot qualify natural-image model generalization.','',
        '| Split | Method | Usable nominal | MAE m | p95 abs median-Z error m | >2m underestimates | Unknowns correct | Gate |','|---|---|---:|---:|---:|---:|---|---|']
    def fmt(value):
        return 'unknown' if value is None else f'{value:.3f}'
    for row in synthetic_summary['rows']:
        lines.append(f"| {row['split']} | {row['method']} | {row['usableNominal']}/6 | {fmt(row['maeM'])} | {fmt(row['p95AbsoluteMedianDepthErrorM'])} | {row['underestimateOver2m']} | {row['allUnknownScenesAbstain']} | {row['gatePass']} |")
    lines+=['','Primary gate: at least 5/6 usable nominal confirmation scenes, p95 absolute median-depth error <=1m, zero >2m underestimates, and null output in all three unknown cases. No post-result tuning or candidate promotion. All challenges and per-scene estimates remain in synthetic-summary.json and sensor-records.json.','',
             '## Reused real-image regression','',
             'Three independent static Middlebury scenes, RGB resized to 768 pixels wide with INTER_AREA, nearest-neighbor GT disparity and adjusted calibration. Both methods process exactly the same saved left image. SGBM also receives the matching right image. Metrics retain each method all-GT population, retained support, unknown count, per-depth-bin results, and secondary common-support errors. An all-GT MAE is null if any GT pixel has unknown prediction; available-error averages never silently score unknowns as zero.','',
             '| Scene | Method | Coverage | Retained MAE m | Bias m | p95 m | Common MAE m |','|---|---|---:|---:|---:|---:|---:|']
    for row in real_summary['rows']:
        for method,stats in row['methods'].items():
            e=stats['retained'];c=stats['commonSupport']
            lines.append(f"| {row['sceneId']} | {method} | {100*stats['validCoverage']:.1f}% | {fmt(e['maeM'])} | {fmt(e['signedBiasM'])} | {fmt(e['p95AbsoluteErrorM'])} | {fmt(c['maeM'])} |")
    lines+=['',f"Valid resized reference pixels in 9–11m: **{real_summary['reference9to11mPixels']}**. These scenes do not validate real 10m target ranging. Correlated pixels and timing repeats do not increase the scene count beyond three.",'','## Timing and retained setup failure','',
             f"DA2 cold construction/checkpoint load: {mono_time['loadMs']:.1f} ms; one discarded development-image warmup: {mono_time['warmupMs']:.1f} ms. There were 24 synthetic predictions, three passes on each of three real images, plus the warmup (34 DA2 forwards). Real repeats are timing-only, with the first prediction retained. Stereo ran 33 matching calls.",'']
    for name,t in timings.items():
        lines.append(f"- {name}: p50 {t['p50Ms']:.1f} ms, p95 {t['p95Ms']:.1f} ms, max {t['maximumMs']:.1f} ms over {t['timedPasses']} passes.")
    setup=json.loads((OUT/'setup-manifest.json').read_text())
    lines+=['',f"Recorded downloaded artifacts: {setup['totalArtifactDownloadBytes']:,} bytes under the 750,000,000-byte ceiling (package-index/metadata traffic not included in artifact sizes). Socket timeouts were 60 seconds and setup subprocess/download limits 600 seconds. The first offline install failed because the Python-3.12 setuptools dependency was absent from the wheelhouse; no model prediction had run. The original failure/log is retained and setuptools 80.9.0 was fetched before successful installation. No model/pipeline settings changed after prediction freeze.",
             '', 'Inference timing excludes capture, transport, acquisition-to-decision age and disk writing; it is desktop CPU processing evidence, not onboard qualification. No temporal-scale stability, semantic car recognition, 3D obstacle clearance, tracking, following or flight is established.','',
             '## Reproduction and evidence','',
             '```powershell',
             '& .runtime/experiments/jev-round2-v1/perception/env/Scripts/python.exe -B experiments/jev-round2/perception/generate.py',
             '& .runtime/experiments/jev-round2-v1/perception/env/Scripts/python.exe -B experiments/jev-round2/perception/run.py freeze',
             '& .runtime/experiments/jev-round2-v1/perception/env/Scripts/python.exe -B -u experiments/jev-round2/perception/run.py run',
             '& .runtime/experiments/jev-round2-v1/perception/env/Scripts/python.exe -B experiments/jev-round2/perception/analyze.py',
             '```','',
             'Completed runs refuse overwrites. For reproduction, use an explicitly separate output root. offline-freeze.json authenticates pre-prediction sources, config, inputs, reference/calibration bytes, vendor files and checkpoint. manifest.json links primary reports; artifact-files.json authenticates retained generated inputs, raw float depth, validity/target masks, previews, sources and reports. Runtime evaluator truth stays outside every observation.']
    (OUT/'offline-report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    manifest=dict(completedAt=utc(),freezePath=rel(OUT/'offline-freeze.json'),freezeSha256=sha(OUT/'offline-freeze.json'),vendorWeightFilesPath=rel(OUT/'vendor-weight-files.json'),
                  sensorRecordPath=rel(OUT/'sensor-records.json'),syntheticSummaryPath=rel(OUT/'synthetic-summary.json'),realSummaryPath=rel(OUT/'real-summary.json'),reportPath=rel(OUT/'offline-report.md'),
                  artifactIndexPath=rel(OUT/'artifact-files.json'),downloadBytes=setup['totalArtifactDownloadBytes'],timing=timings,
                  limitations=synthetic_summary['limits']+[real_summary['boundary']])
    save(OUT/'manifest.json',manifest)
    excluded={'env','vendor','weights','wheelhouse','__pycache__'}
    paths=[p for p in OUT.rglob('*') if p.is_file() and not excluded.intersection(p.relative_to(OUT).parts) and p.suffix!='.log' and p.name not in ['artifact-files.json','vendor.zip']]
    save(OUT/'artifact-files.json',inventory(paths))
    print(json.dumps(dict(sensorRecords=len(records),syntheticGates=synthetic_summary['rows'],realScenes=3,timings=timings)),flush=True)


if __name__=='__main__':
    main()
