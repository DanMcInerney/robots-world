# Local policies as environment-owned jobs

`integrations/policy-port.ts` adds one optional execution capability around an exclusively owned `RobotPort`. It lets a real Nervelet Bridge admit continuous local work, return its job receipt promptly, and wait while that work runs. The wrapper imports neither Nervelet nor Jev. A policy is an ordinary trusted function receiving a revocable child port and an abort signal.

```ts
import { createPolicyPort } from '../integrations/policy-port.ts';
import { createNerveletEnvironment } from '../integrations/nervelet.ts';

const port = createPolicyPort(physicalPort, {
  local: async (robot, signal) => {
    // Use only this scoped port; physics and sensor acquisition remain external.
    await myLocalController.run([robot], signal);
  },
  fastJudgment: async (robot, signal) => {
    await myExplicitlyConfiguredJevController.run([robot], signal);
  },
}, { maxPolicyMs: 60000 });

const environment = await createNerveletEnvironment(port);
const bridge = new nervelet.Bridge(environment, 'Choose and monitor a local policy');
await bridge.start();
```

The policy registry is explicit application code. Importing or registering a policy makes no API call. A Jev policy still needs its normal explicit credentials, candidate policy, deadline and budget; an injected judge can be used offline. An untrusted or potentially blocking script needs an isolated worker/process runtime. This wrapper is not a JavaScript sandbox or a workflow engine.

## Control contract

`describe()` adds `run_policy` with `{name, replace?: boolean}`. `command({id, action:'run_policy', args:{name}})` returns an accepted receipt and policy job ID without waiting for the policy's first decision. Outer `observe()` merges physical jobs with the policy job and combines source events into one acknowledged sequence. The child receives only the original robot's capabilities, sensors, physical jobs, physical events and delivered messages. It cannot start a nested policy.

Child and supervisor event cursors are separate. Before a child observation is delivered, its physical events are copied into the bounded outer journal. A child acknowledges original physical event IDs; this never acknowledges or removes the supervisor's copies or policy lifecycle events. Only outer acknowledgement releases the journal, including `policy.started`, `policy.completed`, cancellation and failure events. Outer acknowledgement also forwards consumed physical IDs to the physical port. The physical feed itself has one cursor, so an outer acknowledgement may consume a physical event before a child observes it; policies must rely on current physical jobs and samples for durable state. Radio packets retain the physical port's explicit packet acknowledgement semantics.

One policy owns the actuator at a time. A replacement requires `replace:true`; an outer physical command is rejected while the policy is active. The wrapper keeps the sole physical lease. Each child generation has distinct physical command identities, so command IDs reused by a later policy cannot replay earlier effects. Child `stop()`/`close()` ends only that generation and holds the robot; a stale child cannot stop a replacement. The policy function's normal return completes its execution job and requests a physical hold. A policy exception emits `policy.failed` and cancels the execution job; the base Job schema has no separate failed status, so the event retains the failure reason.

Outer `hold` immediately invalidates the current child and requests a nonterminal physical hold. It preserves the underlying receipt: accepted is not confirmed completion. Outer `stop()` and `close()` revoke the physical lease independently of policy inference. The existing Nervelet Environment adapter maps goal replacement to `hold`, so old policy effects are gated without changing the library core.

The wrapper serializes physical mutations. A queued call checks generation before entering the physical port; a returning read/result checks it again. Every policy admission, including the first, settles older in-flight mutations and confirms a physical hold before granting its child generation. The generic physical interface cannot abort or undo an already-issued mutation. A nonterminal hold therefore settles behind the in-flight mutation, and cannot be called confirmed before its own receipt. If that mutation times out or fails with uncertain effect, the wrapper faults and revokes the entire physical lease rather than permitting a replacement writer. Physical adapters must enforce terminal lease revocation when they apply effects; software cannot retract a motor command already accepted by hardware.

## Bounds and clocks

Defaults are a 60-second policy wall deadline, two-second physical-operation deadline, 512 retained command identities, 64 retained policy jobs, 256 unread combined events and 16 pending effects. Configure these through `maxPolicyMs`, `operationMs`, `maxCommands`, `maxJobs`, `maxEvents` and `maxQueuedEffects`. Histories are not silently evicted to admit more effects. Capacity errors are explicit; unread-event overflow faults and stops. If command history is full, emergency outer `hold` performs an explicit terminal stop because another deduplicated hold cannot be retained. Start a fresh wrapper/lease to reset bounded histories.

`maxPolicyMs` is wall time for the local program, including waits for a judge. The `run_policy` envelope's `validForMs` does not define program lifetime: it is not a physical setpoint. Child physical commands retain their normal `validForMs` and observation-provenance semantics. A policy admission with `basedOn` checks an observation actually delivered through the wrapper and its age against a current observation.

Sensor acquisition timestamps remain unchanged. Policy lifecycle `startedSimMs`/`updatedSimMs` use the latest observed simulation clock; they do not claim a new acquisition occurred at the lifecycle transition. An optional `record(kind, data)` callback can stamp events in the host's authoritative journal. Track wall time separately when measuring policy inference or startup. Policy completion means the program returned, not that the physical mission succeeded.

## Offline qualification

The default `test/policy-port.test.ts` suite checks prompt admission, independent acquisition during blocked judgment, replacement, late results, stop, uncertain effects, deduplication, pressure and wall deadlines. The blocked judgment is a fixture, not a native Codex or live Jev benchmark.

The same test file contains real optional Nervelet Bridge integrations. They load the explicitly selected built library, execute `Bridge.step` to admit `run_policy`, wait through the Bridge while sensing continues, replace the goal, verify late child effects are blocked, and stop. They also verify lifecycle events survive child acknowledgement and completion wakes the waiting Bridge. They use a deterministic physical-port fixture and no model inference:

```powershell
$env:ROBOTS_NERVELET_MODULE = 'C:/path/to/nervelet/dist/index.js'
node --test test/policy-port.test.ts
```

`test/nervelet-world.test.ts` adds a physical integration: the actual Bridge admits a tracking policy against the Rapier moving-target world, waits while independent physics and sensing advance, then changes its goal and verifies that the old policy loses command authority. Run it with the same module variable, or run `npm test` to include both suites. No model inference is used.

Without that variable the real-Bridge tests are explicitly skipped, keeping the default project independent of a sibling installation. Passing Bridge tests qualify this adapter contract, not native harness timing, arbitrary policy quality, DroneRTS migration or physical hardware.
