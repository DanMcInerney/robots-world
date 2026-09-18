# Jev game controllers: what actually chooses the actions?

Research checked 17 September 2026 (US Eastern). Public repositories were read, not executed. Reported game results belong to their authors; our separately executed drone results are in [flight-results.md](flight-results.md). Repository links below pin the inspected revisions.

## What the supplied reference changes

The [pjburnhill reference](https://gist.github.com/pjburnhill/adf8d28efcad9df037bfdece178ef965/cb2677525452604464b694af28dfb4fb19dbe4bb) is useful guidance for designing the interface: supply evidence, ask focused judgments, and keep computation and execution in code. It is a community working document, not independent evidence of game performance or a disclosure of Jev's architecture. Its distinction between judging supplied alternatives and generating a new plan is particularly relevant here.

The corresponding primary documentation explicitly discourages arithmetic and stacked reasoning in Jev questions: [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13). [Choice](https://docs.typesafe.ai/primitives/choice) permits up to 255 alternatives per question. [Fan-out](https://docs.typesafe.ai/patterns/fan-out) evaluates questions independently: a target question cannot consume an intent answer from the same request. Software can nevertheless ask conditional questions speculatively and execute only the selected branch. These are interface constraints, not evidence of a universal maximum number of robot controls.

## Source-backed examples

### StarCraft: hierarchical commands and separate control opportunities

[phyous/tsai-sc](https://github.com/phyous/tsai-sc/tree/6046ecc60156c4a3c04d384b41821a4ff08501b7) controls the original shareware campaign. Its [command graph](https://github.com/phyous/tsai-sc/blob/6046ecc60156c4a3c04d384b41821a4ff08501b7/tsai_sc/combat.py#L840) asks for an intent and independent conditional concrete commands. The executor routes through the chosen intent. Candidates bind observed units, targets and locations; code computes geometry and bounds the menu. Army and economy can alternate fresh decision opportunities, preventing constant fighting from consuming every opportunity to produce units. Strategic guidance is supplied in the prompt.

Crucially, [the runner pauses during inference](https://github.com/phyous/tsai-sc/blob/6046ecc60156c4a3c04d384b41821a4ff08501b7/tsai_sc/run.py#L147). The README reports one successful Strongarm development run, referencing earlier revision `d055e37`, with 421 decisions and roughly 383 ms median API latency. This is evidence of bounded semantic command selection in a complex game, not an unpaused micro-control benchmark, general win rate, or matched LLM comparison.

### Doom: a real asynchronous loop, with substantial control assistance

[AmoghCreator/doom-jev](https://github.com/AmoghCreator/doom-jev/tree/b27663fc0fa386f9d15ad6ea3c8f15374b855479) asks six kinds of questions: goal, target, movement, rotation, jump and firing. [The loop](https://github.com/AmoghCreator/doom-jev/blob/b27663fc0fa386f9d15ad6ea3c8f15374b855479/main.py) continues game ticks during HTTP inference and holds the previous action between responses.

[Composition code](https://github.com/AmoghCreator/doom-jev/blob/b27663fc0fa386f9d15ad6ea3c8f15374b855479/agent/composition_dag.py) overrides rotation with computed target bearing and can automatically select the nearest visible hostile and fire. This is a Jev/code hybrid. The inspected loop recomputes that composition when a response arrives, despite stronger README language about ongoing geometric tracking. Its claimed approximately 10 Hz inference is not a latency distribution I independently verified. Eight output buttons do not mean every combination is offered: movement selects one cardinal direction or none.

TypeSafe's [own Doom demonstration](https://typesafe.ai/blog/introducing-system-one-models-and-jev) describes roughly ten decision batches per second from structured state. I did not locate the official demo's complete source; the community project above is a separate implementation. Projects called [jevlike](https://github.com/vinnylarouge/jevlike) and [open-jev](https://github.com/daseinlabs/open-jev) also have game demos, but their independent models must not be counted as measurements of TypeSafe Jev.

### Mario: seven macros plus action-specific timing facts

[fhshaik/typesafe-mario](https://github.com/fhshaik/typesafe-mario/tree/ca22449ed187118d19326d1f54b01b6636578aa4) exposes [seven button macros](https://github.com/fhshaik/typesafe-mario/blob/ca22449ed187118d19326d1f54b01b6636578aa4/src/typesafe_mario/actions.py). Its [policy](https://github.com/fhshaik/typesafe-mario/blob/ca22449ed187118d19326d1f54b01b6636578aa4/src/typesafe_mario/policy.py) receives calculated trajectory/timing facts, including a flag that a jump must start this decision, with instructions to jump when it is true. This supplies considerable platforming knowledge. The displayed runner advances while a worker awaits Jev; its headless branch instead waits for a decision before advancing action frames. Neither mode establishes arbitrary NES control mastery.

### HEIST ONE: many agents, small judgments per agent

[AbdelStark/heist-one](https://github.com/AbdelStark/heist-one/tree/632c9a55a1e5eb2cbf0b9f87db575f0b5eb36e8c) batches four judgments per guard: threat, suspicion, intent and attention. Six guards yield 24 questions; movement execution remains game code. [Request construction](https://github.com/AbdelStark/heist-one/blob/632c9a55a1e5eb2cbf0b9f87db575f0b5eb36e8c/apps/server/src/jev.ts) puts all guard contexts in one request and instructs each question to use its own context. That is shared-context batching, not enforced isolation between decentralized robots. The recorded successful extraction belongs to the scripted player facing Jev guards; it is not Jev winning as the player. A scripted adapter/fallback is also present.

### Snake and Gomoku: describe the consequences of each candidate

[sorrycc/typesafe-snake](https://github.com/sorrycc/typesafe-snake/blob/8bf3f7c261ad35ece3345a02d21ba638ddfaf87f/src/jev/prompt.ts) annotates legal moves with food distance, reachable free space and tail reachability. Jev receives useful consequences instead of having to calculate a flood fill. The strategy prompt still tells it what to prioritize, and the controller has a late-response fallback.

[mizchi/jev-gomoku](https://github.com/mizchi/jev-gomoku/tree/82b3afdc7632b30c110266b975b09e2040906fba) selects cells on a 15-by-15 board. [Candidate generation](https://github.com/mizchi/jev-gomoku/blob/82b3afdc7632b30c110266b975b09e2040906fba/gomoku/gomoku.mbt#L128) restricts options to cells within two squares of existing stones. [Descriptions](https://github.com/mizchi/jev-gomoku/blob/82b3afdc7632b30c110266b975b09e2040906fba/cmd/gomoku/main.mbt#L360) calculate line lengths and explicitly label immediate winning/blocking moves. Invalid responses invoke a win/block/centre fallback. This demonstrates a variable menu, but substantial tactical work is already supplied.

### Two especially relevant neighboring examples

The [Flappy Syumai userscript](https://gist.github.com/L4Ph/71bacb8de3b9f1888d299df36ff0a377) asks Jev for a clearance policy, then implements frame-level flapping locally. Its author reports variable request latency made remote flap-now decisions ineffective. A policy can remain useful longer than a single timed keypress. This example has a small action space, but addresses our stale-action problem directly.

[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast/tree/452c1ad2dd628008f1d5608f28158d76e49e6cc0) is not a game, but provides a concrete generative hybrid: dynamic observed controls become conditional operation/target choices; a small LLM writes text only when needed. [Model code](https://github.com/browser-use/jev-ultrafast/blob/452c1ad2dd628008f1d5608f28158d76e49e6cc0/jev_ultrafast/model.py) binds choices to observed element identities. This suggests pairing Jev's selection with occasional generation rather than asking a slow model for every immediate action.

The [MuJoCo Jev drone](https://github.com/RomanSlack/jev-drone) similarly keeps fast stabilization/guidance in code and asks slower tactical questions. Its reported improvement after exposing vertical obstacle information is relevant to sensor design. Its comparison against a baseline unable to climb does not establish superiority over a capable alternative controller.

## Revised experiment design — proposed, not run

Update: the [continuous-world results](reactive-results.md) now cover calculated consequences, conditional bundles, a Codex-authored natural-language brief and one asynchronous repair per flight. Candidate-count sweeps, generated candidate code, independent control lanes and full native authored routines below remain proposed.

Our completed [numeric-control pilot](flight-results.md) is a useful latency/failure measurement. It is not the strongest representation suggested by these projects. A large Cartesian product proves controls are available; it does not prove the questions make their consequences understandable.

1. **Same controls, better descriptions.** Keep the current plant, limits, sensors and candidate actions. Calculate short-horizon consequences from delivered observations: predicted displacement, clearance against observed geometry, bearing change, target framing, and uncertainty. Show those facts identically to Jev, Claude and Codex. Do not emit an overall score, preferred action, requested-side verdict or hidden route. Compare bare vectors with annotated vectors.
2. **Conditional, coherent bundles.** Compare separate numeric heads against intent plus complete maneuver candidates. Each candidate includes compatible movement and camera settings. Ask conditional branch choices in one request, route exactly one branch, and measure invalid combinations and option-count sensitivity. Test 16/64/128/255 candidates without changing the nominal actuator capability; explicitly measure the coverage lost through sampling.
3. **Codex prepares a reusable decision policy.** Before flight, allow Codex to translate the English mission into question wording, constraints and candidate-generation code. Count compilation time/cost separately and end-to-end. During flight Jev judges fresh observations. Compare this with Jev receiving the English goal directly and with native agents given the same reusable execution capability. The current per-frame concrete-proposal hybrid is a different, much shorter-lived design.
4. **Asynchronous policy repair.** Let Codex inspect failures and replace a bounded policy while the previous one continues. A policy may bind current observed targets when invoked; it must not silently relabel stale absolute coordinates as fresh. Log version, source evidence, installation, cancellation and actual action provenance. Compare against the frozen preflight policy to establish whether online reasoning adds value.
5. **Separate movement and camera opportunities.** Test independent judgment lanes with compatible merge rules and one actuator owner. A camera decision must not be starved by deliberation about translation. Compare to atomic bundles because decoupling may also harm coordination. For swarms, separately test centralized batches and isolated per-robot requests using delivered radio data.

Keep continuous wall time in all flight comparisons. Randomize task wording, desired side, motion and obstacles on held-out episodes so a supplied policy cannot contain the answer. Also replay an identical observation/menu with different English goals: if selections cannot respond to the changed goal, the decision layer is not demonstrating the intended flexibility. Ordinary kinematics are shared infrastructure; route selection, target selection, ranking and mission-specific fallback behavior are policy and must be attributed. Any new safety filter must be identical across arms, separately logged and evaluated with its interventions visible.

Nervelet should retain acquisition, observation boundaries, cancellation and job ownership; these policies belong to the controller/environment integration. Robots World supplies interchangeable devices, physics and evidence. Neither core needs a Jev-specific planner to support these experiments.
