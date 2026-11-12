// Supabase client functions. Pass in your supabase-js client as `sb`.
import { calibrate, evaluate, pickRotation, prescribeFor } from './progression.js';

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };
const uid = async (sb) => (await sb.auth.getUser()).data.user.id;

/** Day trained longest ago (never-trained first, in push/pull/legs order). */
export async function getSuggestedDay(sb) {
  const rows = await q(sb.from('workout_sessions').select('day_type,finished_at').not('finished_at', 'is', null));
  const last = {};
  for (const r of rows) if (!last[r.day_type] || r.finished_at > last[r.day_type]) last[r.day_type] = r.finished_at;
  return ['push', 'pull', 'legs']
    .map((d, i) => ({ d, i, t: last[d] ? Date.parse(last[d]) : -Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i)[0].d;
}

/** Most recent finished session for a day type, with its sets. */
export async function getLastWorkout(sb, dayType) {
  const [s] = await q(sb.from('workout_sessions').select('*, set_logs(*)').eq('day_type', dayType)
    .not('finished_at', 'is', null).order('finished_at', { ascending: false }).limit(1));
  return s ?? null;
}

/** Sets from the last session that included this exercise (for "last time" display / prefill). */
export async function getLastSets(sb, exerciseId) {
  const rows = await q(sb.from('set_logs').select('*').eq('exercise_id', exerciseId).eq('skipped', false)
    .order('completed_at', { ascending: false }).limit(15));
  if (!rows.length) return [];
  return rows.filter((r) => r.session_id === rows[0].session_id).sort((a, b) => a.set_number - b.set_number);
}

/** Today's prescription: one entry per slot, plus swap options from the same pool. */
export async function getTodayPrescription(sb, dayType) {
  const slots = await q(sb.from('program_slots').select('*').eq('day_type', dayType).order('position'));
  const exercises = await q(sb.from('exercises').select('*').in('pool', [...new Set(slots.map((s) => s.pool))]).order('sort_order'));
  const slotState = await q(sb.from('slot_state').select('*').in('slot_id', slots.map((s) => s.id)));
  const exState = await q(sb.from('exercise_state').select('*').in('exercise_id', exercises.map((e) => e.id)));
  return slots.map((slot) => {
    const options = exercises.filter((e) => e.pool === slot.pool);
    const currentId = slotState.find((s) => s.slot_id === slot.id)?.exercise_id ?? options[0].id;
    const ex = options.find((e) => e.id === currentId);
    return { ...prescribeFor(slot, ex, exState.find((s) => s.exercise_id === ex.id)),
      alternatives: options.filter((e) => e.id !== ex.id).map((e) => ({ exercise: e, prescription: prescribeFor(slot, e, exState.find((s) => s.exercise_id === e.id)) })) };
  });
}

export async function startSession(sb, dayType) {
  return (await q(sb.from('workout_sessions').insert({ day_type: dayType }).select().single())).id;
}

/** Log or edit a set (upsert). Skipping an exercise = just log nothing for it. */
export async function logSet(sb, sessionId, p, setNumber, actual) {
  return q(sb.from('set_logs').upsert({
    user_id: await uid(sb), session_id: sessionId, slot_id: p.slot_id, exercise_id: p.exercise.id, set_number: setNumber,
    target_weight: p.target_weight, target_reps: p.target_reps[setNumber - 1],
    actual_weight: actual.weight, actual_reps: actual.reps, notes: actual.notes ?? null,
  }, { onConflict: 'session_id,slot_id,exercise_id,set_number' }));
}

export const undoSet = (sb, sessionId, p, setNumber) =>
  q(sb.from('set_logs').delete().match({ session_id: sessionId, slot_id: p.slot_id, exercise_id: p.exercise.id, set_number: setNumber }));

export async function logBodyweight(sb, weight, date = new Date().toISOString().slice(0, 10)) {
  return q(sb.from('body_weight_logs').upsert({ user_id: await uid(sb), logged_on: date, weight }, { onConflict: 'user_id,logged_on' }));
}

/** Close the session, run the progression engine per exercise, write new state, rotate if needed. */
export async function finishSession(sb, sessionId) {
  const user = await uid(sb);
  const logs = await q(sb.from('set_logs').select('*').eq('session_id', sessionId).eq('skipped', false).order('set_number'));
  const slots = await q(sb.from('program_slots').select('*').in('id', [...new Set(logs.map((l) => l.slot_id))]));
  const exercises = await q(sb.from('exercises').select('*'));
  const states = await q(sb.from('exercise_state').select('*').in('exercise_id', [...new Set(logs.map((l) => l.exercise_id))]));
  const slotStates = await q(sb.from('slot_state').select('*').in('slot_id', slots.map((s) => s.id)));

  const groups = new Map();
  for (const l of logs) {
    const k = `${l.slot_id}|${l.exercise_id}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const summary = [];
  for (const [, rows] of groups) {
    const slot = slots.find((s) => s.id === rows[0].slot_id);
    const ex = exercises.find((e) => e.id === rows[0].exercise_id);
    const st = states.find((s) => s.exercise_id === ex.id);
    const logged = []; rows.forEach((r) => { logged[r.set_number - 1] = { weight: r.actual_weight, reps: r.actual_reps }; });
    const res = !st || st.status === 'calibrating' ? calibrate(slot, ex, logged) : evaluate(st, slot, ex, logged);
    if (!res) continue;
    const progressed = ['progressed', 'weight_up', 'calibrated'].includes(res.outcome);
    await q(sb.from('exercise_state').upsert({
      ...res.state, user_id: user, exercise_id: ex.id, updated_at: new Date().toISOString(),
      ...(progressed ? { last_progressed_at: new Date().toISOString() } : {}),
      ...(res.outcome === 'rotate' ? { stall_count: 0 } : {}), // fresh start if you rotate back later
    }, { onConflict: 'user_id,exercise_id' }));

    const isCurrent = (slotStates.find((s) => s.slot_id === slot.id)?.exercise_id ?? null) === ex.id
      || (!slotStates.some((s) => s.slot_id === slot.id) && ex.id === exercises.filter((e) => e.pool === slot.pool).sort((a, b) => a.sort_order - b.sort_order)[0].id);
    if (res.outcome === 'rotate' && isCurrent) {
      const options = exercises.filter((e) => e.pool === slot.pool && (e.user_id === null || e.user_id === user));
      const used = await q(sb.from('set_logs').select('exercise_id,completed_at').in('exercise_id', options.map((e) => e.id)).order('completed_at', { ascending: false }));
      const lastUsed = {}; used.forEach((u) => { lastUsed[u.exercise_id] ??= u.completed_at; });
      const next = pickRotation(options, ex.id, lastUsed);
      if (next) await q(sb.from('slot_state').upsert({ user_id: user, slot_id: slot.id, exercise_id: next.id }, { onConflict: 'user_id,slot_id' }));
      summary.push({ exercise: ex.name, outcome: 'rotate', rotatedTo: next?.name });
    } else summary.push({ exercise: ex.name, outcome: res.outcome });
  }
  await q(sb.from('workout_sessions').update({ finished_at: new Date().toISOString() }).eq('id', sessionId));
  return summary;
}
