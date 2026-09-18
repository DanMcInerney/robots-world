import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { firstRequest, type Strategy } from "./strategies.ts";
import { makeMenu } from "../reactive/contract.ts";
import { axesRequest, compose, COMBINATIONS, type AxesArm } from "../jev-axes/controller.ts";

/** A global billing failure cannot be resolved by trying another strategy. */
export async function billingFailure(file: string) {
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    const row = JSON.parse(line);
    if (row.kind === "strategy.http-error" && row.data.status === 402)
      return row.data;
  }
  return null;
}

export const percentile = (v: number[], p: number) =>
  v.length ? [...v].sort((a, b) => a - b)[Math.ceil(v.length * p) - 1]! : null;
/** Check original clocks; presentation rounding is separately verified by request reconstruction. */
export function assertSensorCausality(observation: any) {
  for (const sensor of Object.values(observation.sensors) as any[])
    if (sensor) assert(sensor.acquiredSimMs <= sensor.receivedSimMs && sensor.receivedSimMs <= observation.simMs, 'Noncausal factored sensor');
}
/** Offline trace audit and indexed report. Exact payloads live in lazy-loaded decision files. */
export async function report(directory: string) {
  const batch = JSON.parse(
    await readFile(resolve(directory, "results.json"), "utf8"),
  );
  const runs: any[] = [],
    environments = new Map<number, string>();
  await mkdir(resolve(directory, "decisions"), { recursive: true });
  for (const result of batch.results) {
    let manifest: any,
      menu: any,
      current: any,
      last: any,
      count = 0,
      worldId = 0,
      simMs = 0,
      admitted: any;
    const decisions: any[] = [],
      events: any[] = [],
      applications: any[] = [],
      checks: string[] = [],
      callLatencies: number[] = [];
    let tokens = 0,
      outputTokens = 0,
      sensorSamples = 0,
      packets = 0,
      missingUsage = 0;
    const byId = new Map<string, any>(), portObservations = new Map<number, any>(), portFeedback: any[] = [];
    for await (const line of createInterface({
      input: createReadStream(resolve(directory, `${result.id}.jsonl`)),
      crlfDelay: Infinity,
    })) {
      const row = JSON.parse(line),
        d = row.data;
      last = row;
      count++;
      if (typeof d?.simMs === "number") simMs = Math.max(simMs, d.simMs);
      assert(row.kind !== "reactive.invalid", "Invalid trace");
      if (row.kind === "reactive.manifest") {
        manifest = d;
        assert.equal(d.sourceHash, batch.manifest.sourceHash);
      }
      if (row.kind === "reactive.menu") menu = d;
      if (row.kind === 'reactive.port.observation') {
        portObservations.set(d.sequence, d);
        if (portObservations.size > 64) portObservations.delete(portObservations.keys().next().value!);
      }
      if (row.kind === "axes.request") {
        assert.deepEqual(d.rawObservation, portObservations.get(d.rawObservation.sequence), 'Controller request is not based on the observation actually delivered by the port');
        assert.deepEqual(d.rawFeedback, portFeedback, 'Controller feedback differs from actual tool receipts');
        assert.deepEqual(d.request, axesRequest(d.rawObservation, result.arm as AxesArm, portFeedback), 'Factored request differs from delivered observation');
        assert.equal(d.source.simMs, d.rawObservation.simMs);
        assert.equal(d.source.odometryMs, d.rawObservation.sensors.odometry.acquiredSimMs);
        current = { id: d.decisionId, index: decisions.length, simMs: d.source.simMs, source: d.source,
          rawSensors: d.rawObservation, rawObservation: d.rawObservation, candidates: [], offeredCount: COMBINATIONS,
          candidateScope: 'The candidate inspector shows only the composed selection. All 6 complete option sets are in the exact API request; no joint tuples were prefiltered.',
          requests: [], responses: [], wire: [] };
        decisions.push(current); byId.set(current.id, current);
        assertSensorCausality(d.rawObservation);
      }
      if (row.kind === "strategy.request" || row.kind === "axes.request") {
        if (d.stage === "initial" && row.kind !== "axes.request") {
          assert(menu.rawSensors, "Raw source snapshot missing");
          const rebuilt = makeMenu(menu.rawSensors, true, manifest.config);
          assert.deepEqual(
            JSON.parse(JSON.stringify(rebuilt.candidates)),
            menu.candidates,
            "Menu differs from sensor-only reconstruction",
          );
          assert.equal(d.menuHash, rebuilt.hash);
          assert.deepEqual(
            d.request,
            JSON.parse(
              JSON.stringify(firstRequest(rebuilt, result.arm as Strategy)),
            ),
            "Actual request differs from declared strategy",
          );
          current = {
            id: d.decisionId,
            index: decisions.length,
            simMs: d.source.simMs,
            source: d.source,
            menuHash: d.menuHash,
            rawSensors: menu.rawSensors,
            candidates: menu.candidates,
            requests: [],
            responses: [],
            wire: [],
          };
          decisions.push(current);
          byId.set(current.id, current);
        }
        const decision = byId.get(d.decisionId);
        assert(decision, "Request without decision");
        assert.deepEqual(
          d.source,
          decision.source,
          "Follow-up refreshed original observation silently",
        );
        const state = d.request.state;
        for (const key of ["odometry", "target", "camera", "ranges"]) {
          const s = state[key];
          if (s)
            assert(
              s.acquiredMs <= s.receivedMs && s.receivedMs <= state.simMs,
              "Noncausal sample",
            );
        }
        if (decision.requests.length)
          assert.deepEqual(
            state.odometry,
            decision.requests[0].request.state.odometry,
            "Follow-up odometry changed",
          );
        decision.requests.push({
          ...d,
          recordedSimMs: simMs,
          wallMs: row.wallMs,
        });
      }
      if (
        row.kind === "strategy.response" ||
        row.kind === "strategy.http-error"
      ) {
        const decision = byId.get(d.decisionId);
        assert(decision);
        decision.responses.push({
          ...d,
          kind: row.kind,
          recordedSimMs: simMs,
          wallMs: row.wallMs,
        });
        callLatencies.push(d.latencyMs);
        if (d.body?.usage) {
          tokens += d.body.usage.input_tokens ?? 0;
          outputTokens += d.body.usage.output_tokens ?? 0;
        } else missingUsage++;
      }
      if (row.kind === "strategy.selection")
        byId.get(d.decisionId).selection = d;
      if (row.kind === "strategy.shortlist")
        byId.get(d.decisionId).shortlist = d;
      if (row.kind === 'axes.mapping') {
        const decision = byId.get(d.decisionId);
        assert(decision?.rawObservation, 'Mapping without observation');
        const expected = compose(decision.rawObservation, decision.requests[0].request, decision.responses.at(-1).body);
        assert.deepEqual(d.candidate, expected.candidate, 'Mapped command differs from model choices');
        assert.deepEqual(d.selections, expected.selections);
        decision.candidates = [d.candidate];
        decision.mapping = d;
      }
      if (row.kind === "reactive.command.admitted") admitted = d;
      if (row.kind === 'reactive.port.command') {
        portFeedback.push({ command: d.command, receipt: d.receipt }); if (portFeedback.length > 3) portFeedback.shift();
        const decision = byId.get(d.command.id);
        if (decision?.rawObservation) {
          const { duration, ...args } = decision.mapping.candidate.action;
          assert.deepEqual(d.command.args, args, 'Command changed after factor composition');
          assert.equal(d.command.validForMs, duration * 1000);
          assert.equal(d.command.basedOn.observation, decision.rawObservation.sequence);
          assert.deepEqual(d.source, decision.source, 'Command used a different source observation');
          const accepted = d.receipt.status === 'accepted' || d.receipt.status === 'completed';
          decision.execution = { ...d, receipt: { ...d.receipt, accepted }, candidate: decision.mapping.candidate };
          if (accepted) {
            assert.deepEqual(admitted.action, decision.mapping.candidate.action);
            assert.deepEqual(admitted.source, decision.source);
            assert(d.simMs - d.source.odometryMs <= manifest.config.sourceAgeLimitMs);
            decision.admission = admitted;
          }
        }
      }
      if (row.kind === "reactive.decision") {
        const decision = byId.get(d.answer.value.decisionId);
        assert(decision);
        assert.deepEqual(
          d.candidate,
          decision.candidates.find((c: any) => c.id === d.answer.value.choice),
          "Unoffered action",
        );
        decision.execution = d;
        if (d.receipt.accepted) {
          assert.equal(d.source.goalVersion, decision.source.goalVersion);
          assert(
            d.simMs - d.source.odometryMs <= manifest.config.sourceAgeLimitMs,
          );
          decision.admission = admitted;
        }
      }
      if (row.kind === "reactive.camera.command") {
        assert(d.remainingMs > 0 && d.simMs < d.expiresMs);
        applications.push(d);
      }
      if (row.kind === "world.event") {
        assert.equal(d.id, ++worldId, "World journal gap");
        assert(!d.truncated);
        if (d.channel === "sensor") sensorSamples++;
        if (d.channel === "protocol" && d.kind === "rx") packets++;
        if (current && ["protocol", "network", "command"].includes(d.channel))
          current.wire.push(row);
      } else if (
        /^(reactive\.(goal|error|controller|fallback|expired|command-link|command\.rejected|stimulus))/.test(
          row.kind,
        )
      )
        events.push({ simMs, kind: row.kind, data: d });
    }
    assert.equal(last.kind, "trace.complete");
    assert.equal(last.data.count, count - 1);
    assert.equal(last.data.dropped, 0);
    assert.equal(decisions.length, result.stats.started);
    assert(sensorSamples > 0);
    assert.equal(
      decisions.filter((d) => d.execution?.receipt.accepted).length,
      result.stats.admitted,
    );
    assert.equal(result.evaluation.trajectory.length, result.seconds * 10);
    assert(result.maxLagMs <= 1000);
    const motion = JSON.stringify(
      result.evaluation.trajectory.map((f: any) => [
        f.simMs,
        f.target,
        f.crossing,
      ]),
    );
    if (environments.has(result.seed))
      assert.equal(
        motion,
        environments.get(result.seed),
        "Unmatched moving environment",
      );
    else environments.set(result.seed, motion);
    for (const d of decisions) {
      d.applications = applications.filter(
        (a) => a.commandId === d.admission?.commandId,
      );
      d.wireScope =
        "Exact protocol/network/command records between this request and the next initial request. May include preceding commands still in flight; applications below are correlated by commandId.";
      d.file = `decisions/${result.id}-${String(d.index).padStart(4, "0")}.json`;
      await writeFile(resolve(directory, d.file), JSON.stringify(d));
    }
    checks.push(
      "Every initial request reconstructed from delivered sensors only",
      "Original observation preserved across stages",
      "Selected commands match offered actions or exact independently selected control values",
      "Contiguous world journal; complete trace",
      "Full duration; world advanced during inference",
      "MAVLink applications precede command expiry",
      "Identical target/obstacle trajectory for paired seeds",
    );
    runs.push({
      ...result,
      manifest,
      traceFile: `${result.id}.jsonl`,
      events,
      checks,
      tokens,
      outputTokens,
      missingUsage,
      callLatencies,
      sensorSamples,
      packets,
      decisions: decisions.map((d) => ({
        id: d.id,
        index: d.index,
        simMs: d.simMs,
        file: d.file,
        source: d.source,
        choice: d.selection?.choice ?? null,
        latencyMs: d.selection?.latencyMs ?? null,
        calls: d.requests.length,
        questions: d.requests.map(
          (r: any) => Object.keys(r.request.questions).length,
        ),
        offered: d.offeredCount ?? d.candidates.length,
        accepted: d.execution?.receipt.accepted ?? null,
        admittedMs: d.execution?.simMs ?? null,
        appliedMs: d.applications[0]?.simMs ?? null,
        applicationAgeMs: d.applications[0]
          ? d.applications[0].simMs - d.source.odometryMs
          : null,
        selection: d.selection ?? null,
      })),
    });
  }
  const summary = batch.manifest.strategies.map((id: string) => {
    const rs = runs.filter((r) => r.arm === id),
      sum = (fn: (r: any) => number) => rs.reduce((s, r) => s + fn(r), 0);
    return {
      id,
      attempts: rs.length,
      invalid: batch.invalidTrials.filter((r: any) => r.arm === id).length,
      successes: sum((r) => Number(r.evaluation.success)),
      framingFraction: rs.length
        ? sum(
            (r) =>
              r.evaluation.phases.reduce(
                (s: number, p: any) => s + p.framingFraction,
                0,
              ) / 2,
          ) / rs.length
        : null,
      decisionP50Ms: percentile(
        rs.flatMap((r) => r.stats.latencyMs),
        0.5,
      ),
      decisionP95Ms: percentile(
        rs.flatMap((r) => r.stats.latencyMs),
        0.95,
      ),
      callP50Ms: percentile(
        rs.flatMap((r) => r.callLatencies),
        0.5,
      ),
      applicationAgeP50Ms: percentile(
        rs.flatMap((r) =>
          r.decisions
            .map((d: any) => d.applicationAgeMs)
            .filter((n: any) => n !== null),
        ),
        0.5,
      ),
      tokens: sum((r) => r.tokens),
      missingUsage: sum((r) => r.missingUsage),
      contactsSeconds: sum((r) => r.evaluation.collisionTicks) * 0.02,
      fallbackSeconds: sum((r) => r.evaluation.fallbackMs) / 1000,
      errors: sum((r) => r.stats.errors),
      guardInterventions: sum((r) => r.evaluation.guardInterventions),
      decisions: sum((r) => r.stats.completed),
      admitted: sum((r) => r.stats.admitted),
      rejected: sum((r) => r.stats.rejected),
    };
  });
  const output = {
    ...batch,
    runs,
    results: undefined,
    summary,
    stopped: await readFile(resolve(directory, "STOPPED.json"), "utf8")
      .then(JSON.parse)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    complete:
      runs.length + batch.invalidTrials.length ===
      batch.manifest.strategies.length * batch.manifest.seeds.length,
    audit: {
      runs: runs.length,
      environmentSeeds: [...environments.keys()],
      pairedSeeds: [...environments.keys()].filter(seed => batch.manifest.strategies.every((arm: string) => runs.some(r => r.seed === seed && r.arm === arm))),
      invalid: batch.invalidTrials.length,
    },
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(output));
  return output;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await report(resolve(process.argv[2]!));
