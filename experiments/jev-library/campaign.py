"""Source/input freezing and integrity checks for the retrospective comparison."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil

from common import BASELINE, OUTPUT, ROOT, population, read, save_new, sha
from integrity import (amend_source, context, entry, seal_arm, seal_ffs, seal_predictions,
                       verify_analysis, verify_entries)


def verify_baseline():
    for name in ['input-freeze.json', 'prediction-seal.json', 'analysis-seal.json']:
        verify_entries(read(BASELINE / name)['files'])
    original_sources = read(BASELINE / 'source-freeze.json')['files']
    relevant = [entry for entry in original_sources if '/experiments/jev-round3/' in entry['path'].replace('\\', '/')
                or entry['path'].replace('\\', '/').endswith('/experiments/jev-spatial-text/stereo/matching.py')]
    verify_entries(relevant)
    return {'inputSealSha256': sha(BASELINE / 'input-freeze.json'),
            'predictionSealSha256': sha(BASELINE / 'prediction-seal.json'),
            'analysisSealSha256': sha(BASELINE / 'analysis-seal.json'),
            'note': 'All original input, prediction and analysis files verified against original seals; original perception source verified'}


def freeze():
    if (OUTPUT / 'source-freeze.json').exists():
        raise FileExistsError('Comparison is already frozen')
    baseline = verify_baseline()
    paths = list((ROOT / 'experiments/jev-library').glob('*.py'))
    paths += list((ROOT / 'experiments/jev-library').glob('*.html'))
    paths += [ROOT / 'docs/jev-library-comparison-plan.md']
    paths += list((ROOT / 'test').glob('jev-library*.test.ts'))
    entries = []
    frozen = OUTPUT / 'frozen-source'
    frozen.mkdir(parents=True, exist_ok=False)
    for path in sorted(paths):
        entries.append({'path': str(path.resolve()), 'sha256': sha(path)})
        destination = frozen / path.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    samples = []
    for split in ['development', 'confirmation']:
        samples += read(BASELINE / f'{split}-perception-inputs.json')['samples']
    save_new(OUTPUT / 'perception-inputs.json', {'samples': samples})
    save_new(OUTPUT / 'source-freeze.json', {'at': datetime.now(timezone.utc).isoformat(),
        'files': entries, 'baseline': baseline, 'baselineRoot': str(BASELINE.resolve()),
        'perceptionInputs': entry(OUTPUT / 'perception-inputs.json'),
        'population': 'all original1200 frames; retrospective, not fresh confirmation'})
    print('Frozen source and 1200-frame RGB/calibration input manifest', flush=True)


def verify():
    context(OUTPUT)
    checked = verify_baseline()
    if checked != read(OUTPUT / 'source-freeze.json')['baseline']:
        raise ValueError('Original baseline seal bytes changed')
    verify_analysis(OUTPUT, population(BASELINE)[1])
    print('Source, archived evidence, complete predictions and final analysis verified', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['freeze', 'amend-source', 'seal-arm', 'seal-ffs', 'seal-predictions', 'verify'])
    parser.add_argument('--reason')
    parser.add_argument('--arm')
    args = parser.parse_args()
    if args.command == 'amend-source':
        if not args.reason:
            parser.error('amend-source requires --reason')
        print(amend_source(OUTPUT, args.reason))
    elif args.command == 'seal-arm':
        if not args.arm or Path(args.arm).name != args.arm:
            parser.error('seal-arm requires a single --arm directory name')
        seal_arm(OUTPUT, OUTPUT / 'arms' / args.arm / 'results.json', population(BASELINE)[1])
    elif args.command == 'seal-ffs':
        seal_ffs(OUTPUT, OUTPUT / 'ffs/scored/index.json', population(BASELINE)[1])
    elif args.command == 'seal-predictions':
        seal_predictions(OUTPUT, population(BASELINE)[1])
    else:
        globals()[args.command]()
