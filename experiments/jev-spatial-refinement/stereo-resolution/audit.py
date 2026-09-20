"""Full replay from frozen source; no timing reproducibility assertion."""
import argparse
import importlib
import json
from pathlib import Path
import sys
import cv2
import numpy as np
from run import sha,write,set_low_priority


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='.runtime/experiments/jev-spatial-refinement-v1/stereo-resolution')
    args=parser.parse_args();root=Path(args.output).resolve();set_low_priority()
    frozen=json.loads((root/'freeze.json').read_text());manifest=json.loads((root/'manifest.json').read_text())
    assert sha(root/'freeze.json')==manifest['freezeSha256']
    assert sha(root/'opencv-build-info.txt')==frozen['opencvBuildInfoSha256']
    for file in frozen['sources']:assert sha(root/'source'/file['path'])==file['sha256']
    expected={f['path'] for f in manifest['files']}
    actual={p.relative_to(root).as_posix() for folder in ('masters','inputs','results') for p in (root/folder).rglob('*') if p.is_file()}
    assert actual==expected
    for file in manifest['files']:
        assert sha(root/file['path'])==file['sha256']
        assert (root/file['path']).stat().st_size==file['bytes']
    assert sha(root/'summary.json')==manifest['summarySha256']
    assert sha(root/'report.md')==manifest['reportSha256']
    sys.path.insert(0,str(root/'source'))
    for name in ('baseline_matching','pipeline','scenes','metrics'):sys.modules.pop(name,None)
    pipeline=importlib.import_module('pipeline');scenes=importlib.import_module('scenes');metrics=importlib.import_module('metrics')
    for name in ('baseline_matching','pipeline','scenes','metrics'):assert Path(sys.modules[name].__file__).parent==root/'source'
    assert scenes.specs()==frozen['cases'];assert scenes.physical_scenes()==frozen['physicalScenes']
    arrays=0;rows=0
    for scene in frozen['physicalScenes']:
        images,hazard=scenes.render_master(scene);md=root/'masters'/scene['id']
        for eye,image in zip(('left','right'),images):np.testing.assert_array_equal(image,cv2.imread(str(md/f'{eye}.png'),cv2.IMREAD_GRAYSCALE))
        np.testing.assert_array_equal(hazard,np.load(md/'hazard-evaluator-only.npz')['hazard'])
        assert scenes.equivalence(images,hazard,scene)==json.loads((md/'equivalence.json').read_text())
        for case in [c for c in frozen['cases'] if c['physicalId']==scene['id']]:
            inp=root/'inputs'/case['id'];out=root/'results'/case['id']
            generated,truth,_=scenes.acquire(images,hazard,scene,case['scale'])
            original=[cv2.imread(str(inp/f'{eye}.png'),cv2.IMREAD_GRAYSCALE) for eye in ('left','right')]
            for before,after in zip(original,generated):np.testing.assert_array_equal(before,after)
            stored_truth=np.load(inp/'truth-evaluator-only.npz')
            for key in truth:np.testing.assert_array_equal(truth[key],stored_truth[key])
            c=json.loads((inp/'calibration.json').read_text());assert c==case['calibration']
            assert pipeline.parameters(case['scale'])==frozen['parametersByScale'][str(case['scale'])]
            result,regions=pipeline.estimate(*original,c,case['scale'])
            stored=np.load(out/'estimated.npz')
            for key in stored.files:np.testing.assert_array_equal(result[key],stored[key]);arrays+=1
            assert regions==json.loads((out/'sensor.json').read_text())['regions']
            assert metrics.grade(result,regions,truth,case['scale'])==json.loads((out/'grade-evaluator-only.json').read_text())
            rows+=1
        print(f"replayed {scene['id']}: {rows}/12 pairs",flush=True)
    result=dict(passed=True,pairs=rows,physicalScenes=4,masterPngs=8,acquiredPngs=24,arrayComparisons=arrays,
                sectorRecords=12*9,physicalEquivalenceRelations=12,hashedFiles=len(manifest['files']),
                latencyAndMemoryReproduced=False,freezeSha256=sha(root/'freeze.json'))
    write(root/'audit.json',result);print(json.dumps(result),flush=True)


if __name__=='__main__':main()
