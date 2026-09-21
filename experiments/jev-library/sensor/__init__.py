"""Streaming stereo-object sensor: a standalone process that turns paced stereo frames into
compact, goal-agnostic object records on stdout (schema `stereo-objects/1`). See `main.py` for the
CLI entry point and the package docstring notes in each module for how the pieces fit together:

    frames.py         FrameProvider protocol + the replay (recorded-frame) provider; latest-wins
    stereo_backend.py  Pluggable stereo backends (SGBM default; optional FFS) behind one interface
    pipeline.py        Per-frame decode -> detect -> stereo -> mask-median range -> bearing
    records.py         stdout record shapes (hello/bye/frame), object cap + line-size bound
    emit.py             The one owner of stdout: exactly one NDJSON line per record
    main.py             CLI wiring, replay pacing, latest-wins loop, clean shutdown

This package intentionally does not import anything from the evaluator/evidence-sealing modules
(`integrity.py`, `evaluate.py`, `artifacts.py`, `campaign.py`) elsewhere in `jev-library/` — a live
sensor process is not a batch comparison arm and does not produce sealed evidence.
"""
