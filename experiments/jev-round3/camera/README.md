# Round 3 stereo renderer

This experiment module renders a real triangle car model and a textured 3D road/environment through an offscreen OpenGL camera. It is independent of Robots World core and consumes acquired world poses. It does not select camera routes or move bodies. All assets, environments and generated evidence stay in ignored `.runtime/`.

## Setup and use

Run `./experiments/jev-round3/camera/setup.ps1` from the repository root. Python 3.11 and an isolated environment are used; no existing perception environment is modified. The qualified Windows backend is hidden pyglet/OpenGL, reported by this machine as Intel Graphics. A bounded preparation test temporarily set only this environment's executable to the Windows high-performance preference; OpenGL still selected Intel. The prior absent executable preference was restored in `finally`; its audit is retained. No global driver settings were changed.

```powershell
.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe experiments/jev-round3/camera/renderer.py --smoke
.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe experiments/jev-round3/camera/qualify.py
.runtime/experiments/jev-round3-v1/camera/env/Scripts/python.exe experiments/jev-round3/camera/renderer.py --trajectory TRAJECTORY.json --out NEW_ROUTE_OUTPUT
```

`StereoRenderer.render(camera_pose, target_pose, scene_config, out_dir=None, evaluator=True)` is the Python interface. `--request request.json` accepts those named arguments. `--jsonl` is a persistent stdin worker with one JSON request and metadata response per line. Close the renderer to release its hidden context. The persistent worker does not run a sensor clock, retry requests or create background jobs.

The world trajectory CLI accepts `{spec:{id,split,family},scene_config,frames:[{frame_index,acquired_sim_ms,camera_pose,target_pose}]}`. Top-level `routeId`, `split` and `family` are also supported. It preserves the world recording's zero-based `frame_index`; preselected one-based frame 20 is index 19. It refuses an existing output directory. A failed batch keeps completed frames and append-only partial manifests; `complete.json` exists only after every requested frame was rendered.

Output paths are absolute in `inputs.jsonl`: `{id,routeId,split,family,frameIndex,atMs,leftPath,rightPath,calibrationPath}`. `evaluator.jsonl` separately maps the same IDs to `{evaluatorPath,depthLeftPath,depthRightPath,targetMaskLeftPath,targetMaskRightPath}`. Each frame directory is `frames/0000/` etc. RGB is `rgb/left.png`, `rgb/right.png`; evaluator artifacts live under `evaluator/`. The perception process should receive the input manifest only. This file separation is a code/data ownership boundary, not a filesystem sandbox against an adversarial process.

## Coordinates and geometry

Metres, ENU: X east, Y north, Z up. Pose `{position:[x,y,z],yaw_rad,pitch_rad,roll_rad}` describes the stereo rig midpoint. Yaw zero faces east; positive yaw rotates north, positive pitch looks up. Image right at zero yaw points south. Positive roll rotates the camera's right vector toward its previous up vector. OpenGL camera coordinates are right/up/backward; forward is negative local Z. Both eyes share orientation, with origins displaced by -0.1 and +0.1 metres along camera right.

640×360, horizontal FOV 70°, fx=fy=457.0073621574767px, cx=320, cy=180, no distortion, near=.05m, far=160m. The image coordinate of pixel column/row is `(column+.5,row+.5)` with upper-left origin. Stereo disparity is `u_left-u_right=fx*.2/axial_depth`. Evaluator depth arrays are float32 positive axial metres, zero for no surface, not Euclidean range. Convert each valid pixel using `X=(u-cx)*Z/fx`, `Y=(v-cy)*Z/fy`; radial range is `sqrt(X²+Y²+Z²)`. Mask images identify the visible target surface after physical occlusion, including tires and glass. All visual target parts share the same transform.

Cars have ground footprint-centre origins and local +X forward. Their rotation is planar yaw; nonzero car pitch/roll is rejected. The Ferrari mesh is uniformly scaled to 4.5m length. Full conservative extents, including mirrors, are `[4.5,2.2404008033433596,1.2267351453772577]`m, with local collider centre `[0,0,.6133675726886288]`. This enclosing box intentionally fills space around curved bodywork and undercarriage; it does not establish contact fidelity.

