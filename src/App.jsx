import { useEffect, useState } from 'react';
import { sb } from './lib/supabase';
import { getSuggestedDay, getTodayPrescription, startSession, logSet, undoSet, logBodyweight, finishSession } from './lib/workouts';

const DAYS = ['push', 'pull', 'legs'];
const e1rm = (w, r) => w * (1 + r / 30);
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const card = 'rounded-3xl bg-white dark:bg-zinc-900 p-4 shadow-sm';
const big = 'h-14 rounded-2xl font-semibold active:scale-95 transition';
const input = 'h-14 w-full rounded-2xl bg-zinc-100 dark:bg-zinc-800 px-3 text-xl text-center outline-none';
const OUT = { weight_up: '⬆️ Weight up', progressed: '✅ Progressed', held: '🔁 Repeat & beat it', deload: '⬇️ Deload 10%', rotate: '🔄 Rotating exercise', calibrated: '📏 Working weight set' };

export default function App() {
  const [user, setUser] = useState(undefined);
  const [dark, setDark] = useState(() => localStorage.getItem('dark') === '1');
  const [view, setView] = useState({ name: 'home' });
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data } = sb.auth.onAuthStateChange((_, s) => setUser(s?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('dark', dark ? '1' : '0'); }, [dark]);
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1rem)]">
      <div className="mx-auto max-w-md">
        {user === undefined ? null : !user ? <Login /> :
          view.name === 'workout' ? <Workout day={view.day} onExit={() => setView({ name: 'home' })} /> :
          view.name === 'prs' ? <PRs onBack={() => setView({ name: 'home' })} /> :
          <Home dark={dark} setDark={setDark} go={setView} />}
      </div>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState('');
  const submit = async (e) => { e.preventDefault(); const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) setErr(error.message); };
  return (
    <form onSubmit={submit} className="pt-24 space-y-3">
      <h1 className="text-3xl font-bold mb-6">Lift Log</h1>
      <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className={input} type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p className="text-red-500 text-sm">{err}</p>}
      <button className={`${big} w-full bg-blue-600 text-white`}>Sign in</button>
    </form>
  );
}

function Home({ dark, setDark, go }) {
  const [suggested, setSuggested] = useState(null), [bw, setBw] = useState(''), [msg, setMsg] = useState('');
  useEffect(() => { getSuggestedDay(sb).then(setSuggested).catch((e) => setMsg(e.message)); }, []);
  const saveBw = async () => { try { await logBodyweight(sb, parseFloat(bw)); setMsg('Bodyweight saved'); setBw(''); } catch (e) { setMsg(e.message); } };
  return (
    <div className="space-y-4 pt-4">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Lift Log</h1>
        <button className="h-11 px-4 rounded-xl bg-zinc-200 dark:bg-zinc-800" onClick={() => setDark(!dark)}>{dark ? '☀️ Light' : '🌙 Dark'}</button>
      </div>
      <p className="text-zinc-500">What are you training today?</p>
      {DAYS.map((d) => (
        <button key={d} onClick={() => go({ name: 'workout', day: d })}
          className={`${big} w-full h-20 text-2xl capitalize ${d === suggested ? 'bg-blue-600 text-white' : 'bg-white dark:bg-zinc-900'}`}>
          {d}{d === suggested && <span className="block text-xs font-normal opacity-80">Suggested</span>}
        </button>
      ))}
      <div className={card}>
        <p className="font-semibold mb-2">Log bodyweight (optional)</p>
        <div className="flex gap-2">
          <input className={input} inputMode="decimal" placeholder="lb" value={bw} onChange={(e) => setBw(e.target.value)} />
          <button className={`${big} px-5 bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900`} onClick={saveBw} disabled={!bw}>Save</button>
        </div>
        {msg && <p className="text-sm text-zinc-500 mt-2">{msg}</p>}
      </div>
      <button className={`${big} w-full bg-white dark:bg-zinc-900`} onClick={() => go({ name: 'prs' })}>🏆 Personal records</button>
      <button className="w-full text-sm text-zinc-500 py-3" onClick={() => sb.auth.signOut()}>Sign out</button>
    </div>
  );
}

