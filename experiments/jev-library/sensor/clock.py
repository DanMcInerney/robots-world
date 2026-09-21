"""A monotonic-precision, epoch-anchored clock.

Found during the first live GPU measurement: `time.monotonic()` on this Windows Python 3.11 build
is backed by `GetTickCount64`, whose resolution is 15.625 ms — every timestamp this sensor emitted
before this fix was an exact multiple of 15.625 ms, coarse enough to produce nonsensical artifacts
(processing "durations" shorter than zero, consumer-receipt ages below emit ages) at the frame
rates this sensor targets (tens to hundreds of ms per frame). `time.perf_counter_ns()` uses
`QueryPerformanceCounter` and is sub-microsecond on this platform; anchoring it once to
`time.time_ns()` (real wall-clock epoch time, captured a single time at process start) gives every
later reading both that resolution AND a wall-clock meaning a receiving process can use directly
(`Date.now() - record.acquired.ms`) with no extra bookkeeping — and it is immune to a mid-run
NTP/system-clock step, unlike calling `time.time()` freshly on every stamp.
"""
from __future__ import annotations

import time


class EpochClock:
    """One epoch/perf-counter anchor pair, captured once. `now_ms()` is unix epoch milliseconds
    (float), fit for the wire (`acquired`/`emittedMs`) and directly comparable across processes."""

    def __init__(self) -> None:
        self._epoch_anchor_ns = time.time_ns()
        self._perf_anchor_ns = time.perf_counter_ns()

    def now_ms(self) -> float:
        return (self._epoch_anchor_ns + (time.perf_counter_ns() - self._perf_anchor_ns)) / 1e6

    @property
    def epoch_anchor_ms(self) -> float:
        """The wall-clock instant this clock was anchored at — retained for audit/debugging only;
        `now_ms()` never needs it, since every reading is already epoch-referenced."""
        return self._epoch_anchor_ns / 1e6
