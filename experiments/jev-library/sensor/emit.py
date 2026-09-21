"""stdout/stderr discipline: exactly one JSON object per line on stdout per record, and nothing
else ever touches stdout. This is the one owner of `sys.stdout` writes so no other module needs to
touch it directly — `main.py` routes every hello/frame/bye record through here, and all logging
goes through `logging` configured onto stderr (see `main.py`)."""
from __future__ import annotations

import json
import sys
from typing import IO, Optional


class NdjsonWriter:
    def __init__(self, stream: Optional[IO[str]] = None) -> None:
        self._stream = stream if stream is not None else sys.stdout
        self.max_line_bytes = 0  # exact wire size of the largest line written so far (any record type)

    def write(self, record: dict) -> None:
        line = json.dumps(record, allow_nan=False, separators=(",", ":"))
        self.max_line_bytes = max(self.max_line_bytes, len(line.encode("utf-8")))
        self._stream.write(line)
        self._stream.write("\n")
        self._stream.flush()
