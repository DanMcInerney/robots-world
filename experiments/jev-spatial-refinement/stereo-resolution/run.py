"""Twelve predeclared resolution pairs; offline, one thread, no winner selection."""
from __future__ import annotations
import argparse
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import json
from pathlib import Path
import platform
import shutil
import sys
import time
import cv2
import numpy as np
from scenes import BASE,MASTER_SCALE,TILE_ROWS,physical_scenes,specs,render_master,acquire,equivalence
from pipeline import parameters,estimate
from metrics import grade

BASELINE_SHA='45334a119049e2c8e38c1142ad00e01fcb38380cac9c22449a9ca8c6665dd1c9'
ARRAYS=('rawLeft','rawRight','disparity','depth','rawValid','valid','leftRightErrorPx','textureStd')
MEMORY_LIMIT=1024**3
PAIR_PROCESS_LIMIT_MS=10000


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf-8')


def process_memory():
    if sys.platform!='win32':return dict(available=False)
    class Counters(ctypes.Structure):
        _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[
            (k,ctypes.c_size_t) for k in ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage',
             'QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage')]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.GetCurrentProcess.restype=wintypes.HANDLE
    psapi=ctypes.WinDLL('psapi',use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype=wintypes.BOOL
    data=Counters();data.cb=ctypes.sizeof(data)
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(data),data.cb):raise ctypes.WinError(ctypes.get_last_error())
    return dict(available=True,workingSetBytes=data.WorkingSetSize,
                peakWorkingSetBytes=data.PeakWorkingSetSize,privateCommitBytes=data.PagefileUsage,
                peakPrivateCommitBytes=data.PeakPagefileUsage)


def set_low_priority():
    if sys.platform!='win32':return 'unchanged non-Windows'
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.GetCurrentProcess.restype=wintypes.HANDLE
    kernel.SetPriorityClass.argtypes=[wintypes.HANDLE,wintypes.DWORD]
    if not kernel.SetPriorityClass(kernel.GetCurrentProcess(),0x4000):raise ctypes.WinError(ctypes.get_last_error())
    return 'Windows BELOW_NORMAL_PRIORITY_CLASS'


def freeze(root):
    if any(root.iterdir()):raise ValueError('Refusing existing nonempty output directory')
    source=Path(__file__).parent
    assert sha(source/'baseline_matching.py')==BASELINE_SHA
    (root/'source').mkdir()
    files=[]
    for p in sorted(source.iterdir()):
        if p.suffix in ('.py','.md'):
            shutil.copyfile(p,root/'source'/p.name);files.append(dict(path=p.name,sha256=sha(p)))
    (root/'opencv-build-info.txt').write_text(cv2.getBuildInformation(),encoding='utf-8')
    document=dict(frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),sources=files,
                  baselineSha256=BASELINE_SHA,baselineOrigin='experiments/jev-spatial-text/stereo/matching.py',
                  physicalScenes=physical_scenes(),cases=specs(),baseCamera=BASE,
                  parametersByScale={str(s):parameters(s) for s in (1,2,4)},
                  masterSampleScale=MASTER_SCALE,masterTileRows=TILE_ROWS,
                  versions=dict(python=sys.version,opencv=cv2.__version__,numpy=np.__version__,platform=platform.platform()),
                  opencvBuildInfoSha256=sha(root/'opencv-build-info.txt'),
                  limits=dict(singleCvThread=True,maximumProcessPeakWorkingSetBytes=MEMORY_LIMIT,
                              maximumObservedPairProcessMs=PAIR_PROCESS_LIMIT_MS,
                              meaning='offline resource stop conditions, checked after each operation; not a flight deadline or hard allocator cap'),
                  decisionRule='Exploratory projected-width diagnostic only; no winner, minimum-width threshold or flight promotion is selected from these results',
                  rangeScaling='numDisparities=64*scale holds disparity/focal-length search extent constant. Scale 2 exactly restores historical 640px, fx400, 128 disparities. All true near disparities fit all scales. Other SGBM/support settings stay fixed in pixels.',
                  textureControl='All scales integrate exactly the same finest physical sample grid. Texture coordinates are metres. Coarse prequantized image means and hazard footprint masses must equal aggregation of finer outputs exactly before matching.',
                  assumptions=['Four physical scenes, same texture realization; 12 related observations, not independent environments',
                    'Fixed pinhole FOV, baseline, near/background depth, physical pole width and position, texture, synchronized capture',
                    'Master grid is finite quadrature; 16/8/4 samples per output-pixel axis at scales 1/2/4; not continuous optical integration',
                    'Pixel integration is a box filter, followed by 8-bit rounding; no lens MTF, shot noise, read noise, exposure variation or rolling shutter',
                    'SGBM5 and support windows remain fixed in pixels, so their angular/physical footprint changes with resolution',
                    'All nonzero hazard footprint pixels count in primary denominators; fractional physical-area scores are additional, never a replacement',
                    'Depth is camera-forward axial metres; mixed-footprint pixels excluded only from scalar metric depth error',
                    'Whole-sector clearance is never asserted; no hardware, onboard timing, power or thermal qualification'])
    write(root/'freeze.json',document);return document


