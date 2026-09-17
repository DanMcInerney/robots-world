# Robots World

Keep the core small and independent of controller libraries, harnesses, renderers and any one physics engine. Read README.md and docs/design.md when present before changing contracts.

Every robot is an instance with an ID, model, devices and scoped I/O. Never grant controllers spectator truth. Sensors acquire independently of controller inference. Distinguish acquisition, delivery, admission, application and completion. One revocable actuator owner per robot; stop/reset invalidates old authority. Network queue admission is not delivery. Keep queues and diagnostics bounded and report loss.

Use SI units and an explicit ENU world frame. Declare backend capabilities and reject unsupported assets. Simplified plant dynamics and real wire encodings are not proof of hardware readiness. Keep live inference, hardware and external services opt-in. No credentials or generated runtime evidence in Git.

Run npm test, npm run typecheck and npm run build. Browser-check viewer changes through the provided browser tools. Test robot isolation, multiple robots, delayed sensing, communication impairment, stale authority, cancellation, and repeatability. Do not silently replay uncertain actuator effects.
