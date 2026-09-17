# Controllers are clients of robot ports

Research checked 2026-09-17. The core knows robot ports, not coding agents, Nervelet, Jev or workflows. Each controller receives only the ports assigned to it. The same port boundary can be implemented by a real device adapter, but interface reuse alone does not establish hardware readiness.

## The smallest useful integration

A port describes capabilities, observes sensed evidence, submits commands, acknowledges events/messages, sends radio packets, and stops. Robot-specific command schemas stay with the model. Sensors, simulation, radio delivery and local servos continue while a controller thinks. A controller is simply `run(ports, signal)`.

Actuator ownership belongs to the world. Stopping revokes a port; a late tool result cannot regain authority. Controller implementations must distinguish command admission from completion, queue admission from radio delivery, and requesting an agent interruption from its confirmed terminal event. One controller may explicitly own several ports, or each robot may have its own process. Giving one agent several ports gives it centralized knowledge; a decentralized swarm experiment should use separate controllers and the radio interface.

## Native harnesses

[Codex App Server](https://learn.chatgpt.com/docs/app-server) provides native threads, turns, tool events, readable reasoning summaries and interruption. The integration uses authenticated loopback MCP tools; its experimental dynamic-tool API is unnecessary. It checks `model/list` for the requested model and effort, defaults to the requested `gpt-5.6-luna` / `xhigh`, and refuses substitution. It retains the accepted turn ID, handles early terminal events and joins the matching terminal event after interruption. A borrowed native client remains owned by its caller. This is a bounded single native turn, not a replacement conversation supervisor.

[Claude Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) supplies the same tools through an in-process MCP server. The native SDK owns the session and agent loop. This robot fixture exposes only its scoped robot tools, with an explicit model and no automatically loaded local settings. It joins interruption by matching the input UUID. SDK fixtures validate this binding; no live native run is implied.

[MCP cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) is optional and can race completion. Therefore both native integrations stop robot ports before waiting for model interruption. [MCP tool schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) describe the tool boundary; server admission remains authoritative. No MCP message or model token should be a motor-control deadline.

The cockpit receives supplied native summaries/messages, tool events and bounded errors. It does not invent internal reasoning. Diagnostic data is not delivered through robot observations. Log overflow is reported; logs never carry native MCP authorization configuration or API credentials.

## Nervelet stays optional

The [Nervelet library](https://github.com/DanMcInerney/nervelet) supplies its own observation delivery, retained receipts, jobs, managed waits and native session drivers. `integrations/nervelet.ts` implements its public Environment contract using a port. It preserves acquisition clocks and the first adapter receipt time for repeated sensor revisions. Radio packets remain in an explicit inbox until acknowledged. Cancellation holds the entire robot because the port has a single actuator writer. A model without a `hold` command requires revoking the port and claiming a fresh port before continuing. Only a completed hold receipt is called confirmed.

`run-nervelet.ts` dynamically loads a caller-selected built library and delegates continuation to its Supervisor and Codex driver. Nervelet is not a core dependency and its session logic is not duplicated. Native controller cancellation still revokes ports. The current runner uses one Nervelet/native session per robot, intentionally distinct from a single native controller with several ports.

## Orchflows operates experiments

[Orchflows](https://github.com/DanMcInerney/orchflows) composes work and independent review using native host agents. It adds no agent runtime, scheduler or control SDK. Its integration is a portable experiment assignment and evidence contract in `integrations/orchflows/README.md`: create a bounded configuration, invoke the headless runner, inspect the saved measurements and independently review them. It must not give a swarm controller spectator truth merely because an experiment reviewer can inspect it.

The implementation was informed by the local Nervelet `src/types.ts`, `src/supervisor.ts`, `src/drivers/{codex,claude-code}.ts` contracts, and Orchflows `docs/architecture.md`. These are sibling projects, not vendored dependencies. Their public native qualification limits remain separate from this project's deterministic fixtures.

## Qualification

Offline fixtures cover port scope, late replies, tool budgets, stop before native interruption, exact Codex model/effort, early and unrelated terminal events, Claude input identity, and Nervelet sensor timestamps. The real native harnesses and paid Jev endpoint remain explicit opt-in runs. Physical timing, native compaction, radio hardware and autopilot behavior require separate evidence.
