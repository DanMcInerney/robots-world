/** Reversible text views. The evaluator manifest is never part of a request. */
export type FactValue = string | number | boolean | null | number[] | string[];
export type Facts = Record<string, FactValue>;
export const FORMATS = ['numeric', 'rows', 'prose', 'nested'] as const;
export type Format = typeof FORMATS[number];

export function encodeFacts(facts: Facts, format: Format): unknown {
  const entries = Object.entries(facts);
  if (format === 'numeric') return {fields: {...facts}};
  if (format === 'rows') return ['field | value (JSON notation)', ...entries.map(([k, v]) => `${k} | ${JSON.stringify(v)}`)].join('\n');
  if (format === 'prose') return entries.map(([k, v]) => `The ${k.replaceAll('_', ' ')} value is ${JSON.stringify(v)}.`).join('\n');
  const records = Object.fromEntries(entries.map(([field, value], i) => [`record-${i + 1}`, {field, value}]));
  return {readInOrder: Object.keys(records), records};
}

export function decodeFacts(value: unknown, format: Format): Facts {
  if (format === 'numeric') return {...(value as {fields: Facts}).fields};
  if (format === 'nested') {
    const v = value as {readInOrder: string[]; records: Record<string, {field: string; value: FactValue}>};
    return Object.fromEntries(v.readInOrder.map(id => [v.records[id]!.field, v.records[id]!.value]));
  }
  return Object.fromEntries(String(value).split('\n').slice(format === 'rows' ? 1 : 0).map(line => {
    if (format === 'rows') {
      const split = line.indexOf(' | ');
      if (split < 1) throw new Error('Malformed fact row');
      return [line.slice(0, split), JSON.parse(line.slice(split + 3))];
    }
    const match = /^The (.+) value is (.+)\.$/.exec(line);
    if (!match) throw new Error('Malformed fact sentence');
    return [match[1]!.replaceAll(' ', '_'), JSON.parse(match[2]!)];
  }));
}

export function canonicalManifest(facts: Facts): string {
  return JSON.stringify(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b)));
}

export const YAW = {left_30: 30, left_10: 10, left_3: 3, retain: 0, right_3: -3, right_10: -10, right_30: -30} as const;
export const YAW_CRITERIA = Object.fromEntries(Object.entries(YAW).map(([key, deg]) => [key,
  deg === 0 ? 'Retain the accepted heading setpoint. An unfinished turn continues.' : `Set heading to acquired heading plus ${deg} degrees (${Math.abs(deg)} degrees ${deg > 0 ? 'left' : 'right'}).`,
]));
export const FORECAST_CRITERIA = {
  left: 'Detected, with angular center strictly left of -5 degrees.',
  center: 'Detected, with angular center in [-5, 5] degrees inclusive.',
  right: 'Detected, with angular center strictly right of +5 degrees.',
  absent: 'No detection under the stated full-rectangle detection rule.',
  abstain: 'Evidence permits more than one physical outcome, or needed evidence is missing; abstain.',
};

/** Independent geometry oracle: bearing is positive image-right; positive yaw turns left. */
export function yawOutcomes(bearing: readonly [number, number], yaw: number, drift: readonly [number, number], halfWidth = 1): string[] {
  const lo = bearing[0] + yaw + drift[0], hi = bearing[1] + yaw + drift[1];
  const out: string[] = [];
  if (lo < -35 + halfWidth || hi > 35 - halfWidth) out.push('absent');
  const visibleLo = Math.max(lo, -35 + halfWidth), visibleHi = Math.min(hi, 35 - halfWidth);
  if (visibleLo <= visibleHi) {
    if (visibleLo < -5) out.push('left');
    if (visibleLo <= 5 && visibleHi >= -5) out.push('center');
    if (visibleHi > 5) out.push('right');
  }
  return out;
}

/** A command is admissible in this diagnostic if optimal for some allowed future bearing. */
export function plausibleYawActions(bearing: number, drift: readonly [number, number]): string[] {
  const entries = Object.entries(YAW), candidates = [bearing + drift[0], bearing + drift[1]];
  for (const [, a] of entries) for (const [, b] of entries) {
    const boundary = -(a + b) / 2;
    if (boundary >= candidates[0]! && boundary <= candidates[1]!) candidates.push(boundary);
  }
  return entries.filter(([, yaw]) => candidates.some(x => {
    const best = Math.min(...entries.map(([, other]) => Math.abs(x + other)));
    return Math.abs(x + yaw) <= best + 1e-9;
  })).map(([key]) => key);
}

export function rotateOldPoint(forward: number, right: number, measuredLeftYaw: number): [number, number] {
  const radians = measuredLeftYaw * Math.PI / 180;
  const clean = (v: number) => Math.abs(v) < 1e-8 ? 0 : Math.round(v * 1e8) / 1e8;
  return [clean(Math.cos(radians) * forward - Math.sin(radians) * right), clean(Math.sin(radians) * forward + Math.cos(radians) * right)];
}
