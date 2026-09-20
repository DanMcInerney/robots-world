"""Bounded background artifacts with explicit backpressure and error propagation."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import time


class ArtifactWriter:
    def __init__(self, capacity=2):
        if capacity < 1:
            raise ValueError('Artifact capacity must be positive')
        self.capacity = capacity
        self.pending = deque()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='perception-artifacts')
        self.blocked_ms = 0.0
        self.peak_pending = 0

    def submit(self, function, *args):
        if len(self.pending) >= self.capacity:
            start = time.perf_counter()
            self.pending.popleft().result()
            self.blocked_ms += (time.perf_counter() - start) * 1000
        self.pending.append(self.pool.submit(function, *args))
        self.peak_pending = max(self.peak_pending, len(self.pending))

    def close(self):
        try:
            while self.pending:
                self.pending.popleft().result()
        finally:
            self.pool.shutdown(wait=True)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
