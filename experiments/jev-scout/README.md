# Obstacle scouting experiment

[Exact design, gates, honest limits and commands](../../docs/jev-scout-tests.md).

- `scenario.ts`: environment-only layout/moving actor and English task.
- `design.ts`: sensor-only Jev questions/branch mapping, optional bounded view memory.
- `score.ts`: posthoc visible-patch mission scores; not controller evidence.
- `qualify.ts` / `preview.html`: zero-inference fixture evidence and spectator preview.
- `run.ts`: opt-in real inference, frozen sources, single-world dispatch, interrupted-attempt retention. Synthetic smoke is explicitly labelled.

The existing recorded-RGB acquisition, KLT worker, realtime trial loop and raw reconstruction audit are reused. The legacy tracking fixture retains its defaults; its saved evidence and original frozen source are untouched. `ReactiveWorld` accepts an optional environment stimulus only in this experiment layer; the robot/world library core is unchanged.
