# Qualification boundaries

Default verification is local and does not call a paid model or connect to hardware:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Recorded on 2026-09-17: clean `npm ci` completed with zero audit findings; all 68 tests, TypeScript checking, the production viewer build and eight asserted matrix trials passed. Browser checks covered 1280×720 and 708×1280 layouts, pause/single-step, manual commands, scene reset, raw payloads and live swarm traffic. The optional MAVLink CLI also passed a bounded host-to-UDP-peer smoke: nine real telemetry frames arrived and both binary MAVLink and HTTP exchanges reached the cockpit. The sustained protocol regression streams 300 frames across sequence wrap, preserves unread radio packets and verifies watchdog expiry when transmission stops. No model inference was used in these checks.

Tests exercise robot model motion and articulation, supported physics features, mounted sensor frames and independent timing, radio impairments, command deduplication and leases, stale observation rejection, stop/watchdogs, raw MAVLink frames, controller tool scoping and optional inference adapters with fixtures. The headless runner produces configuration and trace artifacts for bounded scenarios. The browser is a real Three.js inspector of host state.

Subsequent qualification on the same date: the expanded 109-test suite passed with the optional real Nervelet Bridge integrations enabled. A separately authorized [live Jev batch](jev-live-results.md) exercised actual TypeSafe responses through the tracking comparison, with three paired seeds and one impaired-sensor trial. Those results do not qualify native Codex/Claude sessions or the full generic controller/Nervelet/Jev composition.

These tests do not establish flight stability, tire dynamics, walking balance, real sensor calibration, Wi-Fi behavior, native model latency or safe real-world autonomy. A real native Codex/Claude/Jev run requires opt-in credentials and separately recorded evidence. The native drivers preserve the selected harness and model; availability is checked at launch.

Before claiming hardware transfer, run the same port conformance tests against the device adapter, verify frame/unit mapping and sequence handling, test communication interruption and watchdog behavior, calibrate model and sensors against measured data, and record constrained hardware trials. A realistic message format is useful but not sufficient evidence of physical equivalence.

Seeded physics and sensor/network randomness support repeatable local trials for the same configuration and engine version. An LLM experiment also needs captured model outputs, timing and action scheduling; the seed alone cannot reproduce an external service. This version records bounded traces, not a general native-conversation replay engine.
