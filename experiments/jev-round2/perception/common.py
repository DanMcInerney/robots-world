import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT/'.runtime/experiments/jev-round2-v1/perception'
SOURCE = Path(__file__).resolve().parent


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def utc():
    return datetime.now(timezone.utc).isoformat()


def inventory(paths):
    return [dict(path=rel(p), sha256=sha(p), bytes=p.stat().st_size) for p in sorted(paths) if p.is_file() and '__pycache__' not in p.parts]
