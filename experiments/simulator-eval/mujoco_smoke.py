"""Smoke test: can MuJoCo do the robots-world primitives natively on this Windows machine?
1. Build a 2-joint ~1 m arm with touch-sensor fingertips PROGRAMMATICALLY from datasheet-like part numbers.
2. Self-stepped physics loop (we own the clock), position servos with torque limits + reflected inertia.
3. Headless 320x180 RGB + depth camera, rangefinder, touch sensors.
4. Compile-error quality for a deliberately broken model.
"""
import math, time, sys, json
import numpy as np
import mujoco
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else '.'

# --- A toy "parts database" row, the way the NL->robot pipeline would supply it ---
SERVO = {  # roughly a 35 kg.cm class serial bus servo
    'name': 'generic-35kgcm-bus-servo', 'price_usd': 28.0, 'mass_kg': 0.072,
    'stall_torque_nm': 3.4, 'no_load_speed_rad_s': 5.2, 'gear_ratio': 345, 'rotor_inertia_kgm2': 4e-8,
}
G = mujoco.mjtGeom

def add_servo_joint(spec, body, name, axis, rng, servo, kp=40.0, kv=2.0):
    arm = servo['rotor_inertia_kgm2'] * servo['gear_ratio'] ** 2   # reflected rotor inertia
    body.add_joint(name=name, type=mujoco.mjtJoint.mjJNT_HINGE, axis=axis, range=rng,
                   armature=arm, damping=0.05, frictionloss=0.05)
    a = spec.add_actuator(name=name + '_servo', target=name, trntype=mujoco.mjtTrn.mjTRN_JOINT)
    a.gaintype = mujoco.mjtGain.mjGAIN_FIXED
    a.biastype = mujoco.mjtBias.mjBIAS_AFFINE
    a.gainprm[0] = kp; a.biasprm[1] = -kp; a.biasprm[2] = -kv
    a.ctrlrange = rng; a.forcerange = [-servo['stall_torque_nm'], servo['stall_torque_nm']]
    return a

def build():
    spec = mujoco.MjSpec()
    spec.option.timestep = 0.002
    spec.compiler.degree = False   # radians everywhere; MjSpec/MJCF default is DEGREES (silent unit trap)
    spec.visual.global_.offwidth = 640; spec.visual.global_.offheight = 360
    w = spec.worldbody
    spec.add_texture(name='grid', type=mujoco.mjtTexture.mjTEXTURE_2D, builtin=mujoco.mjtBuiltin.mjBUILTIN_CHECKER,
                     rgb1=[.35, .45, .35], rgb2=[.30, .40, .30], width=256, height=256)
    m = spec.add_material(name='grid', texrepeat=[8, 8]); m.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = 'grid'
    w.add_geom(type=G.mjGEOM_PLANE, size=[10, 10, .1], material='grid')
    w.add_light(pos=[0, 0, 5], dir=[0.2, 0.2, -1], castshadow=True)

    base = w.add_body(name='base', pos=[0, 0, 0.06])
    base.add_geom(type=G.mjGEOM_CYLINDER, size=[.09, .06, 0], rgba=[.15, .15, .15, 1], mass=1.5)
    upper = base.add_body(name='upper', pos=[0, 0, .10])
    add_servo_joint(spec, upper, 'shoulder', [0, -1, 0], [-0.2, 1.6], SERVO)
    upper.add_geom(type=G.mjGEOM_CAPSULE, fromto=[0, 0, 0, .5, 0, 0], size=[.02, 0, 0], rgba=[.8, .8, .85, 1], mass=.25)
    fore = upper.add_body(name='fore', pos=[.5, 0, 0])
    add_servo_joint(spec, fore, 'elbow', [0, -1, 0], [-2.0, 2.0], SERVO)
    fore.add_geom(type=G.mjGEOM_CAPSULE, fromto=[0, 0, 0, .45, 0, 0], size=[.016, 0, 0], rgba=[.8, .8, .85, 1], mass=.18)
    # two fingertip pads, each with a touch (pressure) sensor site
    for i, y in enumerate((-.03, .03)):
        tip = fore.add_body(name=f'tip{i}', pos=[.47, y, -.01])
        tip.add_geom(type=G.mjGEOM_SPHERE, size=[.018, 0, 0], rgba=[.9, .3, .2, 1], mass=.01)
        tip.add_site(name=f'pad{i}', size=[.02, .02, .02])
        spec.add_sensor(name=f'pad{i}_force', type=mujoco.mjtSensor.mjSENS_TOUCH,
                        objtype=mujoco.mjtObj.mjOBJ_SITE, objname=f'pad{i}', noise=0.02)
    for j in ('shoulder', 'elbow'):
        spec.add_sensor(name=j + '_enc', type=mujoco.mjtSensor.mjSENS_JOINTPOS, objtype=mujoco.mjtObj.mjOBJ_JOINT, objname=j)

    # moving blue "car" (mocap = kinematic, scripted) + distractor, a chase camera "drone" with a down rangefinder
    car = w.add_body(name='car', pos=[3, 0, .15], mocap=True)
    car.add_geom(type=G.mjGEOM_BOX, size=[.4, .2, .15], rgba=[.1, .2, .9, 1])
    w.add_geom(type=G.mjGEOM_BOX, pos=[4, 2, .3], size=[.3, .3, .3], rgba=[.9, .5, .1, 1])
    drone = w.add_body(name='drone', pos=[0, -3, 2.5], mocap=True)
    drone.add_geom(type=G.mjGEOM_BOX, size=[.15, .15, .04], rgba=[.1, .1, .1, 1], contype=0, conaffinity=0)
    cam = drone.add_camera(name='eye', pos=[0, 0, -.05], fovy=60)
    cam.mode = mujoco.mjtCamLight.mjCAMLIGHT_TARGETBODY; cam.targetbody = 'car'
    drone.add_site(name='lidar', pos=[0, 0, -.06], quat=[0, 1, 0, 0])   # +Z flipped to point down
    rf = spec.add_sensor(name='tfluna', type=mujoco.mjtSensor.mjSENS_RANGEFINDER, objtype=mujoco.mjtObj.mjOBJ_SITE, objname='lidar', noise=0.01)
    rf.intprm[0] = 1 << int(mujoco.mjtRayDataField.mjRAYDATA_DIST)   # output: distance only (the XML default)
    return spec

