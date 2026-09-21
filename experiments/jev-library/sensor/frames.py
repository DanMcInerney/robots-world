"""Frame acquisition for the streaming stereo-object sensor.

Two responsibilities live here: a small `FrameProvider` protocol any acquisition source can
implement, and one concrete provider — replay of recorded stereo pairs from a frozen manifest,
paced at a requested rate (Hz). Acquisition is independent of processing: a background thread
releases frames on a wall-clock schedule and always overwrites a single "latest" slot
(latest-wins), so a slow consumer never builds an unbounded queue; it only ever sees the newest
available frame plus how many older releases it had to skip to reach it.

A live camera provider is NOT implemented here. It would satisfy the same `FrameProvider`
protocol: replace the manifest-driven pacer thread with a real capture loop (a stereo camera SDK
callback, or a polling grab() call), stamp `acquired_ms` at the moment each physical frame is
actually captured off the sensor (not when it is later read or decoded), and hand the pipeline
either an already-decoded pair or, like `ReplayFrameProvider` below, a cheap reference it decodes
itself as the pipeline's own first timed stage (see `pipeline.py`). The `_LatestSlot`/wake
mechanics here are already provider-agnostic and would not need to change.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass
from typing import IO, Optional, Protocol, Sequence

from .clock import EpochClock


@dataclass(frozen=True)
class FrameRef:
    """One frame released by a provider: identity plus where the pipeline should load pixels from.
    Decoding happens in the pipeline's own `decode` stage (see pipeline.py), not here, so a
    provider stays cheap to run regardless of how fast frames are released."""
    seq: int
    id: str
    left_path: str
    right_path: str
    calibration_path: str
    acquired_ms: float  # unix epoch ms (see clock.py); when this frame was released/captured


@dataclass(frozen=True)
class TakeResult:
    frame: Optional[FrameRef]
    skipped: int  # releases strictly between the caller's previous frame and this one
    exhausted: bool  # True: the provider will never release a frame after `frame` again


class FrameProvider(Protocol):
    def start(self) -> None: ...
    def take_latest(self, after_seq: int, timeout_s: Optional[float]) -> TakeResult: ...
    def wake(self) -> None: ...
    def stop(self) -> None: ...


class _LatestSlot:
    """One-slot mailbox. `publish` always overwrites; nothing here can grow unbounded. `wake`
    lets an external shutdown request interrupt a blocked `take` immediately, instead of a
    consumer having to poll on a short timeout during ordinary operation (which would otherwise
    add up to one poll interval of pure measurement artifact to every acquisition-to-emit age)."""
    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._frame: Optional[FrameRef] = None
        self._done = False
        self._wake_count = 0  # distinguishes an explicit wake() from an ordinary spurious wakeup

    def publish(self, frame: FrameRef) -> None:
        with self._cv:
            self._frame = frame
            self._cv.notify_all()

    def mark_done(self) -> None:
        with self._cv:
            self._done = True
            self._cv.notify_all()

    def wake(self) -> None:
        with self._cv:
            self._wake_count += 1
            self._cv.notify_all()

    def take(self, after_seq: int, timeout_s: Optional[float]) -> TakeResult:
        with self._cv:
            observed_wake = self._wake_count
            deadline = None if timeout_s is None else time.perf_counter() + timeout_s
            while True:
                frame = self._frame
                if frame is not None and frame.seq > after_seq:
                    skipped = max(0, frame.seq - after_seq - 1)
                    return TakeResult(frame=frame, skipped=skipped, exhausted=False)
                if self._done:
                    return TakeResult(frame=None, skipped=0, exhausted=True)
                if self._wake_count != observed_wake:
                    # An explicit wake() (e.g. a shutdown request), not new data: return promptly so
                    # the caller can re-check its own state instead of sleeping out the full timeout.
                    return TakeResult(frame=None, skipped=0, exhausted=False)
                remaining = None if deadline is None else deadline - time.perf_counter()
                if remaining is not None and remaining <= 0:
                    return TakeResult(frame=None, skipped=0, exhausted=False)
                self._cv.wait(remaining)


class ReplayFrameProvider:
    """Paces a fixed, ordered list of manifest samples (`{id, leftPath, rightPath,
    calibrationPath}`) at `rate_hz`, releasing one at a time into a single-slot mailbox. The pacer
    thread never waits for a consumer and never queues more than the one latest release — a slow
    consumer sees skips, not backlog. Runs to the end of `samples` once, then marks itself done
    (no looping): replay has a defined end, matching the "final `bye` on clean end-of-replay"
    contract in `main.py`."""
    def __init__(self, samples: Sequence[dict], rate_hz: float, clock: Optional[EpochClock] = None) -> None:
        if rate_hz <= 0:
            raise ValueError("rate_hz must be positive")
        if not samples:
            raise ValueError("Replay requires at least one frame")
        self.samples = list(samples)
        self.rate_hz = rate_hz
        # `clock` stamps the wire-visible `acquired_ms` (unix epoch ms; see clock.py). Scheduling
        # itself (below) uses `time.perf_counter()` directly — high-resolution and monotonic,
        # independent of any epoch anchor, which is all the pacing math needs.
        self.clock = clock if clock is not None else EpochClock()
        self._slot = _LatestSlot()
        self._thread: Optional[threading.Thread] = None
        self._stop_requested = threading.Event()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="replay-pacer", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        period_s = 1.0 / self.rate_hz
        start = time.perf_counter()
        for index, sample in enumerate(self.samples):
            if self._stop_requested.is_set():
                break
            target = start + index * period_s
            remaining = target - time.perf_counter()
            if remaining > 0 and self._stop_requested.wait(remaining):
                break
            acquired_ms = self.clock.now_ms()
            self._slot.publish(FrameRef(
                seq=index + 1, id=sample["id"], left_path=sample["leftPath"],
                right_path=sample["rightPath"], calibration_path=sample["calibrationPath"],
                acquired_ms=acquired_ms,
            ))
        self._slot.mark_done()

    def take_latest(self, after_seq: int, timeout_s: Optional[float] = None) -> TakeResult:
        return self._slot.take(after_seq, timeout_s)

    def wake(self) -> None:
        self._slot.wake()

    def stop(self) -> None:
        self._stop_requested.set()
        self._slot.wake()
        if self._thread is not None:
            self._thread.join(timeout=5.0)


class OnDemandFrameProvider:
    """Render-on-demand mode for a closed-loop engine driving its own simulated clock (e.g.
    experiments/jev-find-follow/'s episode engine): reads exactly ONE JSON line per `take_latest()`
    call from a line-delimited stream (default stdin) — `{"id":...,"leftPath":...,"rightPath":...,
    "calibrationPath":...,"acquiredMs":...}` — and returns exactly one frame reference for it, so
    the caller's one-request-in/one-record-out cadence (main.py's `run_sensor` loop already has
    this shape) maps directly onto one JSON line in, one processed record out, with the detector
    and stereo backend staying warm across requests in one persistent process.

    `acquired_ms` is taken VERBATIM from the caller's own `acquiredMs` field, never this process's
    own wall clock (`EpochClock`): the caller owns simulated acquisition time (an independent
    design review's point 6 — "do not mix wall and simulated clocks in one field"). `main.py`
    threads this through to `frame_record`/`failed_frame_record` with `acquired_clock_label`
    explicitly set away from `"unix-epoch-ms"`, so the wire record itself declares that
    `acquired.ms` is not a wall-clock reading (see records.py).

    A blank line is ignored (not a frame, not EOF). EOF (`readline()` returning `''`) marks the
    provider exhausted, matching `ReplayFrameProvider`'s own end-of-replay contract, so `main.py`'s
    existing shutdown/`bye` handling needs no on-demand-specific branch. `never_before` (`start`/
    `wake`/`stop`) are no-ops: there is no background thread and nothing to pace or interrupt."""
    def __init__(self, stream: Optional[IO[str]] = None) -> None:
        self._stream: IO[str] = stream if stream is not None else sys.stdin
        self._seq = 0

    def start(self) -> None:
        pass

    def take_latest(self, after_seq: int, timeout_s: Optional[float] = None) -> TakeResult:
        while True:
            line = self._stream.readline()
            if not line:
                return TakeResult(frame=None, skipped=0, exhausted=True)
            stripped = line.strip()
            if not stripped:
                continue
            request = json.loads(stripped)
            self._seq += 1
            frame = FrameRef(
                seq=self._seq, id=str(request["id"]), left_path=str(request["leftPath"]),
                right_path=str(request["rightPath"]), calibration_path=str(request["calibrationPath"]),
                acquired_ms=float(request["acquiredMs"]),
            )
            return TakeResult(frame=frame, skipped=0, exhausted=False)

    def wake(self) -> None:
        pass

    def stop(self) -> None:
        pass
