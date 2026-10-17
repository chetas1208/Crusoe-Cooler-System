/**
 * Headless run of the mock engine: prints the incident lifecycle as it happens.
 *   pnpm sim -- [seed] [simSeconds] [fault:kind[:target]]
 */
import { Engine } from '../engine/engine';

const seed = Number(process.argv[2] ?? 1);
const secs = Number(process.argv[3] ?? 1500);
const forced = process.argv[4];
const eng = new Engine({ seed, speed: 6, faultsEnabled: !forced });
if (forced) {
  const [, kind, target] = forced.split(':');
  eng.faults.begin(kind as never, target);
}
const t = () => `${eng.plant.time.toFixed(0).padStart(5)}s`;
eng.subscribe((e) => {
  switch (e.type) {
    case 'incident.opened':
      console.log(`${t()} ▶ ${e.payload.incident.id} OPENED [${e.payload.incident.severity}] ${e.payload.incident.title}`);
      break;
    case 'incident.updated': {
      const i = e.payload.incident;
      const k = `${i.status}|${i.stage}|${i.severity}`;
      if ((eng as any)._last?.[i.id] !== k) {
        ((eng as any)._last ??= {})[i.id] = k;
        console.log(`${t()}   ${i.id} → ${i.status} / ${i.stage} / ${i.severity} — ${i.summary.slice(0, 110)}`);
      }
      break;
    }
    case 'incident.closed':
      console.log(`${t()} ■ ${e.payload.incident.id} ${e.payload.incident.status.toUpperCase()}: ${e.payload.incident.close_reason}`);
      break;
    case 'agent.task':
      if (e.payload.task.status !== 'working') console.log(`${t()}     [${e.payload.task.role.padEnd(8)}] ${e.payload.task.title} — ${e.payload.task.status}${e.payload.task.outcome ? ` (${e.payload.task.outcome.label})` : ''}`);
      break;
    case 'verification.result':
      if (e.payload.verification.status !== 'pending') console.log(`${t()}   ✔ verification ${e.payload.verification.status}: ${e.payload.verification.checks.map((c) => `${c.label} ${c.after.toFixed(2)}${c.pass ? '✓' : '✗'}`).join(', ')}`);
      break;
    case 'mission.transition': {
      const m = e.payload.mission;
      const k = `${m.id}|${m.steps.map((s) => s.status[0]).join('')}`;
      if ((eng as any)._m?.[m.id] !== k) {
        ((eng as any)._m ??= {})[m.id] = k;
        const active = m.steps.find((s) => s.status === 'active');
        if (active) console.log(`${t()}       ${m.robot_id} ${m.id} · ${active.label}`);
      }
      break;
    }
  }
});
const t0 = Date.now();
eng.fastForward(secs);
const snap = eng.snapshot();
console.log(`\nran ${secs}s sim in ${Date.now() - t0} ms · incidents=${snap.incidents.length} · min margin ${snap.kpis.min_margin_k.toFixed(1)} K · events=${snap.last_seq}`);
