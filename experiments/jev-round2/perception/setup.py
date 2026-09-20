"""Bounded, isolated CPU dependency and official metric-model acquisition."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.runtime/experiments/jev-round2-v1/perception'
CAP = 750_000_000
REV = 'a561b849ebae10a6f5ef49e26c83cbbcd36c71bf'
WEIGHT_SHA = '9203e538d35255c90dda4b7fedb47ff33fe725497bcca3b1e53b3a65ee63f0cb'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def main():
    manifest = {'startedAtUnix': time.time(), 'downloadCapBytes': CAP,
                'requestTimeoutSeconds': 60, 'commandTimeoutSeconds': 600,
                'sourceRevision': REV, 'files': [], 'commands': []}
    manifest_path = OUT / 'setup-manifest.json'
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if previous.get('status') == 'complete':
            raise RuntimeError('Setup already complete')
        save(OUT/'setup-first-failure.json', previous)
        manifest = previous
        manifest.setdefault('failures', []).append(dict(atUnix=time.time(), message=manifest.get('failure')))
        manifest.pop('failure', None)
        manifest['status'] = 'resuming-after-missing-setuptools-wheel'
    wheels = OUT / 'wheelhouse'
    wheels.mkdir(exist_ok=True)
    def command(args, timeout=600):
        log = OUT / f'setup-command-{len(manifest["commands"]):02}.log'
        began = time.time()
        with log.open('w', encoding='utf-8') as stream:
            result = subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, cwd=ROOT)
        manifest['commands'].append(dict(argv=args, seconds=time.time()-began, exitCode=result.returncode, log=str(log.relative_to(ROOT))))
        save(manifest_path, manifest)
        if result.returncode:
            raise RuntimeError(f'Command failed: {log}')
    def download(url, path, maximum, expected=None):
        if path.exists():
            recorded = next((x for x in manifest['files'] if x['path']==str(path.relative_to(ROOT))), None)
            if not recorded or sha(path) != recorded['sha256']:
                raise RuntimeError('Cannot reuse unverified existing download')
            return
        consumed = sum(x['bytes'] for x in manifest['files'])
        if consumed + maximum > CAP:
            raise RuntimeError('Download reservation exceeds 750 MB cap')
        began = time.time()
        count = 0
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'RobotsWorld-Offline-Experiment'}), timeout=60) as response, path.open('xb') as stream:
            length = response.headers.get('Content-Length')
            if length and int(length) > maximum:
                raise RuntimeError('Content-Length exceeds bound')
            while True:
                data = response.read(min(1024*1024, maximum-count+1))
                if not data:
                    break
                count += len(data)
                if count > maximum or time.time()-began > 600:
                    raise RuntimeError('Download byte/time bound exceeded')
                stream.write(data)
        actual = sha(path)
        manifest['files'].append(dict(url=url, path=str(path.relative_to(ROOT)), bytes=count, sha256=actual, seconds=time.time()-began))
        save(manifest_path, manifest)
        if expected and actual != expected:
            raise RuntimeError('SHA256 mismatch')
    # Wheel payloads are bounded by the acquired wheel inventory. pip has explicit
    # 60s socket timeouts, no retries and a ten-minute whole-command timeout.
    # The direct CPU wheel pins also authenticate the large upstream artifacts.
    urls = [
        ('torch-2.7.1+cpu-cp312-cp312-win_amd64.whl', 'https://download-r2.pytorch.org/whl/cpu/torch-2.7.1%2Bcpu-cp312-cp312-win_amd64.whl', 300_000_000, '0bc887068772233f532b51a3e8c8cfc682ae62bef74bf4e0c53526c8b9e4138f'),
        ('torchvision-0.22.1+cpu-cp312-cp312-win_amd64.whl', 'https://download-r2.pytorch.org/whl/cpu/torchvision-0.22.1%2Bcpu-cp312-cp312-win_amd64.whl', 15_000_000, '433cb4dbced7291f17064cea08ac1e5aebd02ec190e1c207d117ad62a8961f2b'),
    ]
    try:
        for name, url, maximum, expected in urls:
            download(url, wheels/name, maximum, expected)
        command([sys.executable, '-m', 'pip', 'download', '--only-binary=:all:', '--no-cache-dir', '--timeout', '60', '--retries', '0', '--dest', str(wheels), 'numpy==2.2.6', 'opencv-python-headless==4.12.0.88', 'filelock==3.16.1', 'typing-extensions==4.14.0', 'sympy==1.14.0', 'networkx==3.4.2', 'Jinja2==3.1.6', 'fsspec==2025.5.1', 'pillow==11.2.1', 'MarkupSafe==3.0.2', 'mpmath==1.3.0', 'setuptools==80.9.0'])
        known = {x['path'] for x in manifest['files']}
        for path in wheels.glob('*.whl'):
            if str(path.relative_to(ROOT)) not in known:
                manifest['files'].append(dict(path=str(path.relative_to(ROOT)), bytes=path.stat().st_size, sha256=sha(path), source='pypi pip download; exact filename pinned'))
        save(manifest_path, manifest)
        if sum(x['bytes'] for x in manifest['files']) > CAP-200_000_000:
            raise RuntimeError('Wheel inventory exceeds reserved bound')
        command([sys.executable, '-m', 'pip', 'install', '--no-index', '--find-links', str(wheels), 'torch==2.7.1+cpu', 'torchvision==0.22.1+cpu', 'numpy==2.2.6', 'opencv-python-headless==4.12.0.88'])
        archive = OUT/'vendor.zip'
        download(f'https://codeload.github.com/DepthAnything/Depth-Anything-V2/zip/{REV}', archive, 100_000_000)
        vendor = OUT/'vendor'
        vendor.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.infolist():
                relative = Path(*Path(member.filename).parts[1:])
                if not relative.parts or '..' in relative.parts:
                    continue
                if member.is_dir():
                    continue
                target = vendor/relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zipped.read(member))
        weights = OUT/'weights'
        weights.mkdir(exist_ok=True)
        download('https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-VKITTI-Small/resolve/c725b8589bdf6ab04072cab74c0467830db80d6d/depth_anything_v2_metric_vkitti_vits.pth', weights/'depth_anything_v2_metric_vkitti_vits.pth', 99_221_808, WEIGHT_SHA)
        command([sys.executable, '-m', 'pip', 'freeze'])
        (OUT/'pip-freeze.txt').write_text(subprocess.check_output([sys.executable, '-m', 'pip', 'freeze'], text=True), encoding='utf-8')
        manifest['totalArtifactDownloadBytes'] = sum(x['bytes'] for x in manifest['files'])
        manifest['finishedAtUnix'] = time.time()
        manifest['status'] = 'complete'
        save(manifest_path, manifest)
        print(json.dumps(manifest), flush=True)
    except Exception as e:
        manifest['status'] = 'failed'
        manifest['failure'] = repr(e)
        save(manifest_path, manifest)
        raise


if __name__ == '__main__':
    main()