Scene fields:

- `seed`: deterministic road, grass and distant architecture appearance.
- `obstacles`: `{id,position:[x,y,z],size:[sx,sy,sz],color:[r,g,b]}`; position is box centre and dimensions are full extents. These match the route backend's axis-aligned boxes.
- `lookalikes`: `{id,pose,color:[r,g,b]}`; same mesh/scale as target. Colours are 0..1 RGB.
- `poles`: optional `{id,position,radius,height}`; centre-positioned 32-sided cylinders. Scored world routes use the explicit box obstacles, including their declared thin square pole.
- `target_body_color`: optional RGB, default blue `[.025,.12,.8]`.
- `lighting`: optional `{ambient:[r,g,b],directional_intensity,shadows}`. Defaults remain `[.42,.42,.42]`, 2.6, false. The separately saved preparation variant uses lower ambient and physical directional shadows; it is not selected implicitly.

The road surface is 8mm above the ground and markings up to 23mm. Distant buildings and windows are background visual geometry outside the route corridor; they are not additional Rapier colliders. No shadows, optical noise, rolling shutter, motion blur, atmospheric model or lens distortion are synthesized. Road and grass have seeded procedural textures; the car retains its supplied material parts, with blue body and opaque dark glazing. Synthetic semantic recognition and range performance still require separate evaluation.

## Asset attribution and qualification limits

Ferrari 458 Italia by **vicent091036**, credited in the [official Three.js example](https://github.com/mrdoob/three.js/blob/r180/examples/webgl_materials_car.html). The downloaded GLB is the [upstream asset](https://github.com/mrdoob/three.js/blob/6eec560494b0492cb72b6120ea2405bf4e4fe9c7/examples/models/gltf/ferrari.glb), SHA-256 `cafe3f48da6797aa9bde75ca768bc5b57db366575fd233e90df186ae988a876e`. Changes: Draco decoding, ENU transform, uniform scale, blue body, opaque dark glazing. The original [Sketchfab source](https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6) and unauthenticated API returned unavailable/404 during preparation. A [secondary distribution manifest](https://huggingface.co/datasets/shuolucs/WorldCoder-Bench) lists CC-BY 4.0, but the primary asset licence was not independently recovered. This local pilot retains that unresolved provenance limitation and does not redistribute the model. The Three.js software licence is not asserted to independently establish the asset's licence. Source evidence and the downloaded model remain ignored.

`corrected-qualification/qualification.json` records three independent plane renders at rotated camera poses: expected metric axial depth, positive stereo disparity, identical epipolar row and determinant +1. Qualification views include elevated/offset pose, wall occlusion, thin pole and lookalike. Warm timings include both RGB eyes plus both evaluator passes. They do not establish 10Hz rendering or real-time perception.

The initial failed smoke is retained in `failed-zero-draco-smoke/`: trimesh silently used zero fallback position accessors for the Draco-compressed GLB. The first decoding repair replaced mesh geometry by non-unique names and left 15 repeated wheel/tire submeshes empty; `smoke/` and `lighting-diagnostic/` preserve that failed setup. Full mesh-index replacement repaired this defect without changing candidate camera poses, lighting or materials. `corrected-original-smoke/` preserves the exact original three view configurations with complete geometry. `corrected-lighting-diagnostic/` separately preserves the requested lighting and three-view diagnostic. None is scored data.

The loader now verifies every source mesh index against the imported scene node, one primitive per mesh, triangle counts, bounds, valid indices, finite vertices and positive area for all 51 parts. Draco legitimately creates additional vertices at attribute seams; an attempted strict vertex-count equality assertion failed and is retained in `corrected-qualification.log`. The final guard verifies unchanged triangle index counts and source accessor bounds instead, alongside source fallback metadata. Failed detector predictions on incomplete geometry cannot establish detector quality.
