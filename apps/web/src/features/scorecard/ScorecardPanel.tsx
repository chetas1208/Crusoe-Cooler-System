import { useEffect, useState } from 'react';
import { apiFetch } from '../../tabs/execution/api';
import { fmtCi, fmtRate, parseScorecard, type Scorecard } from './schema';
import './scorecard.css';

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error'; message: string } | { state: 'ready'; card: Scorecard };

const usd = (v: number | null) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
const secs = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)} s`);

/** Read-only view of the frozen V11 evaluation. It never runs anything and never rewrites a status. */
export function ScorecardPanel({ onClose, inSheet = false }: { onClose: () => void; inSheet?: boolean }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const r = await apiFetch('/eval/scorecard', { headers: { Accept: 'application/json' } });
        if (off) return;
        if (r.status === 404) return setLoad({ state: 'missing' });
        if (!r.ok) return setLoad({ state: 'error', message: `HTTP ${r.status}` });
        const card = parseScorecard(await r.json());
        setLoad(card ? { state: 'ready', card } : { state: 'error', message: 'unexpected scorecard shape' });
      } catch (e) {
        if (!off) setLoad({ state: 'error', message: (e as Error).message });
      }
    })();
    return () => { off = true; };
  }, []);
  return (
    <aside className="sc-panel" data-sheet={inSheet || undefined} aria-label="Evaluation scorecard">
      <header>
        <h2>Evaluation scorecard</h2>
        <span className="sc-grow" />
        <button type="button" className="dd-x" onClick={onClose} aria-label="Hide scorecard">×</button>
      </header>
      {load.state === 'loading' && <p className="dd-empty">Loading…</p>}
      {load.state === 'missing' && <p className="dd-empty">The evaluation runner has not been run on this backend (no scorecard artifact).</p>}
      {load.state === 'error' && <p className="dd-empty" role="alert">Could not load the scorecard ({load.message}).</p>}
      {load.state === 'ready' && <Body card={load.card} />}
    </aside>
  );
}

function Body({ card }: { card: Scorecard }) {
  return (
    <>
      <p className="sc-meta mono">{card.schema} · {card.n_scenarios} scenarios × {card.n_seeds} seeds · {card.generated_at} · manifest {card.manifest_sha256.slice(0, 12)}</p>
      <p className="sc-caveat" role="note">
        Effective sample is about {card.n_scenarios ?? '?'} scenarios (seeds vary the same scenarios), so confidence intervals are wide. The scored arms are baselines and a single-pass model; the single-pass arm is not the proposed system.
      </p>
      <div className="sc-scroll">
        <table className="sc-table">
          <thead>
            <tr><th>Arm</th><th>Verified completion</th><th>False success</th><th>Containment (median / p90)</th><th>Cost</th><th>Trace coverage</th></tr>
          </thead>
          <tbody>
            {card.arms.map((a) => (
              <tr key={a.arm}>
                <th scope="row">{a.arm.replace(/_/g, ' ')}<small>{a.n_runs} runs{a.n_errors ? ` · ${a.n_errors} errors` : ''}</small></th>
                <td>{fmtRate(a.verified)}<small>{fmtCi(a.verified.ci95)}</small><small>plant recovered at end {a.plantRecovered.k}/{a.plantRecovered.n}</small></td>
                <td>{a.falseSuccess.k}/{a.falseSuccess.n_claims} of claims<small>{a.falseSuccess.n_claims === 0 ? 'no claim made' : fmtCi(a.falseSuccess.ci95)}</small></td>
                <td>{secs(a.containment.median)} / {secs(a.containment.p90)}<small>n {a.containment.n}</small></td>
                <td>{usd(a.costTotal)}<small>per verified {usd(a.costPerVerified)}</small></td>
                <td>{a.trace.rate === null ? 'n/a' : `${(a.trace.rate * 100).toFixed(0)}%`}<small>{a.trace.traced}/{a.trace.total} actions</small></td>
              </tr>
            ))}
            <tr className="sc-recursive">
              <th scope="row">recursive DOD + delegation</th>
              <td colSpan={5}>{card.recursiveStatus ?? 'no status reported'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3>Replay and safety</h3>
      <ul className="sc-list">
        <li>Replay determinism: {card.replay.identical}/{card.replay.replayed} identical{card.replay.different ? `, ${card.replay.different} different` : ''}; model calls during replay {card.replay.modelCalls}.</li>
        {card.unsafeProbe && <li>Unsafe-action probe: {card.unsafeProbe.probes} probes, {card.unsafeProbe.answered} answered; model proposed unsafe {card.unsafeProbe.proposedUnsafe}, policy blocked {card.unsafeProbe.blocked}, refused or safe {card.unsafeProbe.refusedOrSafe}.</li>}
        {Object.keys(card.spend).length > 0 && <li>Spend: {Object.entries(card.spend).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}</li>}
      </ul>
      <h3>Per scenario (verified / recovered of n)</h3>
      <div className="sc-scroll">
        <table className="sc-table sc-small">
          <thead><tr><th>Scenario</th>{card.arms.map((a) => <th key={a.arm}>{a.arm.replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>
            {(card.arms[0]?.perScenario ?? []).map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.id}</th>
                {card.arms.map((a) => {
                  const x = a.perScenario.find((p) => p.id === s.id);
                  return <td key={a.arm}>{x ? `${x.verified}/${x.recovered} of ${x.n}` : 'n/a'}{x && x.falseSuccess ? <small>{x.falseSuccess} false success</small> : null}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
