# Small interfaces from existing testbeds

Research checked 17 September 2026. The design recommendations below are our synthesis; they do not imply compatibility with these Python libraries.

| Primary source | Useful pattern | What Robots World adopts |
| --- | --- | --- |
| [Gymnasium Env](https://gymnasium.farama.org/api/env/) | Action and observation spaces, seeded reset, diagnostics separate from observations, and task termination separate from time-limit truncation. | Reproducible scenario configuration and explicit task outcomes. Reward is an optional experiment concern. |
| [PettingZoo Parallel API](https://pettingzoo.farama.org/api/parallel/) | Agent-keyed observations and actions, heterogeneous spaces, and a separate global state API. | Stable robot identities, independent capabilities, and privileged inspector truth. A synchronous RL wrapper may sit above the continuously running world. |
| [ManiSkill task building](https://maniskill.readthedocs.io/en/latest/user_guide/tutorials/custom_tasks/intro.html) | Scene construction, episode initialization, evaluation, observations and spectator cameras have separate responsibilities. | A renderer camera is never silently a robot sensor. Evaluators can inspect truth without granting it to a controller. |
| [Isaac Lab task workflows](https://isaac-sim.github.io/IsaacLab/main/source/overview/core-concepts/task_workflows.html) | Swappable action, observation and randomization components, alongside a direct workflow for experiments needing less structure. | Small interfaces and functions rather than an inheritance hierarchy or manager framework. |
| [LeRobot Robot source](https://github.com/huggingface/lerobot/blob/main/src/lerobot/robots/robot.py) | Hardware-neutral connection, observation and action methods with feature descriptions; actions report what was actually sent after clipping. | A robot port can front a simulated plant or hardware adapter. Admission, application and completion remain distinct. |
| [LeRobot asynchronous inference](https://huggingface.co/docs/lerobot/async) | Action prediction runs separately from execution, with configurable action chunking. | Physics, sensing and other robots continue while a controller is awaiting inference. A controller scheduler must bound pending work and reject expired decisions. |

## Sensor implementation

`SensorBank` owns timing and transport simulation; each `SensorPlugin` owns the actual measurement. No sensor is mandatory. A plugin receives its robot's link IDs, the selected link, a composed **world** mount pose, its named random stream, and the physics adapter. Plugins are trusted simulator extensions, not controller code; only their returned readings cross the robot port.

- Mounts are local to a robot link; the bank composes link and mount translation and rotation on every acquisition. World coordinates use ENU, SI units, and normalized quaternions.
- Sampling follows simulation-time cadence, capped by actual physics ticks. A large time jump records skipped acquisitions instead of inventing historical physical states. Reads do not trigger acquisition.
- Latency delays delivery; readings retain both actual acquisition and delivery times. Latest delivered data can be marked stale. Dropout preserves earlier data until its age limit expires. Each sensor has at most 256 queued samples; overflow drops the oldest pending sample and emits a diagnostic.
- Each robot/sensor has independent sample and dropout random streams. Adding an unrelated sensor does not perturb another sensor's noise history.
- Plugins return bounded finite JSON. Configuration, robot-owned links/joints, physics capabilities, frequency, mount validity and output bounds are checked explicitly.

Builtins are `odometry`, `gyro`, `lidar` (alias `range`), `depth`, `contact`, and `joints`. Odometry reports the mounted point's ENU position/orientation and point velocity, including the angular-velocity offset term. Gyro reports angular velocity in the mounted sensor frame. Lidar uses local +X forward with a planar XY scan. Depth returns a pinhole ray-distance grid, not RGB or photorealistic imagery. Rays exclude the sensing robot's own bodies. Contact returns touching robot links, without revealing identities of unseen objects. Joint encoders are restricted to the robot's own joints.

Noise is independent uniform additive error in the measurement's units: metres for odometry position and ranges, radians per second for gyro, radians for encoders. Contact is categorical and ignores numeric noise. The implementation is deliberately explicit: these are useful software-test measurements, not calibrated models of camera optics, IMU bias, rolling shutters or physical sensor failure. A full accelerometer is not offered because acceleration-history and bias semantics still need an explicit design.

## Experiment boundary

Record scenario/configuration hashes, backend versions, seed, controller configuration, applied commands and ticks, observation IDs, network events, and final metrics. A seed alone cannot reproduce remote inference or wall-clock message order; replay needs those external outcomes and their arrival schedule too.

Useful tests include task completion versus timeout, collision and tracking errors, stale-command rejection, observation age, inference latency, communication loss/bytes, stop latency, cross-robot isolation and repeated recorded input trajectories. Keep a slow agent beside a fast agent in the same world to expose hidden global inference barriers.

Do not turn the core into a training framework, planner, memory store, orchestration engine, reward language, distributed simulator or renderer framework. Add explicit adapters when a concrete experiment needs them. Shared software interfaces make control code portable; they do not establish physical accuracy or eliminate hardware qualification.
