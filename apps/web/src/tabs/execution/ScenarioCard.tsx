import React from 'react';
import { Play, Ban, Eye, Film } from 'lucide-react';
import { Badge, Button, type Tone } from '../../ui/kit/index';
import { classify, resolveTarget, type Definition, type LiveVerdict, type PreviewSpec, type SupportState, type TopoLite, type ValidatorView } from './scenarioSpec';

export type ScenarioCardData = Definition;

interface ScenarioCardProps {
  data: Definition;
  topo: TopoLite | null;
  validator: ValidatorView | null;
  /** the spec this scenario launches (hazard kind when the backend accepts it, else registry faults) */
  spec: PreviewSpec;
  verdict?: LiveVerdict;
  /** the validator's reasons for not using the hazard kind */
  hazardNotes?: string[];
  /** another launch is in flight */
  busy?: boolean;
  recording?: boolean;
  onOpen(scenarioId: string): void;
  onRecord(scenarioId: string, speed: number): void;
}

export const TONE: Record<SupportState, Tone> = { live: 'nominal', partial: 'warning', unsupported: 'critical' };

export function ScenarioCard({ data, topo, validator, spec, verdict, hazardNotes, busy, recording, onOpen, onRecord }: ScenarioCardProps) {
  const sup = classify(data, topo, validator, verdict, spec);
  const blocked = sup.state === 'unsupported' && !verdict; // a refused launch stays retryable: the backend may have changed since
  return (
    <article className="sl-card" data-severity={data.severity} data-support={sup.state} data-testid={`scenario-${data.scenario_id}`}>
      <div className="sl-card__top">
        <span className="sl-id mono">{data.scenario_id}</span>
        <span className="sl-sev">{data.severity}</span>
        <Badge tone={TONE[sup.state]} sm title={sup.reasons.join('\n') || sup.label} className="sl-chip">{sup.label}</Badge>
      </div>
      <h4 className="sl-title">{data.label}</h4>
      <p className="sl-goal">{data.learning_goal}</p>

      <ul className="sl-faults" aria-label="Faults this scenario injects">
        {spec.faults.map((f, i) => {
          const r = f.resolved ?? resolveTarget(f.target_id, topo);
          return (
            <li key={i}>
              <span className="mono">{f.kind}</span>
              <span aria-hidden> → </span>
              <span className="mono" data-missing={topo && !r.found ? 'true' : undefined}>{f.target_id}</span>
              {f.capability !== 'real' && <em className="sl-cap" data-cap={f.capability}>{f.capability}</em>}
            </li>
          );
        })}
      </ul>

      {sup.outcome && <p className="sl-outcome">{sup.outcome}</p>}
      {sup.reasons.length > 0 && (
        <ul className="sl-reasons" data-state={sup.state}>
          {sup.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      {sup.simulated.length > 0 && (
        <div className="sl-sim">
          <b>Simulated as</b>
          <ul>{sup.simulated.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      {hazardNotes && hazardNotes.length > 0 && spec.mode === 'registry' && (
        <p className="sl-note sl-note--dim">The backend does not accept this scenario&apos;s hazard fault kind yet ({hazardNotes[0]}); showing the registry faults.</p>
      )}

      <div className="sl-actions">
        <Button
          variant={blocked ? 'secondary' : 'primary'}
          icon={blocked ? <Ban size={14} /> : verdict ? <Eye size={14} /> : <Play size={14} />}
          disabled={busy}
          disabledReason={busy ? 'Another scenario is launching' : undefined}
          onClick={() => onOpen(data.scenario_id)}
        >
          {blocked ? 'Preview (cannot start)' : verdict && verdict.status !== 'injected' ? 'Preview / retry' : 'Preview and launch'}
        </Button>
        <Button
          icon={<Film size={14} />}
          loading={recording}
          disabledReason={!data.readiness.ready ? 'The backend registry does not mark this scenario ready for a recorded episode' : undefined}
          onClick={() => onRecord(data.scenario_id, 1)}
        >
          {recording ? 'Recording...' : 'Record replay'}
        </Button>
      </div>
    </article>
  );
}
