import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { sourceHash, trial } from "../reactive/run.ts";
import { DEFAULT_CONFIG, experimentConfig } from "../reactive/config.ts";
import { MODEL, STRATEGIES, type Strategy } from "./strategies.ts";
import { billingFailure, report } from "./report.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith("--") || !process.argv[i + 1])
    throw new Error("--name value pairs required");
  args.set(process.argv[i]!.slice(2), process.argv[i + 1]!);
}
const phase = args.get("phase") ?? "development",
  directory = resolve(
    args.get("output") ?? `.runtime/experiments/jev-strategies-${Date.now()}`,
  );
const strategies = (
  args.get("strategies") ?? Object.keys(STRATEGIES).join(",")
).split(",") as Strategy[];
const seeds = (
    args.get("seeds") ?? (phase === "development" ? "71" : "701,702,703,704")
  )
    .split(",")
    .map(Number),
  seconds = Number(
    args.get("seconds") ?? (phase === "development" ? "20" : "60"),
  );
if (
  !["development", "held-out"].includes(phase) ||
  !Number.isFinite(seconds) ||
  seconds < 15 ||
  seconds > 90 ||
  !seeds.length ||
  seeds.length > 8 ||
  new Set(seeds).size !== seeds.length ||
  seeds.some(
    (s) =>
      !Number.isInteger(s) ||
      s < 1 ||
      s > 100000 ||
      (phase === "development" ? s >= 100 : s < 100),
  ) ||
  !strategies.length ||
  new Set(strategies).size !== strategies.length ||
  strategies.some((s) => !Object.hasOwn(STRATEGIES, s))
)
  throw new Error("Invalid experiment");
const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
if (!key) throw new Error("Real Jev credential required");
const hash = await sourceHash(),
  configs = Object.fromEntries(
    strategies.map((id) => [
      id,
      experimentConfig({
        ...DEFAULT_CONFIG,
        commandSeconds: STRATEGIES[id].seconds,
        minimumRefreshMs: 200,
      }),
    ]),
  );
