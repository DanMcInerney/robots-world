# Research distilled into a small testbed

Research date: 2026-09-17. The goal is to test **software control behavior** across robots, sensors, protocols and inference latencies. Existing simulators supply useful boundaries; reproducing their entire frameworks would defeat the simplicity requirement.

| Source | Adopted lesson |
| --- | --- |
| [Gazebo physics plugins](https://gazebosim.org/api/physics/8/physicsplugin.html) | One engine adapter declares supported features; reject unsupported requests explicitly. |
| [MuJoCo documentation](https://mujoco.readthedocs.io/) | Separate robot/world definition from evolving physical state. |
| [Webots controllers](https://github.com/cyberbotics/webots/blob/master/docs/guide/controller-programming.md) | Named devices and independent acquisition periods make robot controllers portable. |
| [Isaac Lab sensors](https://isaac-sim.github.io/IsaacLab/v2.1.1/source/overview/core-concepts/sensors/index.html) | Buffer sensor measurements independently of consumer reads. |
| [PettingZoo parallel environments](https://pettingzoo.farama.org/api/parallel/) | Robot-keyed, possibly heterogeneous observations/actions; global truth belongs to evaluators. |
| [Gymnasium environment API](https://gymnasium.farama.org/api/env/) | Explicit reset/seed/step and bounded episodes; rewards are optional for control tests. |
| [LeRobot robot interface](https://github.com/huggingface/lerobot/blob/main/src/lerobot/robots/robot.py) | Keep policy-facing I/O small and independent of simulated versus physical implementation. |
| [Webots emitters](https://github.com/cyberbotics/webots/blob/master/docs/reference/emitter.md) | Model channel, range, bitrate and bounded queues; enqueueing is not delivery. |
| [ROS 2 QoS](https://docs.ros.org/en/rolling/Concepts/Intermediate/About-Quality-of-Service-Settings.html) | Fresh replaceable samples and retained events require different semantics. |
| [PX4 simulation](https://docs.px4.io/main/en/simulation/) | Offboard commands and autopilot simulation are separate interfaces; a MAVLink facade is not SITL. |

The result is six contracts, ordinary registration maps, plain scenario data, one port per robot, and optional adapters. No framework inheritance tree, reward language or workflow engine is required. A simulated fleet can share one explicit controller or use isolated policies and impaired peer messages. Those are different experiments and should be labeled separately.

Detailed lane findings: [physics](research-physics.md), [network](research-network.md), [testbeds](research-testbeds.md), [controllers](research-controllers.md), [Jev](jev.md). The implementation and qualification documents distinguish what is present from possible future integrations.
