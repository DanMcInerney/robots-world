# Orchflows experiment handoff

Orchflows is a host workflow, not a controller dependency. It can run the same repository commands as a human or another agent. No plugin is installed by this project.

Use this assignment with an explicitly invoked Orchflows work/review workflow:

> In the Robots World checkout, compare the specified controller configurations on the same named scenario and seeds. Use the existing `npm run experiment` runner and its declared arguments; inspect its help/source before selecting parameters. Keep inference disabled unless the request supplies a model, budget and native harness configuration. Save the exact configuration, revision, seed, command, metrics, trace path and failures together in an ignored run directory. The worker may inspect simulator truth only to evaluate outcomes. Robot controllers must use their assigned RobotPort observations and simulated radio. Have an independent reviewer assess the evidence and simulator limits. Make no hardware-readiness claim from wire encoding or simplified dynamics. Report missing qualification as a gap. Stop after the requested comparison; do not start an unrequested optimization loop.

The handoff to a reviewer is a run directory, not a prose claim of success. It should identify:

- Configuration, library/controller versions, robot models, sensors and physics backend.
- Seed, simulation timestep, wall duration and simulation duration.
- Command admission/application/completion and communication delivery/drop records.
- Trial metrics and expected outcomes, with unresolved uncertainty visible.
- A bounded reproduction command that does not silently launch inference.

One native controller can own multiple ports for a centralized experiment. Autonomous swarm tests should instead give each controller only its own robot port, and use the simulated radio for inter-robot knowledge. The orchestration agent may see all results after a run; that access is not permission to feed spectator truth into individual robot controllers.

Native model/effort preferences belong in the workflow assignment. The supplied Codex runner preserves `gpt-5.6-luna` / `xhigh`; a different model must be explicitly selected through the API. A controller cancellation revokes its robot authority independently of native reasoning.

Reference: [Orchflows architecture](https://github.com/DanMcInerney/orchflows/blob/main/docs/architecture.md). This file is a documented integration handoff, not a claimed installed or behaviorally qualified Orchflows skill.
