# Physics and robot modelling

The useful common boundary is a whole world with bodies, joints, actuator inputs, and measurements. A controller should neither know the engine's native object types nor receive its ground-truth snapshot. Engine capabilities remain explicit; swapping an adapter cannot make unsupported physics exist.

## Primary-source findings

- [Gazebo Physics plugins](https://gazebosim.org/api/physics/8/physicsplugin.html) expose feature sets instead of assuming every engine supports every operation. Its inexpensive TPE backend provides fleet kinematics without full force/contact dynamics. This motivates a deliberately limited second backend and startup rejection for incompatible assets.
- [Gazebo's ForwardStep source](https://github.com/gazebosim/gz-physics/blob/gz-physics8/include/gz/physics/ForwardStep.hh) separates a world step, actuator inputs, and outputs such as poses, joints, and contacts. Quantities identify coordinate frames. Here one backend owns all robots' coupled motion; a single clock advances their shared world.
- [MuJoCo's overview](https://mujoco.readthedocs.io/) separates the model definition from mutable simulation state and distinguishes actuator dynamics, transmission, and force generation. We keep assets separate from plants and leave waypoint/velocity control in robot-local servos. An autopilot is a control component above physics.
- [Webots controller documentation in GitHub](https://github.com/cyberbotics/webots/blob/master/docs/guide/controller-programming.md) uses named devices and independently configured sensor intervals, with explicit simulation-time control steps. Named sensors attached to links avoid a universal robot-specific observation schema.
- [Isaac Lab's sensor architecture](https://isaac-sim.github.io/IsaacLab/v2.1.1/source/overview/core-concepts/sensors/index.html) treats sensors as measurement buffers refreshed at simulation-time periods. Acquisition, delayed delivery, and controller reads need separate clocks and ownership.
- [Drake's multibody tutorial](https://drake.mit.edu/tutorials/authoring_multibody_simulation.html) describes links, joints, and distinct visual/collision/inertial properties, plus systems connected through ports. The port concept is valuable here; building a general-purpose graph framework is unnecessary for this host.

## Implemented baseline

`rapierFactory` provides dynamic, fixed and kinematic bodies; contact response; next-step forces; joint motors; and box/sphere/capsule ray queries. `kinematicFactory` provides fixed/kinematic boxes and spheres, velocities, and rays. It deliberately rejects forces, dynamic bodies, capsules, and joints. It reports no contact capability, so an empty contact list cannot be mistaken for physical collision testing.

Shape sizes are full extents in metres. Sphere x/y/z dimensions are its diameter. Capsule x/y dimensions are its diameter and z is its total height. Body poses use ENU and unit xyzw quaternions. Joint anchors are in their respective link frames; axes describe parent-link coordinates. Assets use poses relative to the robot's origin. Link IDs are `robotId/linkName`, and joint IDs are `robotId/jointName`.

`force` replaces the force for the next step; the backend clears it after that step. `velocity` persists until changed. `move` is an immediate administrative repositioning tool, not a controller navigation command. A dynamic body's collision effects remain physical, but controllers can still command idealized velocities and servos. These distinctions matter when interpreting results.

Built-in plants:

| Model | Commands | Purpose and limits |
| --- | --- | --- |
| `drone` | `goto`, `velocity`, `hold` | Acceleration-limited position/velocity servo with gravity compensation and idealized attitude control; no rotor or aerodynamic model. |
| `rover` | `goto`, `velocity`, `drive`, `hold` | Planar navigation and body-forward/yaw-rate driving with physical contacts; no tire, suspension, or wheel-slip model. |
| `arm` | `joints`, `hold` | Two physical revolute joints with position motors and fixed base. Positive shoulder angles lift the initially horizontal arm. |
| `humanoid` | `joints`, `hold` | Supported pelvis, torso/head, six actuated limb joints; articulation fixture, not a balancing or walking humanoid. |
| `kinematic` | `goto`, `velocity`, `hold` | Same controller program runs with either backend, exercising real adapter replacement. |

`createAssetModel(id, asset)` makes additional joint-controlled primitive robots without modifying core or adding robot-kind branches. The first link is the root. Revolute position targets and joint limits are radians. The built-in Rapier motor uses an idealized strong position servo (stiffness 4000, damping 126, maximum force 200); its gains do not represent a particular actuator. Mobile configuration exposes mass, maximum speed, maximum acceleration, and color. External adapters can implement different plant or actuator models behind the same contracts.

## What should remain external

Use an external simulator adapter for torque-accurate locomotion, compliant grasping, deformable objects, high-fidelity optics, tire models, or calibrated aerodynamics. Keep backend-native MJCF/URDF/SDF assets intact rather than promising lossless universal conversion. The current primitive asset format combines collision and display shape, and mass uses the engine's computed inertia; it is not a complete robot asset standard.

Hardware-style command/sensor interfaces test software portability. They do not establish calibration, timing fidelity, safety, or physical controller stability on hardware. Qualification should progress from deterministic port tests to target-simulator integration, autopilot/software-in-loop, and separately recorded hardware evidence.

The model/backend tests exercise collisions between two robots, real link motion and joint limits, different gravity, scoped robot actuation, generic assets, ray frame transforms and exclusions, unsupported capability rejection, and one unchanged control program across both engines. Repeatability claims apply to the same engine/version and action schedule; they do not require numerical equality across different physics engines.
