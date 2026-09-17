# Swarms, radios, and portable boundaries

Research checked on 2026-09-17. The recommendations below are design decisions informed by these primary sources, not claims that Robots World implements their complete systems.

| Source | Pattern used here |
| --- | --- |
| [ARGoS controller interface](https://raw.githubusercontent.com/ilpincy/argos3/master/src/core/control_interface/ci_controller.h) | A controller receives a robot identity and its configured devices. Initialization, control, reset, and destruction have separate lifecycles. |
| [Webots emitter contract](https://raw.githubusercontent.com/cyberbotics/webots/master/docs/reference/emitter.md) | Communication is a robot device with channel, range, bitrate, and a transmit buffer. Local send admission does not establish remote receipt. Payload format belongs to the programs using the device. |
| [ROS 2 QoS documentation](https://raw.githubusercontent.com/ros2/ros2_documentation/rolling/source/ROS-Framework/interfaces/topics/About-Quality-of-Service-Settings.rst) | Distinguish latest samples from reliable events; declare queue depth, reliability, expiry and liveness. Replaying stale service requests may repeat effects. |
| [ns-3 event scheduling](https://www.nsnam.org/docs/manual/html/events.html) | Simulation time, wall time, and event ordering are different concerns. Model communication delays explicitly; use stable order for tied events. |
| [PX4 simulator architecture](https://docs.px4.io/main/en/simulation/) | Controller-facing offboard commands and the simulator/autopilot boundary are different interfaces. SITL runs the flight stack; simulator messages can carry sensor inputs and actuator outputs. |
| [MAVLink identity rules](https://mavlink.io/en/services/mavlink_id_assignment.html) | Every system has its own system ID, and components are identified within systems. Swarms cannot share one global vehicle address. |

## Smallest useful communication model

Every robot has a radio and an inbox. `send` admits a packet to its local transmit queue. Only later can another robot observe it. A sender never receives the evaluator's reasons for remote packet loss. An acknowledgment, if an application requires one, is another packet on the same imperfect channel.

`RadioMedium` implements a bounded datagram impairment model:

- Each sender serializes payload bytes at its configured bitrate. Header overhead, contention, retransmission, fragmentation and radio propagation are not modeled.
- Each recipient has an independently scheduled delivery. Delay is latency plus uniform bounded jitter, clamped to zero. Loss uses a named seeded stream for each directed robot pair.
- At the delivery tick, channels must match and distance must be within both radios' configured range. Directed partitions and source loss probability are then checked. Positions are the simulator's truth for the evaluator, never additional controller observations.
- `to: '*'` fans out to robots registered at send time, excluding the sender. Channel filtering happens at delivery. No discovery list or implicit neighbor positions are supplied to controllers.
- Transmission and inbox byte limits, a 512-message inbox cap, a global 65,536-delivery cap and a 256-radio cap bound storage. Rejected local admission is explicit. Remote overflow is visible only in diagnostics.
- TTL defaults to five simulation seconds and is capped at 60 seconds. It is checked at actual delivery; unread inbox packets also expire. Stale packets are not resurrected after partition recovery.
- Send IDs are deduplicated against the sender's most recent 512 accepted IDs, with payload hashes detecting conflicting reuse. Use unique IDs across the run; this bounded cache is not an unlimited exactly-once service. Delivered IDs namespace the sender and source ID so one inbox acknowledgment cannot consume another sender's identically named packet.
- Reset clears pending transmissions, inboxes, duplicate history and random streams. Ownership epochs for controller commands remain the world's responsibility.

This is intentionally not a Wi-Fi, Bluetooth, DDS or mesh-routing implementation. A more detailed network backend can retain the same robot interface. The renderer and inspector see all diagnostics; robot ports expose only their own delivered inbox.

## Real wire bytes are a separate layer

`MavlinkCodec` encodes and validates actual unsigned MAVLink v2 frames using `node-mavlink`. It rejects malformed framing and bad dialect CRCs. Signed frames are rejected because signature verification and keys are not configured. Multiple complete frames per datagram are supported; fragmented serial streams require a separate framing adapter.

`MavlinkAdapter` receives already-scoped `RobotPort` instances with unique system IDs. It requires explicit system and component targets, excluding broadcast actuation. Supported `SET_POSITION_TARGET_LOCAL_NED` variants are local-NED position-only mask `3576` and velocity-only mask `3527`, converted to world ENU `goto` and `velocity`. These commands expire after one simulation second unless refreshed. Every validated incoming setpoint gets a new local ingress ID: identical bytes and 8-bit MAVLink sequence wrap still refresh the streaming watchdog. Arrival order determines the latest setpoint; the adapter does not infer synchronization from `timeBootMs`, suppress reordered datagrams, or automatically retry any operation. A network-delayed setpoint can therefore supersede a newer one; timestamp synchronization/reorder rejection is a future explicit policy. Unsupported `COMMAND_LONG` requests receive `MAV_RESULT_UNSUPPORTED`; no arming, takeoff, mission, autopilot or flight-mode behavior is fabricated. Setpoints have no invented `COMMAND_ACK` transaction.

Telemetry uses installed, valid odometry samples and their acquisition timestamps, not spectator truth. It records observed execution events and job status before acknowledging only those events; it never acknowledges inbox packets. Call telemetry regularly to drain execution events. Heartbeats advertise `MAV_AUTOPILOT_INVALID`. Raw frames, decoded fields and command receipts flow to the bounded diagnostic recorder. The adapter itself retains no growing trace. The world still bounds a lease at 4,096 admitted commands; after that explicit backpressure requires releasing and claiming a new lease. The adapter does not silently rotate authority.

The opt-in `MavlinkUdpEndpoint` opens one loopback UDP socket and accepts datagrams only from an explicitly pinned loopback peer address and port. It serializes receive handling and bounds pending datagrams at 32. It starts no timer: the host calls `telemetry()` at its chosen rate. There is no automatic hardware discovery, external bind or paid inference.

```ts
const adapter = new MavlinkAdapter({
  ports: [{ port: robotPort, systemId: 1 }],
  simMs: () => world.simMs,
  record: world.journal.record,
});
const udp = await MavlinkUdpEndpoint.open({
  adapter, port: 14560,
  peer: { address: '127.0.0.1', port: 14550 },
});
// Host loop: await udp.telemetry(). Cleanup: await udp.close(); adapter.close().
```

Import the classes from `src/protocols/mavlink.ts` and `src/protocols/udp.ts`. Only bind a port owned by this adapter; two controllers must not share the same actuation lease.

## Portability and qualification

A real hardware implementation can keep the controller-facing port while substituting device implementations and transports. Matching message bytes is not proof of matching dynamics, frame conventions, watchdogs, acknowledgments or timing. PX4/ArduPilot SITL, ROS middleware interoperability and hardware tests remain separate qualification steps.

Deterministic accelerated runs suit scripted controllers. Native agents and external network processes need wall-time pacing, continuous acquisition and reported overruns. A delayed external reply must not gain authority merely because it eventually arrived.

Current automated coverage includes bandwidth serialization, local overflow, delayed delivery, receiver overflow, moving out of range, directed partitioning, expiry, broadcast channel isolation, cross-sender ID collisions, named-stream repeatability, actual MAVLink CRC rejection and coordinate conversion, target enforcement, sensor-derived telemetry and actual pinned-peer loopback UDP delivery. An actual-world stream of 300 setpoints crosses MAVLink sequence wrap, continues moving, consumes execution events without consuming radio messages, and stops when the stream ends. No PX4 or hardware qualification is claimed.
