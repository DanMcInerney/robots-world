# Simulator evaluation smoke tests

Evidence for [the simulator research](../../docs/research-simulators.md). These scripts are not part of the world core and add no dependency to `package.json`; run them from a scratch directory.

```powershell
uv venv --python 3.12 mjtest
uv pip install --python mjtest/Scripts/python.exe mujoco pillow numpy
mjtest/Scripts/python.exe mujoco_smoke.py .          # writes generated_arm.xml and two PNGs beside it

npm init -y; npm pkg set type=module; npm install @mujoco/mujoco
node mujoco_wasm_smoke.mjs generated_arm.xml         # loads the Python-generated MJCF in Node
```

`mujoco_smoke.py` builds a two-joint arm with touch-sensor fingertips from one datasheet-style servo record through `MjSpec`, steps it from its own loop, renders a 320x180 camera headless, reads a rangefinder, checks repeatability and prints the compiler's messages for three deliberately broken models. `mujoco_wasm_smoke.mjs` compiles and steps the same MJCF inside Node through DeepMind's official WASM package.

Recorded on 21 September 2026: Windows 11, RTX 5090 Laptop GPU, Python 3.12.4, Node 24.15.0, `mujoco` 3.13.0 and `@mujoco/mujoco` 3.13.0. These are single-run desktop timings of a tiny scene, not a benchmark.
