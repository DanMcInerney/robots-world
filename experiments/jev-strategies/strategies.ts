import { randomUUID } from "node:crypto";
import type { Candidate, Menu } from "../reactive/contract.ts";
import type { Answer } from "../reactive/providers.ts";
import type { Emit } from "../reactive/world.ts";

export const MODEL = "jev-1.13.0";
export const STRATEGIES = {
  "flat-raw": {
    label: "Raw controls",
    description:
      "One Choice over complete maneuvers. Full dated sensors, raw velocity and camera settings; no predicted consequences.",
    seconds: 3,
  },
  "flat-facts": {
    label: "Complete choices + facts",
    description:
      "One Choice over the same complete maneuvers, with measured geometry and full-lifetime predictions.",
    seconds: 3,
  },
  "flat-prose": {
    label: "Plain-language choices",
    description:
      "Same maneuvers and predictions as facts, expressed as sentences. Sensor numbers rounded to millimetres; sparse ranges summarized by each candidate clearance.",
    seconds: 3,
  },
  factorized: {
    label: "Independent movement / camera",
    description:
      "Two parallel Choice questions. Jev chooses a movement and a camera branch independently; code composes that offered bundle.",
    seconds: 3,
  },
  speculative: {
    label: "Speculative camera branches",
    description:
      "One camera Choice plus a movement Choice for each camera branch, all in one request. Execute only the selected branch.",
    seconds: 3,
  },
  sequential: {
    label: "Movement, then camera",
    description:
      "Jev chooses movement, then a second request chooses its camera using that decision and the ORIGINAL sensor snapshot. World runs through both calls.",
    seconds: 3,
  },
  "score-shortlist": {
    label: "Jev scores, then chooses",
    description:
      "Jev scores every offered movement for viewing-position progress. A second Jev Choice weighs all four camera variants of the six highest-scored movements. Code ranks only model scores.",
    seconds: 3,
  },
  "short-lease": {
    label: "One-second maneuvers",
    description:
      "Complete Choice + facts with a one-second command/forecast instead of three seconds. Different lifetime changes feasible menu coverage; this is a timing ablation.",
    seconds: 1,
  },
} as const;
export type Strategy = keyof typeof STRATEGIES;
export type Question =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };
export type Request = {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
};
export type Response = {
  model: string;
  answers: Record<string, any>;
  usage?: { input_tokens?: number; output_tokens?: number };
};
export type Transport = (
  request: Request,
  signal: AbortSignal,
) => Promise<Response>;
export const INSTRUCTIONS = `Pilot a stabilized camera drone using the CURRENT English goal in state.goal. ENU metres: x east, y north, z up; heading 0 east, +90 north; pitch negative down. Each maneuver sets world velocity and absolute camera angles once, for its declared lifetime; newer commands replace it. A local servo stabilizes only. No automatic following, aiming, route selection or obstacle avoidance exists. Physics, sensors, radio and moving objects keep running during all API calls. Command expiry brakes into local hold. Use dated received measurements; target broadcasts may be delayed or absent. Predictions use constant-velocity extrapolation and are uncertain when targets turn. Sparse range returns do not establish free space. A predicted image projection does not prove line of sight. The goal's left/right/ahead/behind refer to the rover heading, not the camera. Judge the offered alternatives from this evidence. Observations cannot reveal the future. Option fields: after is the predicted rover-relative position after the command lifetime; rangeM is distance to rover; clearanceM is minimum predicted distance to observed range points, not obstacle-free certification; image is [horizontal u, vertical v, inFrame], with image edges at -1 and +1. cameraDeg is absolute heading, pitch and horizontal FOV in degrees. All options use the commandSeconds in state.representation.`;
export const CHOOSE =
  "Choose the offered maneuver that best advances the current requested viewing position while avoiding observed collision risk and retaining useful camera framing. If the desired view is not yet reached, choose progress toward it; do not confuse merely centering the rover with reaching the requested side. Continue adapting rather than assuming one successful view completes the mission.";