t0 = time.perf_counter(); spec = build(); model = spec.compile(); compile_ms = (time.perf_counter() - t0) * 1e3
data = mujoco.MjData(model)
bom = 2 * SERVO['price_usd']
print(f'mujoco {mujoco.__version__}  build+compile {compile_ms:.1f} ms  bodies={model.nbody} actuators={model.nu} sensors={model.nsensor}  servo BOM ${bom:.2f}')
xml = spec.to_xml(); open(f'{OUT}/generated_arm.xml', 'w').write(xml); print(f'MJCF round-trip: {len(xml)} chars written')

# static holding-torque feasibility check straight from the model: arm horizontal, what torque does gravity demand?
data.qpos[:] = 0; mujoco.mj_forward(model, data)
print('gravity torque at horizontal [shoulder, elbow] Nm:', np.round(data.qfrc_bias[:2], 3), ' vs servo stall', SERVO['stall_torque_nm'])

# --- self-stepped loop: WE own the clock, physics 500 Hz, camera 5 Hz ---
renderer = mujoco.Renderer(model, height=180, width=320)
def drive(t):
    data.mocap_pos[0] = [3 + 1.5 * math.cos(.5 * t), 1.5 * math.sin(.5 * t), .15]
    data.ctrl[:] = [0.6 + .3 * math.sin(t), -1.2 + .4 * math.sin(1.3 * t)]
N = 5000; t0 = time.perf_counter()
for i in range(N):
    drive(data.time); mujoco.mj_step(model, data)
phys = time.perf_counter() - t0
print(f'physics only: {N / phys:,.0f} steps/s = {N * model.opt.timestep / phys:.0f}x real time')

frames = 200; t0 = time.perf_counter()
for i in range(frames):
    renderer.update_scene(data, camera='eye'); rgb = renderer.render()
rgb_ms = (time.perf_counter() - t0) / frames * 1e3
renderer.enable_depth_rendering(); t0 = time.perf_counter()
for i in range(frames):
    renderer.update_scene(data, camera='eye'); depth = renderer.render()
depth_ms = (time.perf_counter() - t0) / frames * 1e3
renderer.disable_depth_rendering()
print(f'headless camera 320x180: RGB {rgb_ms:.2f} ms/frame, depth {depth_ms:.2f} ms/frame; depth range {depth.min():.2f}-{depth.max():.2f} m')
Image.fromarray(rgb).save(f'{OUT}/drone_eye_320x180.png')
big = mujoco.Renderer(model, height=360, width=640); cam = mujoco.MjvCamera(); cam.lookat[:] = [.5, 0, .4]; cam.distance = 2.2; cam.azimuth = 120; cam.elevation = -20
big.update_scene(data, camera=cam); Image.fromarray(big.render()).save(f'{OUT}/generated_arm_640x360.png')

# press the fingertips into the floor and read the pads
data.ctrl[:] = [-0.2, -0.3]
for _ in range(1500): mujoco.mj_step(model, data)
s = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_SENSOR, i): float(np.round(data.sensordata[model.sensor_adr[i]], 3)) for i in range(model.nsensor)}
print('sensors after pressing down:', json.dumps(s))

# determinism: same inputs twice -> bit-identical state?
def run():
    d = mujoco.MjData(model)
    for i in range(2000):
        d.ctrl[:] = [0.6 + .3 * math.sin(d.time), -1.2]; mujoco.mj_step(model, d)
    return d.qpos.copy()
print('deterministic repeat:', bool(np.array_equal(run(), run())))

# compile-error quality for an LLM feedback loop
for label, breaker in [('massless moving body', lambda s: s.worldbody.add_body(name='ghost').add_joint(name='gj', type=mujoco.mjtJoint.mjJNT_HINGE)),
                       ('actuator on missing joint', lambda s: s.add_actuator(name='bad', target='no_such_joint', trntype=mujoco.mjtTrn.mjTRN_JOINT)),
                       ('duplicate name', lambda s: s.worldbody.add_body(name='base'))]:
    bad = build()
    try: breaker(bad); bad.compile(); print(f'[{label}] compiled?!')
    except Exception as e: print(f'[{label}] -> {type(e).__name__}: {str(e).strip()[:200]}')
