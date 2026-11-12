// Pure progression engine (no network). Double progression with a stall ladder:
//   all sets at rep_max        -> weight up, reps reset to rep_min
//   all sets >= rep_min and total reps beat last time -> same weight, +1 rep per set
//   otherwise (stall):  1st -> repeat and try to beat it
//                       2nd -> deload ~10%
//                       3rd -> rotate to another exercise in the pool
export const MAX_STALLS = 3;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const roundTo = (x, step) => Math.round(x / step) * step;
const fill = (n, v) => Array(n).fill(v);
const bump = (reps, slot) => reps.map((r) => clamp(r + 1, slot.rep_min, slot.rep_max));

/** What to show for a slot today. st = exercise_state row or undefined. */
export function prescribeFor(slot, exercise, st) {
  const calibrating = !st || st.status === 'calibrating';
  return {
    slot_id: slot.id, exercise, mode: calibrating ? 'calibrate' : 'train',
    sets: slot.sets, rep_min: slot.rep_min, rep_max: slot.rep_max, optional: slot.optional,
    target_weight: calibrating ? null : st.current_weight,
    target_reps: calibrating ? fill(slot.sets, slot.rep_min) : st.target_reps,
  };
}

/** logged = [{weight, reps}] indexed by set (missing/0 reps = not done). */
export function evaluate(state, slot, ex, logged) {
  const reps = Array.from({ length: slot.sets }, (_, i) => (logged[i]?.reps > 0 ? logged[i].reps : 0));
  const lastDone = [...logged].reverse().find((s) => s?.reps > 0);
  const weight = lastDone?.weight ?? state.current_weight;
  const total = sum(reps);
  const prior = state.last_weight === weight ? state.last_total_reps ?? 0 : 0;
  const base = { ...state, status: 'active', current_weight: weight, last_weight: weight, last_total_reps: total };

  if (reps.every((r) => r >= slot.rep_max))
    return { outcome: 'weight_up', state: { ...base, current_weight: weight + ex.increment, target_reps: fill(slot.sets, slot.rep_min), stall_count: 0 } };

  if (Math.min(...reps) >= slot.rep_min && total > prior)
    return { outcome: 'progressed', state: { ...base, target_reps: bump(reps, slot), stall_count: 0 } };

  const stall = (state.stall_count ?? 0) + 1;
  if (stall >= MAX_STALLS)
    return { outcome: 'rotate', state: { ...base, target_reps: bump(reps, slot), stall_count: stall } };
  if (stall === 2)
    return { outcome: 'deload', state: { ...base, current_weight: Math.max(0, roundTo(weight * 0.9, ex.increment)), target_reps: fill(slot.sets, slot.rep_min), stall_count: stall } };
  return { outcome: 'held', state: { ...base, target_reps: bump(reps, slot), stall_count: stall } };
}

/** First session of an exercise: whatever you lifted becomes the working weight. */
export function calibrate(slot, ex, logged) {
  const done = logged.filter((s) => s?.reps > 0);
  if (!done.length) return null; // nothing logged: stay in calibration
  const weight = done[done.length - 1].weight ?? 0;
  const atW = logged.map((s) => (s?.weight === weight ? s : { weight, reps: 0 }));
  const r = evaluate({ current_weight: weight, stall_count: 0, last_total_reps: 0, last_weight: null }, slot, ex, atW);
  return { outcome: 'calibrated', state: { ...r.state, stall_count: 0 } };
}

/** Pick the next exercise in a pool: never-used first, then least recently used. */
export function pickRotation(options, currentId, lastUsed /* {exerciseId: ISO date} */) {
  return options
    .filter((e) => e.id !== currentId)
    .sort((a, b) => (lastUsed[a.id] ? Date.parse(lastUsed[a.id]) : -Infinity) - (lastUsed[b.id] ? Date.parse(lastUsed[b.id]) : -Infinity) || a.sort_order - b.sort_order)[0];
}
