import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingFailure } from "../experiments/jev-strategies/report.ts";
import { ReactiveWorld } from "../experiments/reactive/world.ts";
import { makeMenu, goalFor } from "../experiments/reactive/contract.ts";
import {
  MODEL,
  STRATEGIES,
  firstRequest,
  judge,
  type Request,
  type Response,
  type Strategy,
  choice,
  presentedState,
} from "../experiments/jev-strategies/strategies.ts";

test("Batch billing stop distinguishes exhausted credits from per-request errors and completed model responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-billing-"));
  try {
    const file = join(directory, "trace.jsonl");
    await writeFile(
      file,
      [
        { kind: "strategy.http-error", data: { status: 400 } },
        { kind: "strategy.response", data: { status: 402 } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    assert.equal(await billingFailure(file), null);
    await writeFile(
      file,
      JSON.stringify({
        kind: "strategy.http-error",
        data: { status: 402, raw: "billing_error" },
      }),
    );
    assert.equal((await billingFailure(file))?.raw, "billing_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rounded provider tables tolerate one percentage point without replacing the returned choice", () => {
  const body: Response = {
    model: MODEL,
    answers: {
      move: {
        type: "choice",
        choice: "a",
        confidence: 0.1,
        probabilities: { a: 0.49, b: 0.5, c: 0.01 },
      },
    },
  };
  assert.equal(choice(body, "move", ["a", "b", "c"]), "a");
  body.answers.move.probabilities = { a: 0.48, b: 0.51, c: 0.01 };
  assert.throws(() => choice(body, "move", ["a", "b", "c"]), /Invalid choice/);
});

test("Range presentation preserves every return and timestamps without mutating original evidence", async () => {
  const world = await ReactiveWorld.create(24);
  try {
    const menu = makeMenu(world.state()),
      original = structuredClone(menu.state),
      delivered = presentedState(menu) as any;
    const raw = (menu.state as any).ranges;
    assert.deepEqual(menu.state, original);
    assert.equal(delivered.ranges.value.points.length, raw.value.points.length);
    assert.equal(delivered.ranges.acquiredMs, raw.acquiredMs);
    assert.equal(delivered.ranges.receivedMs, raw.receivedMs);
    for (const [i, p] of raw.value.points.entries())
      for (const axis of ["x", "y", "z"])
        assert(
          Math.abs(p[axis] - delivered.ranges.value.points[i][axis]) <=
            0.000501,
        );
  } finally {
    await world.close();
  }
});

function response(request: Request): Response {
  return {
    model: MODEL,
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        const ids = Object.keys(q.criteria),
          chosen = ids.at(-1)!;
        return [
          id,
          {
            type: q.type,
            confidence: 1,
            probabilities: Object.fromEntries(
              ids.map((k) => [k, k === chosen ? 1 : 0]),
            ),
            ...(q.type === "choice" ? { choice: chosen } : { score: 3 }),
          },
        ];
      }),
    ),
    usage: { input_tokens: 123, output_tokens: 0 },
  };
}
test("All strategies execute only offered controls, preserve original sensor snapshot across stages, and record all requests", async () => {
  const world = await ReactiveWorld.create(19);
  try {
    const menu = makeMenu(world.state());
    for (const strategy of Object.keys(STRATEGIES) as Strategy[]) {
      const requests: Request[] = [],
        events: any[] = [];
      const result = await judge(
        menu,
        strategy,
        "unused-offline-fixture",
        (kind, data) => events.push({ kind, data }),
        new AbortController().signal,
        async (request) => {
          requests.push(structuredClone(request));
          await world.tick();
          return response(request);
        },
      );
      assert(
        menu.candidates.some((c) => c.id === (result.value as any).choice),
      );
      assert.equal(
        requests.length,
        ["sequential", "score-shortlist"].includes(strategy) ? 2 : 1,
      );
      assert.equal(
        events.filter((e) => e.kind === "strategy.response").length,
        requests.length,
      );
      for (const r of requests)
        assert.equal((r.state as any).simMs, menu.source.simMs);
      if (strategy === "score-shortlist")
        assert.equal(
          Object.keys(requests[1]!.questions.maneuver!.criteria).length,
          24,
        );
    }
  } finally {
    await world.close();
  }
});
test("English goal cannot change offered controls or calculated geometry; raw presentation has no predictions", async () => {
  const world = await ReactiveWorld.create(21);
  try {
    const state = world.state(),
      a = makeMenu(state),
      b = makeMenu({ ...state, goal: goalFor("behind") });
    assert.deepEqual(a.candidates, b.candidates);
    for (const strategy of Object.keys(STRATEGIES) as Strategy[])
      assert.deepEqual(
        firstRequest(a, strategy).questions,
        firstRequest(b, strategy).questions,
      );
    const raw = firstRequest(a, "flat-raw");
    assert(!Object.hasOwn(raw.state as object, "measuredCurrentGeometry"));
    assert(!JSON.stringify(raw.questions).includes("endENU"));
    const compact = firstRequest(a, "flat-prose");
    assert.equal((compact.state as any).ranges.value, undefined);
    assert(
      (compact.state as any).ranges.representation.includes(
        "loses spatial detail",
      ),
    );
  } finally {
    await world.close();
  }
});
test("Provider errors and unoffered answers cannot silently select a fallback action", async () => {
  const world = await ReactiveWorld.create(22);
  try {
    const menu = makeMenu(world.state());
    await assert.rejects(
      judge(
        menu,
        "flat-facts",
        "unused",
        () => {},
        new AbortController().signal,
        async (r) => {
          const b = response(r);
          b.answers.maneuver.choice = "invented";
          return b;
        },
      ),
      /Invalid choice/,
    );
    await assert.rejects(
      judge(
        menu,
        "flat-facts",
        "unused",
        () => {},
        new AbortController().signal,
        async () => {
          throw new Error("HTTP failure");
        },
      ),
      /HTTP failure/,
    );
    const abort = new AbortController();
    abort.abort();
    let called = false;
    await assert.rejects(
      judge(
        menu,
        "flat-facts",
        "unused",
        () => {},
        abort.signal,
        async (r) => {
          called = true;
          return response(r);
        },
      ),
    );
    assert.equal(called, false);
  } finally {
    await world.close();
  }
});