function Workout({ day, onExit }) {
  const [sid, setSid] = useState(null), [rx, setRx] = useState(null), [vals, setVals] = useState({}), [skipped, setSkipped] = useState({});
  const [prs, setPrs] = useState({}), [rest, setRest] = useState(null), [now, setNow] = useState(Date.now());
  const [summary, setSummary] = useState(null), [err, setErr] = useState('');
  const key = (p, i) => `${p.slot_id}:${p.exercise.id}:${i}`;

  useEffect(() => {
    (async () => {
      try {
        const [p, id, pr] = await Promise.all([getTodayPrescription(sb, day), startSession(sb, day), sb.from('exercise_prs').select('*')]);
        setRx(p); setSid(id); setPrs(Object.fromEntries((pr.data ?? []).map((r) => [r.exercise_id, r.best_e1rm])));
      } catch (e) { setErr(e.message); }
    })();
  }, [day]);
  useEffect(() => { // keep screen on during workout
    let lock; navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    return () => lock?.release?.();
  }, []);
  useEffect(() => { if (!rest) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [rest]);
  const left = rest ? Math.max(0, Math.ceil((rest - now) / 1000)) : 0;

  async function toggle(p, i) {
    const k = key(p, i), v = vals[k] ?? {};
    const w = parseFloat(v.w ?? p.target_weight ?? (p.exercise.is_bodyweight ? 0 : NaN)), r = parseInt(v.r ?? p.target_reps[i]);
    try {
      if (v.done) { await undoSet(sb, sid, p, i + 1); setVals((x) => ({ ...x, [k]: { ...v, done: false, pr: false } })); return; }
      if (Number.isNaN(w) || !r) return setErr('Enter weight and reps first');
      setErr('');
      await logSet(sb, sid, p, i + 1, { weight: w, reps: r });
      setVals((x) => ({ ...x, [k]: { w, r, done: true, pr: prs[p.exercise.id] != null && e1rm(w, r) > prs[p.exercise.id] } }));
      setNow(Date.now()); setRest(Date.now() + (p.rep_max <= 10 ? 120 : 90) * 1000);
    } catch (e) { setErr(e.message); }
  }
  const swap = (idx, altId) => setRx((list) => list.map((p, j) => {
    if (j !== idx) return p;
    const alt = p.alternatives.find((a) => a.exercise.id === altId), { alternatives, ...old } = p;
    return { ...alt.prescription, alternatives: [...alternatives.filter((a) => a.exercise.id !== altId), { exercise: p.exercise, prescription: old }] };
  }));
  const finish = async () => { try { setSummary(await finishSession(sb, sid)); } catch (e) { setErr(e.message); } };

  if (summary) return (
    <div className="pt-8 space-y-3">
      <h1 className="text-3xl font-bold">Workout saved 💪</h1>
      {summary.length === 0 && <p className="text-zinc-500">No sets were logged.</p>}
      {summary.map((s) => <div key={s.exercise} className={card}><b>{s.exercise}</b><p>{OUT[s.outcome]}{s.rotatedTo ? ` → ${s.rotatedTo} next time` : ''}</p></div>)}
      <button className={`${big} w-full bg-blue-600 text-white`} onClick={onExit}>Done</button>
    </div>
  );
  if (!rx) return <p className="pt-24 text-center text-zinc-500">{err || 'Loading…'}</p>;

  return (
    <div className="space-y-4 pt-4 pb-32">
      <div className="flex justify-between items-center">
        <button className="h-11 px-3 text-blue-600" onClick={onExit}>‹ Back</button>
        <h1 className="text-2xl font-bold capitalize">{day} day</h1><span className="w-16" />
      </div>
      {err && <p className="text-red-500 text-sm">{err}</p>}
      {rx.map((p, idx) => skipped[p.slot_id] ? (
        <button key={p.slot_id} className={`${card} w-full text-left text-zinc-500`} onClick={() => setSkipped((s) => ({ ...s, [p.slot_id]: false }))}>
          Skipped: {p.exercise.name} — tap to restore</button>
      ) : (
        <section key={p.slot_id} className={`${card} space-y-3`}>
          <div className="flex justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold">{p.exercise.name}{p.optional && <span className="text-xs text-zinc-500"> optional</span>}</h2>
              <p className="text-sm text-zinc-500">
                {p.mode === 'calibrate' ? '📏 Find your working weight' : `Target ${p.target_weight} lb${p.exercise.is_bodyweight ? ' added' : ''}`} · {p.rep_min}–{p.rep_max} reps
              </p>
            </div>
            <button className="h-11 px-3 text-sm text-zinc-500" onClick={() => setSkipped((s) => ({ ...s, [p.slot_id]: true }))}>Skip</button>
          </div>
          {Array.from({ length: p.sets }, (_, i) => {
            const v = vals[key(p, i)] ?? {};
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 text-zinc-500">{i + 1}</span>
                <input className={input} inputMode="decimal" placeholder={p.exercise.is_bodyweight ? '+lb' : 'lb'} value={v.w ?? p.target_weight ?? ''}
                  onChange={(e) => setVals((x) => ({ ...x, [key(p, i)]: { ...v, w: e.target.value } }))} />
                <input className={input} inputMode="numeric" placeholder="reps" value={v.r ?? p.target_reps[i]}
                  onChange={(e) => setVals((x) => ({ ...x, [key(p, i)]: { ...v, r: e.target.value } }))} />
                <button className={`${big} w-16 shrink-0 ${v.done ? 'bg-green-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`} onClick={() => toggle(p, i)}>{v.done ? (v.pr ? '🏆' : '✓') : '○'}</button>
              </div>
            );
          })}
          {p.alternatives.length > 0 && (
            <select className="h-12 w-full rounded-xl bg-zinc-100 dark:bg-zinc-800 px-3 text-sm" value="" onChange={(e) => swap(idx, e.target.value)}>
              <option value="">Swap exercise…</option>
              {p.alternatives.map((a) => <option key={a.exercise.id} value={a.exercise.id}>{a.exercise.name}</option>)}
            </select>
          )}
        </section>
      ))}
      <button className={`${big} w-full h-16 text-lg bg-blue-600 text-white`} onClick={finish}>Finish workout</button>
      {left > 0 && (
        <div className="fixed inset-x-0 bottom-0 bg-zinc-900 text-white px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] flex items-center justify-between">
          <span className="text-3xl font-mono">{fmt(left)}</span>
          <div className="flex gap-2">
            <button className="h-12 px-4 rounded-xl bg-zinc-700" onClick={() => setRest((r) => r + 30000)}>+30s</button>
            <button className="h-12 px-4 rounded-xl bg-zinc-700" onClick={() => setRest(null)}>Skip</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PRs({ onBack }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    (async () => {
      const [{ data: prs }, { data: ex }] = await Promise.all([sb.from('exercise_prs').select('*'), sb.from('exercises').select('id,name')]);
      const name = Object.fromEntries((ex ?? []).map((e) => [e.id, e.name]));
      setRows((prs ?? []).map((r) => ({ ...r, name: name[r.exercise_id] })).sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, []);
  return (
    <div className="pt-4 space-y-3">
      <button className="h-11 px-3 text-blue-600" onClick={onBack}>‹ Back</button>
      <h1 className="text-3xl font-bold">Personal records</h1>
      {rows?.length === 0 && <p className="text-zinc-500">Log a workout to see PRs here.</p>}
      {rows?.map((r) => (
        <div key={r.exercise_id} className={`${card} flex justify-between`}>
          <b>{r.name}</b><span className="text-zinc-500">{r.best_weight} lb · e1RM {Math.round(r.best_e1rm)}</span>
        </div>
      ))}
    </div>
  );
}