if (phase === "held-out") {
  if (!args.get("freeze")) throw new Error("Development freeze required");
  const freeze = JSON.parse(
    await readFile(resolve(args.get("freeze")!), "utf8"),
  );
  if (
    freeze.sourceHash !== hash ||
    JSON.stringify(freeze.configs) !== JSON.stringify(configs)
  )
    throw new Error("Source/configuration changed after development");
}
await mkdir(directory, { recursive: true });
const manifest = {
  phase,
  recordedAt: new Date().toISOString(),
  model: MODEL,
  sourceHash: hash,
  strategies,
  definitions: STRATEGIES,
  seeds,
  seconds,
  configs,
  maxDecisions: 300,
  order:
    "Rotate strategy order by seed index. One flight at a time; no concurrent API competition.",
  design:
    "All eight real Jev controllers receive the English goal and dated delivered sensors. Continuous physics/sensing at 50 Hz; target turns, crossing obstacle, beacon blackout and midway English goal reversal. Up to 53 velocities x 4 camera variants; only capability/envelope filtering, never goal/obstacle ranking. Existing local servo stabilizes setpoints; Jev chooses every mission maneuver.",
  scoring: DEFAULT_CONFIG.scoring,
  limits: {
    maxReportedInputTokens: 500000000,
    scope:
      "Batch stops before next flight once this reported-token limit is reached. In-flight and cancelled request billing may exceed reported usage. No automatic retries.",
  },
  limitations: [
    "Simplified stabilized velocity plant, not raw attitude/motor control or PX4 SITL.",
    "Sensors are simulated geometric detections and cooperative target broadcasts, not RGB vision.",
    "Camera pointing options compute one-time angles; no automatic tracker. Geometry annotations use received measurements, not evaluator truth.",
    "A single drone and moving rover; no swarm claim.",
    "Four held-out seeds support exploratory comparisons, not a general ranking or proof of hardware readiness.",
    "No Claude/Codex performance comparison in this batch. Jev returns typed answers/probabilities, not a reasoning transcript.",
    "One-second commands alter both prediction horizon and feasible menu; compact prose also removes raw range spatial detail.",
  ],
  sources: [
    "https://docs.typesafe.ai/introduction",
    "https://docs.typesafe.ai/primitives/choice",
    "https://docs.typesafe.ai/primitives/score",
    "https://docs.typesafe.ai/patterns/fan-out",
    "https://docs.typesafe.ai/model-jaggedness/jev-1.13",
  ],
};
await writeFile(
  resolve(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  { flag: "wx" },
);
const sourceFiles = ["package.json", "package-lock.json"];
for (const root of [
  "src",
  "controllers",
  "integrations",
  "experiments",
  "scenarios",
])
  for (const file of await readdir(root, { recursive: true }))
    if (file.endsWith(".ts") || file.endsWith(".json"))
      sourceFiles.push(`${root}/${file.replaceAll("\\", "/")}`);
for (const file of sourceFiles) {
  const to = resolve(directory, "source", file);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(file, to);
}
await writeFile(
  resolve(directory, "source/SNAPSHOT.json"),
  JSON.stringify({ sourceHash: hash, files: sourceFiles }, null, 2),
);
const results: any[] = [],
  invalidTrials: any[] = [];
let tokens = 0;
await writeFile(
  resolve(directory, "results.json"),
  JSON.stringify({ manifest, results, invalidTrials }),
);
outer: for (const [index, seed] of seeds.entries())
  for (let offset = 0; offset < strategies.length; offset++) {
    if (tokens >= manifest.limits.maxReportedInputTokens) {
      console.log(JSON.stringify({ event: "budget-stop", tokens }));
      await writeFile(
        resolve(directory, "STOPPED.json"),
        JSON.stringify(
          {
            reason: "token-budget",
            recordedAt: new Date().toISOString(),
            message:
              "The reported input-token budget was reached. No further flight was started.",
            tokens,
          },
          null,
          2,
        ),
      );
      await report(directory);
      break outer;
    }
    const strategy = strategies[(index + offset) % strategies.length]!;
    console.log(JSON.stringify({ event: "start", strategy, seed, seconds }));
    try {
      results.push(
        await trial({
          arm: strategy,
          strategy,
          seed,
          seconds,
          directory,
          key,
          phase,
          config: configs[strategy],
          maxDecisions: 300,
        }),
      );
    } catch (error) {
      const invalid = {
        id: `${strategy}-${seed}`,
        arm: strategy,
        seed,
        error: String(error),
      };
      invalidTrials.push(invalid);
      await writeFile(
        resolve(directory, `${invalid.id}.invalid.json`),
        JSON.stringify(invalid, null, 2),
      );
    }
    await writeFile(
      resolve(directory, "results.json"),
      JSON.stringify({ manifest, results, invalidTrials }),
    );
    const billing = await billingFailure(
      resolve(directory, `${strategy}-${seed}.jsonl`),
    );
    if (billing)
      await writeFile(
        resolve(directory, "STOPPED.json"),
        JSON.stringify(
          {
            reason: "billing-exhausted",
            recordedAt: new Date().toISOString(),
            trial: `${strategy}-${seed}`,
            message:
              "TypeSafe returned HTTP 402. The failed flight completed in local hold; the batch stopped before requesting another strategy. No automatic retry.",
            providerError: billing,
          },
          null,
          2,
        ),
      );
    const evidence = await report(directory);
    tokens = evidence.runs.reduce((sum: number, r: any) => sum + r.tokens, 0);
    console.log(
      JSON.stringify({
        event: "progress",
        completed: results.length,
        invalid: invalidTrials.length,
        reportedInputTokens: tokens,
        summary: evidence.summary.filter((s: any) => s.id === strategy),
      }),
    );
    if (billing) break outer;
  }
if (
  phase === "development" &&
  !invalidTrials.length &&
  results.length === seeds.length * strategies.length
)
  await writeFile(
    resolve(directory, "freeze.json"),
    JSON.stringify(
      {
        sourceHash: hash,
        configs,
        note: "All representations retained. Development fixes only; no held-out tuning.",
      },
      null,
      2,
    ),
  );
