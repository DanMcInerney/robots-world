"""CLI entry point: `python -m sensor.main --manifest ... --rate-hz 10 --checkpoint ... [options]`
(run with `cwd` set to `experiments/jev-library`, so the `sensor` package and its sibling modules
both resolve — see `docs/jev-live-sensor-results.md` for the exact command used to measure this).

Wires a `FrameProvider` (replay by default; see `frames.py`), a `Detector` (see `../detector.py`)
and a `StereoBackend` (see `stereo_backend.py`) into one streaming pipeline (see `pipeline.py`),
and writes exactly one JSON record per processed frame to stdout via `emit.py`. All logging goes
to stderr through the standard `logging` module. stdout purity is enforced at two levels: the
Python-level `sys.stdout` is reassigned to stderr for the rest of the process, AND the OS-level
file descriptor 1 is duplicated and redirected to fd 2 before that, so native code (a C extension,
a library writing raw bytes to fd 1) cannot corrupt the stream either — only the one duplicated
real-stdout file object is ever handed to `NdjsonWriter`.

Clean shutdown on stdin close, SIGINT (Ctrl-C) and SIGTERM; non-zero exit with a clear stderr
message on manifest/model/calibration startup failure. A frame that fails to process is reported
on the wire as an explicit `valid:false` record (never silently dropped) and does not crash the
process; only a genuinely unexpected exception (escaping the per-frame guard) is fatal, and `bye`'s
`reason` reflects that truthfully.

Windows caveat: nervelet's `processSource.stop()` kills the whole process tree via
`taskkill /PID <pid> /T /F` on Windows — a hard kill, so this process's own signal handlers and
stdin-close watcher never run in that path. They matter on POSIX (where `processSource.stop()`
just signals the direct child) and for manual/local runs (Ctrl-C, or closing stdin) on any
platform. This is documented, not silently swallowed: see `docs/jev-live-sensor-results.md`.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # experiments/jev-library
from learned_stereo import read_manifest  # noqa: E402 - manifest validation/parsing only; does not import torch/FFS

from .clock import EpochClock
from .emit import NdjsonWriter
from .frames import ReplayFrameProvider
from .pipeline import FrameProcessingError, SensorPipeline
from .records import bye_record, failed_frame_record, frame_record, hello_record
from .stereo_backend import FfsBackend, SgbmBackend

LOG = logging.getLogger("stereo_objects_sensor")

# How long after process start an immediate stdin EOF is treated with suspicion (logged, watcher
# disabled for the rest of the run) rather than trusted as a genuine shutdown request. Protects
# against a closed/absent/anomalous stdin at spawn time (observed concretely: Git-Bash/MSYS on
# Windows delivers instant EOF to a native python.exe reading even an open named pipe) causing the
# sensor to exit before doing any work, while still honoring a real mid-run stdin close promptly.
STDIN_EOF_GRACE_S = 2.0


def _configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)


def load_samples(manifest_path: Path, sample_ids_file: Optional[Path]) -> list:
    """Reads and validates the manifest (image/calibration paths only; see `learned_stereo.py`'s
    `read_manifest`), then, if given, reorders/filters it to exactly the ids listed in
    `sample_ids_file` (one id per line) — this is how a predeclared, fixed frame sample is
    honored end to end rather than re-derived at run time."""
    samples = read_manifest(manifest_path)
    if sample_ids_file is None:
        return samples
    by_id = {sample["id"]: sample for sample in samples}
    ids = [line.strip() for line in sample_ids_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not ids:
        raise ValueError(f"{sample_ids_file} contains no sample ids")
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise ValueError(f"{len(missing)} sample id(s) in {sample_ids_file} are not in the manifest, e.g. {missing[0]!r}")
    return [by_id[i] for i in ids]


class ShutdownWatcher:
    """Owns the three clean-shutdown triggers (stdin close, SIGINT, SIGTERM) behind one Event, and
    wakes the frame provider immediately on any of them instead of leaving the main loop to notice
    only on its next poll."""
    def __init__(self, provider) -> None:
        self.event = threading.Event()
        self._provider = provider

    def _trigger(self, reason: str) -> None:
        if not self.event.is_set():
            LOG.info("Shutdown requested: %s", reason)
        self.event.set()
        self._provider.wake()

    def install_signal_handlers(self) -> None:
        for name in ("SIGINT", "SIGTERM"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                signal.signal(sig, lambda signum, frame, reason=name: self._trigger(reason))
            except (ValueError, OSError):
                LOG.warning("Could not install a handler for %s on this platform", name)

    def watch_stdin(self, grace_period_s: float = STDIN_EOF_GRACE_S) -> None:
        """Watches for stdin EOF on a background thread. An EOF observed within `grace_period_s`
        of this call is logged and the watcher disables itself for the rest of the run (a genuine
        host would not close the pipe before the sensor has even started; SIGINT/SIGTERM remain
        available) instead of shutting the sensor down before it does any work. An EOF observed
        after the grace period triggers a normal clean shutdown."""
        def _watch() -> None:
            started = time.perf_counter()
            try:
                while True:
                    line = sys.stdin.readline()
                    if line:
                        continue  # stdin is not used for data; any input is ignored, not a close signal
                    break  # readline() returned '' : genuine EOF
            except Exception:  # noqa: BLE001 - a closed/broken stdin still means "at EOF"
                pass
            if time.perf_counter() - started < grace_period_s:
                LOG.warning("stdin reported EOF within %.1fs of startup; treating this as a startup "
                            "anomaly, not a shutdown request (see ShutdownWatcher.watch_stdin's "
                            "docstring). The stdin-close trigger is now disabled for this run; "
                            "SIGINT/SIGTERM still work.", grace_period_s)
                return
            self._trigger("stdin_closed")
        threading.Thread(target=_watch, name="stdin-watcher", daemon=True).start()


def build_components(args: argparse.Namespace):
    """Constructs the real `Detector`/`StereoBackend` from CLI args. The only function that
    touches GPU/model/calibration state directly — tests exercise `run_sensor` with fakes instead,
    never this function."""
    from detector import Detector  # deferred: only needed for a real run, never for tests

    detector = Detector(args.checkpoint, device=args.device, runtime_root=args.detector_runtime_root,
                         half=args.half, conf=args.score_threshold)
    if args.stereo == "sgbm":
        stereo_backend = SgbmBackend()
    else:
        stereo_backend = FfsBackend(args.ffs_runtime_root)
    return detector, stereo_backend


def run_sensor(*, samples: list, rate_hz: float, detector, stereo_backend, score_threshold: float,
                max_objects: int, max_line_bytes: int, manifest_path, model_meta: dict,
                out=None, shutdown_event: Optional[threading.Event] = None,
                poll_timeout_s: float = 2.0, watch_stdin: bool = True,
                provider=None, clock: Optional[EpochClock] = None) -> dict:
    """The whole streaming loop, independent of how `detector`/`stereo_backend` were constructed
    (real or fake) — this is what tests drive directly, and what `main()` drives for a real run.
    Emits `hello` before the first frame and `bye` on every exit path (shutdown, exhaustion, or an
    exception propagating out of the loop). Returns final counters.

    `provider`, if given, replaces the default real-time-paced `ReplayFrameProvider` — tests that
    only care about framing/schema/error-handling (not pacing itself) use a deterministic,
    synchronous test double (`sensor.testing.ManualFrameProvider`) here instead, so they cannot be
    flaky under system load the way relying on real wall-clock pacing for an exact frame count
    would be (a real bug found by running this suite 15x under load: see
    `docs/jev-live-sensor-results.md`, "Failures and repairs").

    A per-frame `FrameProcessingError` (bad image/calibration/shape mismatch) is caught, reported
    on the wire as one `valid:false` frame record with a `reason` (never silently dropped), and
    does not stop the run. Any OTHER exception escaping the loop is treated as fatal: `bye.reason`
    is set to `fatal_error: ...` before it is written, and the exception is re-raised so the
    caller's exit code reflects it truthfully — `reason` never says `end_of_replay` on a crash.

    `watch_stdin=False` skips only the stdin-close trigger (SIGINT/SIGTERM still install); see
    `--no-stdin-watch` on the CLI and `ShutdownWatcher.watch_stdin`'s own grace period, which
    together guard against a closed/absent/anomalous stdin at spawn time (observed concretely:
    Git-Bash/MSYS on Windows delivers instant EOF to a native python.exe reading even an open named
    pipe) ending the run before it does any work. Production use through nervelet's
    `processSource` leaves `watch_stdin` at its default (True); see
    `docs/jev-live-sensor-results.md`."""
    writer = NdjsonWriter(out)
    pipeline = SensorPipeline(detector, stereo_backend, score_threshold, max_objects)
    clock = clock if clock is not None else EpochClock()
    provider = provider if provider is not None else ReplayFrameProvider(samples, rate_hz, clock=clock)
    owns_watcher = shutdown_event is None
    watcher = ShutdownWatcher(provider) if owns_watcher else None
    event = watcher.event if watcher is not None else shutdown_event
    if watcher is not None:
        watcher.install_signal_handlers()
        if watch_stdin:
            watcher.watch_stdin()

    first = samples[0]
    calibration_summary = json.loads(Path(first["calibrationPath"]).read_text(encoding="utf-8-sig"))
    provider.start()
    writer.write(hello_record(
        source="replay", manifest_path=str(manifest_path), frame_count=len(samples), rate_hz=rate_hz,
        calibration=calibration_summary, model=model_meta, stereo={"backend": stereo_backend.name},
        score_threshold=score_threshold, max_objects=max_objects, max_line_bytes=max_line_bytes,
        epoch_anchor_ms=clock.epoch_anchor_ms,
    ))

    last_seq = 0
    processed = skipped_total = frame_errors = truncated_frames = 0
    reason = "end_of_replay"
    try:
        while True:
            if event.is_set():
                reason = "shutdown_requested"
                break
            result = provider.take_latest(last_seq, timeout_s=poll_timeout_s)
            if result.frame is None:
                if result.exhausted:
                    break
                continue  # timed out waiting for a new release; recheck shutdown and try again
            skipped_total += result.skipped
            last_seq = result.frame.seq
            try:
                outcome = pipeline.process(result.frame.left_path, result.frame.right_path, result.frame.calibration_path)
            except FrameProcessingError as error:
                frame_errors += 1
                LOG.warning("Frame %s failed: %s", result.frame.id, error)
                writer.write(failed_frame_record(
                    seq=result.frame.seq, acquired_ms=result.frame.acquired_ms, emitted_ms=clock.now_ms(),
                    skipped_since_last=result.skipped, reason=str(error),
                ))
                continue
            record, truncated = frame_record(
                seq=result.frame.seq, acquired_ms=result.frame.acquired_ms, emitted_ms=clock.now_ms(),
                skipped_since_last=result.skipped, objects=outcome.objects, objects_total=outcome.objects_total,
                timing_ms=outcome.timing_ms, max_objects=max_objects, max_line_bytes=max_line_bytes,
            )
            if truncated:
                truncated_frames += 1
            writer.write(record)
            processed += 1
    except Exception as error:  # noqa: BLE001 - anything other than FrameProcessingError above is fatal
        reason = f"fatal_error: {type(error).__name__}: {error}"[:200]
        raise
    finally:
        provider.stop()
        writer.write(bye_record(processed=processed, skipped_total=skipped_total, frame_errors=frame_errors,
                                 truncated_frames=truncated_frames, reason=reason,
                                 max_line_bytes_seen=writer.max_line_bytes))
    return {"processed": processed, "skippedTotal": skipped_total, "frameErrors": frame_errors,
            "truncatedFrames": truncated_frames, "reason": reason, "maxLineBytesSeen": writer.max_line_bytes}


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, required=True, help="perception-inputs.json-style manifest ({samples:[{id,leftPath,rightPath,calibrationPath}]})")
    parser.add_argument("--sample-ids-file", type=Path, default=None, help="optional newline-separated, predeclared frame id list (order preserved)")
    parser.add_argument("--rate-hz", type=float, required=True)
    parser.add_argument("--stereo", choices=["sgbm", "ffs"], default="sgbm")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--device", default="0")
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--score-threshold", type=float, default=0.25)
    parser.add_argument("--max-objects", type=int, default=8)
    parser.add_argument("--max-line-bytes", type=int, default=4000)
    parser.add_argument("--detector-runtime-root", type=Path, required=True, help="writable dir for Ultralytics settings; never the read-only pinned venv")
    parser.add_argument("--ffs-runtime-root", type=Path, default=None, help="required with --stereo ffs")
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument("--no-stdin-watch", action="store_true", help="disable the stdin-close shutdown trigger entirely (SIGINT/SIGTERM still work); see run_sensor()'s docstring")
    return parser


def _protect_stdout():
    """Duplicates the real stdout fd and redirects fd 1 itself to stderr's target, so no native
    write to fd 1 (bypassing Python's `sys.stdout` object entirely) can reach the NDJSON stream.
    Returns a text file object wrapping the duplicated real fd, opened with `newline='\\n'` so
    Windows' default text-mode translation never turns the wire's `\\n` terminators into `\\r\\n`
    (found while building this fix: every line this sensor had written on Windows so far was
    CRLF-terminated). Also reassigns Python-level `sys.stdout` to stderr, belt-and-braces."""
    real_stdout_fd = os.dup(1)
    os.dup2(2, 1)
    real_stdout = os.fdopen(real_stdout_fd, "w", encoding="utf-8", newline="\n", closefd=True)
    sys.stdout = sys.stderr
    return real_stdout


def main(argv: Optional[list] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    _configure_logging(args.log_level)
    real_stdout = _protect_stdout()
    if args.stereo == "ffs" and args.ffs_runtime_root is None:
        print("--ffs-runtime-root is required with --stereo ffs", file=sys.stderr)
        return 2
    try:
        samples = load_samples(args.manifest, args.sample_ids_file)
    except Exception as error:  # noqa: BLE001
        LOG.error("Could not load manifest/sample list: %s", error)
        return 2
    try:
        detector, stereo_backend = build_components(args)
    except Exception as error:  # noqa: BLE001
        LOG.error("Startup failed (model/calibration): %s", error)
        return 2
    model_meta = dict(detector.metadata)
    try:
        model_meta["warmup"] = detector.warmup()
    except Exception as error:  # noqa: BLE001
        LOG.error("Detector warmup failed: %s", error)
        return 2
    try:
        result = run_sensor(samples=samples, rate_hz=args.rate_hz, detector=detector, stereo_backend=stereo_backend,
                             score_threshold=args.score_threshold, max_objects=args.max_objects,
                             max_line_bytes=args.max_line_bytes, manifest_path=args.manifest, model_meta=model_meta,
                             out=real_stdout, watch_stdin=not args.no_stdin_watch)
    except Exception as error:  # noqa: BLE001
        LOG.error("Sensor loop failed: %s", error)
        return 1
    LOG.info("Done: %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
