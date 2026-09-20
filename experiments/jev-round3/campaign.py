"""Bounded local campaign orchestration; no paid inference in this entry point."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.runtime/experiments/jev-round3-v1'
CAMERA_PY = OUT / 'camera/env/Scripts/python.exe'
PERCEPTION_PY = OUT / 'perception/.venv/Scripts/python.exe'


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            value.update(chunk)
    return value.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save_new(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(data, stream, indent=2, allow_nan=False)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def files_inventory(paths):
    return [{'path': str(p.resolve()), 'sha256': sha(p), 'bytes': p.stat().st_size} for p in sorted(set(paths))]


def freeze():
    review = OUT / 'preflight-review.md'
    if not review.exists() or not (OUT / 'preflight-resolution.json').exists():
        raise RuntimeError('Independent preflight and explicit resolution required before freezing scored campaign')
    if read(OUT / 'preflight-resolution.json').get('ready') is not True:
        raise RuntimeError('Preflight resolution has not cleared this candidate')
    files = [p for p in (ROOT / 'experiments/jev-round3').rglob('*') if p.is_file() and p.suffix in ['.py', '.ts', '.html', '.txt', '.md', '.ps1']]
    files.extend((ROOT / 'test').glob('jev-round3*.test.ts'))
    files.extend((ROOT / 'src').rglob('*.ts'))
    for folder in ['jev-strategies', 'jev-pixels', 'jev-spatial-text']:
        files.extend((ROOT / 'experiments' / folder).glob('*.ts'))
    files += [ROOT / 'docs/jev-round3-plan.md', ROOT / 'experiments/jev-spatial-text/stereo/matching.py',
              ROOT / 'experiments/jev-round2/http.ts', ROOT / 'package-lock.json', ROOT / 'package.json',
              ROOT / 'tsconfig.json', OUT / 'camera/assets/ferrari.glb', review, OUT / 'preflight-resolution.json']
    files += list((OUT / 'perception/models').glob('*.pt'))
    files += [OUT / 'perception/setup/environment-small.json', OUT / 'perception/setup/resolved-packages.txt',
              OUT / 'camera/environment.json', OUT / 'camera/asset-provenance.json',
              OUT / 'camera/resolved-packages.txt', OUT / 'camera/corrected-qualification/qualification.json']
    entries = files_inventory(files)
    frozen_sources = OUT / 'frozen-source'
    frozen_sources.mkdir(exist_ok=False)
    for entry in entries:
        p = Path(entry['path'])
        if '.runtime' not in p.parts:
            target = frozen_sources / p.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
    save_new(OUT / 'source-freeze.json', {'at': now(), 'files': entries,
        'scope': 'source/settings/assets fixed before scored world generation and perception',
        'note': 'Engineering smoke evidence is excluded; no inference-driven edits after this freeze.'})


def verify(which='source-freeze.json'):
    frozen = read(OUT / which)
    for entry in frozen['files']:
        if sha(entry['path']) != entry['sha256']:
            raise RuntimeError('Frozen bytes changed: ' + entry['path'])


def command(args, log_name):
    log_path = OUT / 'logs' / log_name
    log_path.parent.mkdir(exist_ok=True)
    print(json.dumps({'at': now(), 'start': log_name}), flush=True)
    with log_path.open('x', encoding='utf-8') as log:
        result = subprocess.run(list(map(str, args)), cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
    if result.returncode:
        raise RuntimeError(f'Command failed with exit{result.returncode}; preserved {log_path}')
    print(json.dumps({'at': now(), 'completed': log_name}), flush=True)


def render():
    verify()
    save_new(OUT / 'render-start.json', {'at': now(), 'sourceFreezeSha256': sha(OUT / 'source-freeze.json')})
    command(['node', ROOT / 'experiments/jev-round3/world.ts', '--run', '--out', OUT / 'world'], 'world.log')
    world = read(OUT / 'world/manifest.json')
    inputs, truths = [], []
    for route in world['routes']:
        if sha(OUT / 'world' / route['path']) != route['sha256']:
            raise RuntimeError('World trajectory differs from its manifest')
        target = OUT / 'camera/scored' / route['id']
        command([CAMERA_PY, '-B', '-u', ROOT / 'experiments/jev-round3/camera/renderer.py',
                 '--trajectory', OUT / 'world' / route['path'], '--out', target], route['id'] + '-render.log')
        if not (target / 'complete.json').exists():
            raise RuntimeError('Renderer did not complete ' + route['id'])
        for filename, records in [('inputs.jsonl', inputs), ('evaluator.jsonl', truths)]:
            records.extend(json.loads(line) for line in (target / filename).read_text().splitlines() if line.strip())
    if len(inputs) != 1200 or len({row['id'] for row in inputs}) != 1200 or {r['id'] for r in inputs} != {r['id'] for r in truths}:
        raise RuntimeError('Incomplete rendered input/evaluator join')
    for filename, rows in [('inputs.jsonl', inputs), ('evaluator.jsonl', truths)]:
        with (OUT / filename).open('x', encoding='utf-8') as stream:
            for row in rows:
                stream.write(json.dumps(row) + '\n')
    files = [OUT / 'inputs.jsonl', OUT / 'evaluator.jsonl', OUT / 'world/manifest.json', OUT / 'world/started.json']
    files += [OUT / 'world' / r['path'] for r in world['routes']]
    for route in world['routes']:
        target = OUT / 'camera/scored' / route['id']
        files += [target / name for name in ['complete.json', 'inputs.jsonl', 'evaluator.jsonl']]
    for sample in inputs:
        files += [Path(sample[k]) for k in ['leftPath', 'rightPath', 'calibrationPath']]
        files.append(Path(sample['calibrationPath']).parent / 'render-metadata.json')
    for truth in truths:
        files += [Path(truth[k]) for k in ['evaluatorPath', 'depthLeftPath', 'depthRightPath', 'targetMaskLeftPath', 'targetMaskRightPath']]
    for split in ['development', 'confirmation']:
        # Strict whitelist: trajectory and evaluator fields do not enter perception manifests.
        subset = [{k: s[k] for k in ['id', 'leftPath', 'rightPath', 'calibrationPath']} for s in inputs if s['split'] == split]
        save_new(OUT / f'{split}-perception-inputs.json', {'samples': subset})
        files.append(OUT / f'{split}-perception-inputs.json')
    save_new(OUT / 'input-freeze.json', {'at': now(), 'files': files_inventory(files), 'frames': len(inputs)})
    verify()
    save_new(OUT / 'render-completed.json', {'at': now(), 'frames': len(inputs)})


def infer():
    verify()
    verify('input-freeze.json')
    save_new(OUT / 'prediction-start.json', {'at': now(), 'sourceFreezeSha256': sha(OUT / 'source-freeze.json'),
        'inputFreezeSha256': sha(OUT / 'input-freeze.json')})
    for split in ['development', 'confirmation']:
        if split == 'confirmation':
            verify('development-seal.json')
        output = OUT / 'perception/scored' / split
        command([PERCEPTION_PY, '-B', '-u', ROOT / 'experiments/jev-round3/perception/run.py',
                 '--manifest', OUT / f'{split}-perception-inputs.json', '--output', output, '--device', '0'], split + '-perception.log')
        batch = read(output / 'results.json')
        expected = read(OUT / f'{split}-perception-inputs.json')['samples']
        if len(batch['results']) != len(expected) or {r['id'] for r in batch['results']} != {s['id'] for s in expected}:
            raise RuntimeError('Missing perception outputs')
        if split == 'development':
            save_new(OUT / 'development-seal.json', {'at': now(), 'files': files_inventory([p for p in output.rglob('*') if p.is_file()]),
                'policy': 'No source, prompt or threshold changes before confirmation'})
    verify()
    verify('input-freeze.json')
    verify('development-seal.json')
    save_new(OUT / 'prediction-seal.json', {'at': now(),
        'files': files_inventory([p for p in (OUT / 'perception/scored').rglob('*') if p.is_file()]),
        'sourceFreezeSha256': sha(OUT / 'source-freeze.json'), 'inputFreezeSha256': sha(OUT / 'input-freeze.json'),
        'developmentSealSha256': sha(OUT / 'development-seal.json')})
    save_new(OUT / 'prediction-completed.json', {'at': now(), 'frames': 1200, 'arms': 2})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['freeze', 'verify', 'render', 'infer'])
    args = parser.parse_args()
    try:
        globals()[args.command]()
    except Exception as error:
        save_new(OUT / ('failure-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f') + '.json'),
                 {'at': now(), 'command': args.command, 'error': str(error)})
        raise
