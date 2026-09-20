# Physically matched resolution follow-up

This separate F56 diagnostic fixes four physical pole scenes and observes each
at 320×180, 640×360 and 1280×720. Projected pole widths are 1/2/4px and 2/4/8px.
One common finest physical sample image controls texture and scene equivalence.
Coarse prequantized image means and hazard areas must equal aggregated finer
means/areas exactly before matching. Texture is anchored in metres.

The historical SGBM5 source is copied and SHA-256 pinned. Only disparity search
extent scales: 64/128/256 at focal lengths 200/400/800px; this keeps its physical
search range fixed, with the 640px settings identical to the old pipeline.
Block size, smoothness penalties, texture/support and sector aggregation remain
unchanged in pixels. All pixels touched by a hazard, including mixed pixels,
remain in primary hazard denominators. Additional physical-area weighted scores
address changing mixed-pixel counts without discarding their primary scores.

No safe minimum width, winner or advancement threshold is selected from the
outputs. These are four correlated synthetic scenes with one texture seed, no
noise or real camera optics. Finite quadrature and a box-filter pixel model are
explicit limits. No API, hardware, new dependency or historical edit is used.

From the repository root:

```powershell
.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo-resolution/test_contract.py
.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo-resolution/run.py
.runtime/vision-env/Scripts/python.exe .runtime/experiments/jev-spatial-refinement-v1/stereo-resolution/source/audit.py
```

The runner freezes source/cases/parameters before matching and refuses a
nonempty output directory. It is serial, uses one OpenCV thread and lowers its
Windows process priority. Frozen stop conditions are observed process peak
working set >1GiB or one matching/aggregation operation >10sec. They are checked
after operations, not hard allocation/real-time guards. Recorded whole-process
peak memory includes rendering and previous cases. Latency excludes acquisition,
rendering, loading and logging. Generated evidence remains under `.runtime/`.