def manifest(root):
    files=[dict(path=p.relative_to(root).as_posix(),bytes=p.stat().st_size,sha256=sha(p))
           for folder in ('masters','inputs','results') for p in sorted((root/folder).rglob('*')) if p.is_file()]
    write(root/'manifest.json',dict(freezeSha256=sha(root/'freeze.json'),files=files,
                                  summarySha256=sha(root/'summary.json'),reportSha256=sha(root/'report.md')))


def make_report(root,summary):
    lines=['# Physically matched resolution contrast','',
      'Executed twelve stereo pairs: four physical scenes observed at 320×180, 640×360 and 1280×720. Poles have fixed physical widths equivalent to 1px or 2px at the 320px camera, with two physical subpixel positions. Near depth is 1.17m, background 5.2m, baseline 6cm, with exact synchronization. These are four related synthetic scenes, not twelve independent environments.','',
      'All resolutions integrate one common finest physical image grid. Texture lookup uses metres, and exact prequantized coarse/fine image and hazard-mass equivalence is checked before matching. The 320px camera is the reference introduced for this study; the previous F56 matcher comparison used 640px images.','',
      'The historical SGBM5 implementation is copied byte-for-byte. Its 5px block, P1=200, P2=800 and external support/aggregation rules remain fixed in pixels. The sole parameter adaptation is numDisparities=64/128/256, scaling with focal length 200/400/800px to preserve the searched physical depth extent; the 640px arm has the historical settings exactly. The near disparities are about 10.26/20.51/41.03px, well inside every search. Fixed pixel windows necessarily cover different physical/angular areas at different resolution.','',
      '| Physical scene: base width / position | Resolution | Projected width | Correct-near / all hazard | False-far / all hazard | Unknown / all hazard | Hazard sector label | Process ms | Process peak MiB |',
      '|---|---:|---:|---:|---:|---:|---|---:|---:|']
    for row in summary['rows']:
        s=row['physicalScene'];c=row['case'];g=row['grade']['valid'];m=row['memoryAfter']
        labels=','.join(x['depthBin'] for x in row['grade']['hazardSectors'])
        lines.append(f"| {s['baseWidthPx']}px / {s['basePositionPhasePx']}px | {c['calibration']['width']}×{c['calibration']['height']} | {c['projectedWidthPx']}px | {g['correctNearPixels']}/{g['hazardPixels']} ({g['correctNearFraction']:.1%}) | {g['falseFarPixels']}/{g['hazardPixels']} ({g['falseFarFraction']:.1%}) | {g['unknownPixels']}/{g['hazardPixels']} ({g['unknownFraction']:.1%}) | {labels} | {row['processToTextMs']:.1f} | {m.get('peakWorkingSetBytes',0)/2**20:.1f} |")
    lines += ['','Mixed footprint pixels remain in every primary hazard denominator. Because the count of partially covered pixels changes with resolution, the following additional metric weights each pixel by its hazard footprint area. Its total physical area is exactly conserved across resolutions; it does not replace the all-hazard-pixel metric.','',
              '| Base width / phase | Scale | Physical-area correct-near | Physical-area false-far | Physical-area unknown | Overall valid coverage | Homogeneous depth p95 error m |',
              '|---|---:|---:|---:|---:|---:|---:|']
    for row in summary['rows']:
        s=row['physicalScene'];c=row['case'];g=row['grade']['valid']
        error='unknown' if g['p95HomogeneousDepthErrorM'] is None else f"{g['p95HomogeneousDepthErrorM']:.4f}"
        lines.append(f"| {s['baseWidthPx']}px / {s['basePositionPhasePx']}px | {c['scale']} | {g['correctNearPhysicalFraction']:.1%} | {g['falseFarPhysicalFraction']:.1%} | {g['unknownPhysicalFraction']:.1%} | {g['overallCoverage']:.1%} | {error} |")
    lines += ['','No winner threshold or safe minimum projected width is selected from these results. This small contrast tests whether increased image sampling changes the previously failed near-hazard evidence. The result remains specific to four physical scenes, one texture realization and a fixed matcher; neither a successful near label nor a low scalar depth error certifies clearance.','',
              'Processing latency covers matcher creation, left/right matching, support filtering and sector text aggregation. It excludes rendering, image load/save, camera capture, transport and logging. Memory is the whole Python process working-set peak, including rendering and prior cases, not an isolated matcher allocation. The process runs one OpenCV thread at below-normal Windows priority. Resource stop limits were frozen at 1GiB observed peak working set and 10 seconds per observed matching/aggregation call; checks occur after each operation and are not hard real-time or allocator limits.','',
              'The common master grid gives finite 16/8/4 sample integration per pixel axis at scales 1/2/4. It does not simulate a physical lens MTF, sensor noise, motion blur, timing uncertainty, exposure differences or rolling shutter. Texture is physically stable but its local high-frequency content and the changing box-filter pixel footprint affect observable contrast. All three resolutions use the same aperture/FOV model; real higher-resolution hardware may differ.','',
              'Source and plan were frozen before matching. masters/ preserves finest raw sample images and evaluator hazard masks; inputs/ contains actual paired PNGs/calibration and separate truth; results/ keeps all raw disparities, retained masks, region text and grades. The replay audit rebuilds the four physical masters, all twelve image pairs and outputs. Historical F56 evidence/source remains unchanged.','',
              'Next: use fresh physical textures and positions to check transfer before selecting a projected-width requirement. Keep resolution and synchronization as separate factors, and validate a chosen camera/lens/runtime against synchronized physical recordings. Any operating minimum must be tied to real obstacle size, range and flight response constraints rather than the best example in this diagnostic.']
    (root/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='.runtime/experiments/jev-spatial-refinement-v1/stereo-resolution')
    args=parser.parse_args();root=Path(args.output).resolve();root.mkdir(parents=True,exist_ok=True)
    frozen=freeze(root);priority=set_low_priority();rows=[];equivalences=[]
    for scene in frozen['physicalScenes']:
        images,hazard=render_master(scene)
        eq=equivalence(images,hazard,scene);equivalences.append(dict(physicalId=scene['id'],checks=eq))
        memory=process_memory()
        if memory.get('peakWorkingSetBytes',0)>MEMORY_LIMIT:raise ValueError('Offline renderer memory bound exceeded')
        md=root/'masters'/scene['id'];md.mkdir(parents=True)
        for eye,im in zip(('left','right'),images):
            if not cv2.imwrite(str(md/f'{eye}.png'),im):raise ValueError('PNG write failed')
        np.savez_compressed(md/'hazard-evaluator-only.npz',hazard=hazard)
        write(md/'physical-scene-evaluator-only.json',scene);write(md/'equivalence.json',eq)
        for case in [c for c in frozen['cases'] if c['physicalId']==scene['id']]:
            sensor_images,truth,_=acquire(images,hazard,scene,case['scale'])
            inp=root/'inputs'/case['id'];inp.mkdir(parents=True)
            for eye,im in zip(('left','right'),sensor_images):
                if not cv2.imwrite(str(inp/f'{eye}.png'),im):raise ValueError('PNG write failed')
            np.savez_compressed(inp/'truth-evaluator-only.npz',**truth)
            write(inp/'calibration.json',case['calibration'])
            left,right=[cv2.imread(str(inp/f'{eye}.png'),cv2.IMREAD_GRAYSCALE) for eye in ('left','right')]
            calibration=json.loads((inp/'calibration.json').read_text())
            before=process_memory();started=time.perf_counter()
            result,regions=estimate(left,right,calibration,case['scale'])
            elapsed=(time.perf_counter()-started)*1000;after=process_memory()
            out=root/'results'/case['id'];out.mkdir(parents=True)
            np.savez_compressed(out/'estimated.npz',**{k:result[k] for k in ARRAYS})
            write(out/'sensor.json',dict(id=case['id'],calibration=calibration,regions=regions,
                  sourceSha256={eye:sha(inp/f'{eye}.png') for eye in ('left','right')},
                  depthConvention='camera-forward axial metres',clearance='unknown; visible measured patches only'))
            scored=grade(result,regions,truth,case['scale']);write(out/'grade-evaluator-only.json',scored)
            row=dict(case=case,physicalScene=scene,grade=scored,processToTextMs=elapsed,memoryBefore=before,memoryAfter=after)
            write(out/'measurement.json',dict(processToTextMs=elapsed,memoryBefore=before,memoryAfter=after));rows.append(row)
            print(json.dumps(dict(completed=len(rows),id=case['id'],width=case['projectedWidthPx'],correctNear=scored['valid']['correctNearFraction'],falseFar=scored['valid']['falseFarFraction'],unknown=scored['valid']['unknownFraction'],processMs=elapsed)),flush=True)
            if elapsed>PAIR_PROCESS_LIMIT_MS or after.get('peakWorkingSetBytes',0)>MEMORY_LIMIT:raise ValueError('Frozen offline resource bound exceeded; evidence preserved')
        del images,hazard
    summary=dict(freezeSha256=sha(root/'freeze.json'),pairs=len(rows),physicalScenes=4,
                 priority=priority,equivalenceChecks=equivalences,rows=rows,
                 winner=None,minimumSafeProjectedWidth=None)
    write(root/'summary.json',summary);make_report(root,summary);manifest(root)


if __name__=='__main__':main()
