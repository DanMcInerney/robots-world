"""CPU-only, deterministic: stdout purity (exactly one JSON object per line, nothing else). No
GPU, no weights, no network."""
from __future__ import annotations

import io
import json
import unittest

from sensor.emit import NdjsonWriter


class NdjsonWriterTests(unittest.TestCase):
    def test_writes_exactly_one_newline_terminated_json_line_per_record(self):
        stream = io.StringIO()
        writer = NdjsonWriter(stream)
        writer.write({"a": 1})
        writer.write({"b": [1, 2, 3]})
        text = stream.getvalue()
        lines = text.split("\n")
        self.assertEqual(lines[-1], "")  # trailing newline after the last record, no partial line
        records = lines[:-1]
        self.assertEqual(len(records), 2)
        self.assertEqual(json.loads(records[0]), {"a": 1})
        self.assertEqual(json.loads(records[1]), {"b": [1, 2, 3]})

    def test_every_written_line_is_valid_standalone_json_with_no_embedded_newlines(self):
        stream = io.StringIO()
        writer = NdjsonWriter(stream)
        writer.write({"nested": {"text": "line one\nline two"}})
        line = stream.getvalue().splitlines()[0]
        parsed = json.loads(line)
        self.assertEqual(parsed["nested"]["text"], "line one\nline two")  # the newline is escaped inside the JSON string, not a real line break


if __name__ == "__main__":
    unittest.main()
