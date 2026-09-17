# Controller entry points

Start the world with `npm run dev`. The server writes a local ignored `.runtime/session.json` with its URL and operator token. Stop the viewer's demo controller before claiming the same robots. The native CLI claims only the requested robots, records controller events in the cockpit and releases them on exit. It never automatically retries a mutation whose outcome is unknown.

All inference is opt-in. These commands launch real model inference when explicitly run:

```powershell
$env:ROBOTS_CODEX_EXECUTABLE = 'C:/path/to/codex.exe'
npm run agent -- --driver codex --robots drone-1 --goal 'Describe the robot. Fly to ENU (2, 0, 2), confirm completion, then stop.' --max-ms 120000

$env:ROBOTS_CLAUDE_MODEL = 'your-exact-available-model'
npm run agent -- --driver claude --robots drone-1 --goal 'Describe the robot, inspect its sensors, then hold.'

$env:ROBOTS_NERVELET_MODULE = 'C:/path/to/nervelet/dist/index.js'
npm run agent -- --driver nervelet --robots drone-1 --goal 'Move to ENU (2, 0, 2), confirm completion, then stop.'
```

The native Codex preset is exactly `gpt-5.6-luna` at `xhigh`. Its model catalog must advertise that pair; there is no silent fallback. Claude requires an explicit model. Nervelet mode loads a caller-selected built installation and uses its Supervisor/Codex driver, with one session per robot. The direct Codex/Claude modes use one session for all explicitly assigned ports. Supply comma-separated IDs to test centralized multi-robot control; use separate processes for independent robot agents.

For Jev-only control, see [the Jev integration](../docs/jev.md). It takes explicit waypoint candidates and never substitutes a general coding agent.

## Embedding a controller

`waypointController(routes)` and `swarmBeaconController(options)` in `baseline.ts` depend only on `RobotPort`. They make no simulator imports. The latter broadcasts its own acquired odometry through radio, and acknowledges delivered messages; it is a communication fixture, not a swarm navigation planner. The experiment runner provides the leader/follower task.

`createRobotTools(ports, { signal, maxCalls, log })` provides the shared tool facade. `createRobotMcp(tools)` embeds it in an MCP host; `serveRobotMcp(tools)` creates an authenticated loopback endpoint. No tool accepts a simulator reference, operator token or unassigned robot. Robot descriptions provide canonical command schemas.

`runCodex` and `runClaude` accept a goal, workspace, time/tool budgets and diagnostic callback. Their injectable native clients/query functions support protocol fixtures without inference. Native sessions own their own agent behavior; the world owns continuous simulation and scoped actuator authority. Native cancellation stops ports before joining a matching terminal event. Unconfirmed native termination remains an error rather than being called a successful stop.

`createNerveletEnvironment(port)` adapts the public Nervelet Environment contract. Nervelet stop/cancel issues a model's `hold` action; native runner cancellation revokes the port. A completed hold receipt confirms the simulated action, while an accepted receipt remains stopping. Goal changes work while the port remains valid. Closing releases it. Real hardware adapters must preserve these distinctions.

Tests use mocks and model-free port compatibility checks. Real native runs, long-session compaction, hardware timing and real flight are separately unqualified.