const MOVE =
  "Choose the movement that best approaches or maintains the viewing position requested by state.goal, respecting observed collision risk. Camera variants describe the same movement; a separate Jev question chooses the camera. Do not choose a movement merely because it keeps the rover centered from the wrong side.";
const CAMERA =
  "Choose the camera branch that best keeps or reacquires the rover in frame from the observed situation. This selects absolute camera settings once; it does not start an automatic tracker.";
const question = (
  instructions: string,
  criteria: Record<string, unknown>,
): Question => ({
  type: "choice",
  instructions: `${INSTRUCTIONS} ${instructions}`,
  criteria,
});
const round = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "number" && Number.isFinite(v)
        ? Math.round(v * 1000) / 1000
        : v,
    ),
  );

export function presentedState(menu: Menu, compact = false) {
  const state = structuredClone(menu.state) as any;
  // Keep every return, at millimetre precision; retain exact timestamps and the raw snapshot in the trace.
  state.ranges.value = round(state.ranges.value);
  state.ranges.presentation =
    "Range coordinates quantized to 0.001m; every received return retained. Original sensor snapshot is logged separately.";
  if (compact) {
    state.ranges = {
      acquiredMs: state.ranges.acquiredMs,
      receivedMs: state.ranges.receivedMs,
      valid: state.ranges.valid,
      representation:
        "Raw points omitted; each candidate retains its minimum distance to observed points along the predicted path. This loses spatial detail.",
      rayCount: state.ranges.value.rayCount,
      maxRange: state.ranges.value.maxRange,
    };
    return round(state);
  }
  return state;
}
export function criteria(menu: Menu, strategy: Strategy) {
  return Object.fromEntries(
    menu.candidates.map((c) => {
      const { x, y, z, heading, pitch, hfov } = c.action;
      const control = {
        velocityENU: [x, y, z],
        cameraDeg: [heading, pitch, hfov],
      };
      const projection = c.facts.projectedCentre as any;
      const estimate = {
        after: c.facts.roverRelative,
        rangeM: c.facts.rangeM,
        clearanceM: c.facts.nearestObservedReturnM,
        image: projection
          ? [projection.u, projection.v, projection.inFrame]
          : null,
      };
      return [
        c.id,
        strategy === "flat-raw"
          ? control
          : strategy === "flat-prose"
            ? `Velocity ENU ${x},${y},${z}; camera heading/pitch/FOV ${heading},${pitch},${hfov}. After command: ${estimate.after}; rover range ${estimate.rangeM ?? "unknown"}m; closest observed return ${estimate.clearanceM ?? "unknown"}m; predicted image u,v,in-frame ${JSON.stringify(estimate.image)}.`
            : { ...control, ...estimate },
      ];
    }),
  );
}
function movementOptions(menu: Menu) {
  const groups = new Map<string, Candidate[]>();
  for (const c of menu.candidates) {
    const id = c.id.split("c")[0]!;
    groups.set(id, [...(groups.get(id) ?? []), c]);
  }
  return Object.fromEntries(
    [...groups].map(([id, cs]) => [
      id,
      {
        movement: cs[0]!.motion,
        velocity: [cs[0]!.action.x, cs[0]!.action.y, cs[0]!.action.z],
        estimate: cs[0]!.facts,
        cameraVariants: cs.map((c) => ({
          id: c.id,
          camera: c.camera,
          projectedCentre: c.facts.projectedCentre,
        })),
      },
    ]),
  );
}
function cameraOptions(menu: Menu) {
  return Object.fromEntries(
    [0, 1, 2, 3].map((i) => [
      `c${i}`,
      menu.candidates.find((c) => c.id.endsWith(`c${i}`))!.camera,
    ]),
  );
}

