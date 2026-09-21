# Jev encoding-rules probe: results (F1-F4)

**Status: DRAFT — placeholder, being filled in after the real dispatch completes. Do not cite numbers
from this file until the placeholders below are replaced.**

This is an **exploratory, one-factor-at-a-time** battery of static probes (one request -> one Choice;
no simulator, no renderer, no development/confirmation split). Every case is generated with a fixed
seed, mirrored left/right where meaningful, and the correct option's menu position balanced across
cases. Underlying facts and the correct answer are identical across the arms of a factor; only the
declared presentation factor differs. Model: `jev-1.13.0`, single model version, single day.

See `experiments/jev-encoding-rules/` for generators, oracle, checks and the run/analyze scripts, and
`experiments/jev-encoding-rules/WORKLOG.md` for the working log.

## Rules of thumb

_(to fill in after analysis)_

## Per-factor results

### F1: menu size / granularity

_(table: arm, correct/total, harmful, mean input tokens, latency p50/p95)_

### F2: near-tie resolution

_(table)_

### F3: consequence form

_(table)_

### F4: numbers vs words and sign conventions

_(table)_

## Totals

_(requests, input tokens, cost, latency)_

## Limits

- Static, single-shot Choice probes: no simulator, no closed-loop feedback, no repeated interaction.
- Facts are synthetic/stipulated, not sensor-derived; this measures encoding sensitivity in isolation,
  not end-to-end task performance.
- Exploratory, one-factor-at-a-time: no development/confirmation split, no multiple-comparison
  correction across arms.
- Single model version (`jev-1.13.0`); results may not transfer to other versions.
- F1-F4 only (priority order); F5-F10 not attempted in this pass (see WORKLOG.md).

## Appendix: one rendered example request per factor

_(to fill in)_