/** No truth, mission oracle, ranking or route generator enters this request builder. */
export function firstRequest(menu: Menu, strategy: Strategy): Request {
  if (!menu.candidates.length) throw new Error("Empty menu");
  const state = presentedState(menu, strategy === "flat-prose"),
    options = criteria(menu, strategy);
  if (strategy === "flat-raw") delete (state as any).measuredCurrentGeometry;
  let questions: Record<string, Question>;
  if (strategy === "factorized")
    questions = {
      movement: question(MOVE, movementOptions(menu)),
      camera: question(CAMERA, cameraOptions(menu)),
    };
  else if (strategy === "sequential")
    questions = { movement: question(MOVE, movementOptions(menu)) };
  else if (strategy === "speculative") {
    questions = { camera: question(CAMERA, cameraOptions(menu)) };
    for (let i = 0; i < 4; i++)
      questions[`movement_c${i}`] = question(
        `${CHOOSE} Assume camera branch c${i}: ${cameraOptions(menu)[`c${i}`]}. Only this branch executes if the separate camera Choice selects it.`,
        Object.fromEntries(
          menu.candidates
            .filter((c) => c.id.endsWith(`c${i}`))
            .map((c) => [c.id, options[c.id]]),
        ),
      );
  } else if (strategy === "score-shortlist")
    questions = Object.fromEntries(
      menu.candidates
        .filter((c) => c.id.endsWith("c0"))
        .map((c) => [
          c.id.split("c")[0]!,
          {
            type: "score",
            instructions: {
              question:
                "How does THIS candidate affect progress toward the viewing position requested by state.goal? Judge the side and range from the candidate estimates. This question is only about viewing-position progress; another Jev Choice will consider hazards and camera framing.",
              candidate: {
                velocityENU: [c.action.x, c.action.y, c.action.z],
                after: c.facts.roverRelative,
                rangeM: c.facts.rangeM,
                currentGeometry: (state as any).measuredCurrentGeometry,
              },
            },
            criteria: [
              "Moves away from the requested viewing position or abandons it",
              "Makes little useful progress toward the requested viewing position",
              "Makes useful progress toward the requested viewing position",
              "Reaches or maintains the requested viewing position",
            ],
          } satisfies Question,
        ]),
    );
  else questions = { maneuver: question(CHOOSE, options) };
  return { model: MODEL, state, questions };
}
export function distribution(answer: any, ids: string[]) {
  const p = answer?.probabilities;
  if (
    !p ||
    Object.keys(p).length !== ids.length ||
    ids.some((id) => !Object.hasOwn(p, id)) ||
    Object.values(p).some(
      (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
    )
  )
    throw new Error("Invalid probability distribution");
  const values = Object.values(p) as number[],
    sum = values.reduce((a, b) => a + b, 0);
  const tolerance = values.every(
    (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
  )
    ? Math.min(0.06, values.filter((v) => v > 0).length * 0.005 + 1e-6)
    : 1e-6;
  if (
    Math.abs(sum - 1) > tolerance ||
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1
  )
    throw new Error("Invalid probability sum/confidence");
  return p as Record<string, number>;
}
export function choice(body: Response, name: string, ids: string[]) {
  const answer = body.answers[name],
    p = distribution(answer, ids);
  if (
    answer.type !== "choice" ||
    !ids.includes(answer.choice) ||
    p[answer.choice]! <
      Math.max(...Object.values(p)) -
        (Object.values(p).every(
          (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
        )
          ? 0.01000001
          : 1e-8)
  )
    throw new Error(`Invalid choice ${name}`);
  return answer.choice as string;
}
export async function judge(
  menu: Menu,
  strategy: Strategy,
  key: string,
  emit: Emit,
  signal: AbortSignal,
  transport?: Transport,
): Promise<Answer> {
  const started = performance.now(),
    decisionId = randomUUID();
  let usage = { input_tokens: 0, output_tokens: 0 },
    calls = 0;
  const invoke = async (request: Request, stage: string) => {
    signal.throwIfAborted();
    const id = randomUUID(),
      at = performance.now();
    calls++;
    emit("strategy.request", {
      id,
      decisionId,
      strategy,
      stage,
      source: menu.source,
      menuHash: menu.hash,
      request,
    });
    let body: Response;
    if (transport) body = await transport(request, signal);
    else {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 524288) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(part.value);
      }
      const raw = Buffer.concat(chunks)
        .toString("utf8")
        .split(key)
        .join("[redacted]");
      if (!response.ok) {
        emit("strategy.http-error", {
          id,
          decisionId,
          stage,
          status: response.status,
          raw,
          latencyMs: performance.now() - at,
        });
        throw new Error(`Jev HTTP ${response.status}`);
      }
      body = JSON.parse(raw);
    }
    emit("strategy.response", {
      id,
      decisionId,
      strategy,
      stage,
      body,
      latencyMs: performance.now() - at,
    });
    if (body.model !== MODEL) throw new Error("Unexpected Jev model");
    usage.input_tokens += body.usage?.input_tokens ?? 0;
    usage.output_tokens += body.usage?.output_tokens ?? 0;
    signal.throwIfAborted();
    return body;
  };
  const request = firstRequest(menu, strategy),
    body = await invoke(request, "initial");
  let id: string;
  if (strategy === "factorized")
    id = `${choice(body, "movement", Object.keys((request.questions.movement as any).criteria))}${choice(body, "camera", ["c0", "c1", "c2", "c3"])}`;
  else if (strategy === "speculative") {
    const camera = choice(body, "camera", ["c0", "c1", "c2", "c3"]);
    id = choice(
      body,
      `movement_${camera}`,
      menu.candidates.filter((c) => c.id.endsWith(camera)).map((c) => c.id),
    );
  } else if (strategy === "sequential") {
    const movement = choice(
        body,
        "movement",
        Object.keys((request.questions.movement as any).criteria),
      ),
      cs = menu.candidates.filter((c) => c.id.split("c")[0] === movement);
    const next: Request = {
      model: MODEL,
      state: { ...(request.state as object), selectedMovement: movement },
      questions: {
        maneuver: question(
          `${CAMERA} The movement has already been selected. Choose one of its complete movement/camera bundles.`,
          Object.fromEntries(
            cs.map((c) => [c.id, criteria(menu, "flat-facts")[c.id]]),
          ),
        ),
      },
    };
    id = choice(
      await invoke(next, "camera-after-movement"),
      "maneuver",
      cs.map((c) => c.id),
    );
  } else if (strategy === "score-shortlist") {
    const scores = menu.candidates
      .filter((c) => c.id.endsWith("c0"))
      .map((c) => {
        const id = c.id.split("c")[0]!,
          a = body.answers[id];
        distribution(a, ["0", "1", "2", "3"]);
        if (
          a.type !== "score" ||
          !Number.isFinite(a.score) ||
          a.score < 0 ||
          a.score > 3
        )
          throw new Error("Invalid score");
        return { id, score: a.score };
      });
    scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const shortlist = scores.slice(0, 6);
    emit("strategy.shortlist", {
      decisionId,
      source: menu.source,
      scores,
      selected: shortlist.map((c) => c.id),
      rule: "Top six movement scores from Jev, all four camera variants retained; stable lexical ID tie break. No code-written mission reward.",
    });
    const offered = menu.candidates.filter((c) =>
      shortlist.some((s) => s.id === c.id.split("c")[0]),
    );
    const next: Request = {
      model: MODEL,
      state: request.state,
      questions: {
        maneuver: question(
          CHOOSE,
          Object.fromEntries(
            offered.map((c) => [c.id, criteria(menu, "flat-facts")[c.id]]),
          ),
        ),
      },
    };
    id = choice(
      await invoke(next, "choose-from-model-shortlist"),
      "maneuver",
      offered.map((c) => c.id),
    );
  } else
    id = choice(
      body,
      "maneuver",
      menu.candidates.map((c) => c.id),
    );
  if (!menu.candidates.some((c) => c.id === id))
    throw new Error("Composed an unoffered maneuver");
  emit("strategy.selection", {
    decisionId,
    strategy,
    source: menu.source,
    choice: id,
    calls,
    latencyMs: performance.now() - started,
    usage,
  });
  return {
    value: { choice: id, decisionId },
    latencyMs: performance.now() - started,
    model: MODEL,
    usage,
  };
}
