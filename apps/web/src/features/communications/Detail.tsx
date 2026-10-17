import { useRef, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { fmtSim, kindLabel } from './format';
import { focusMessage, jumpTo, seekToMessage, targetsOf } from './links';
import type { CommunicationEventV1 } from './types';

export function Detail({ e, onBack }: { e: CommunicationEventV1; onBack: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), [e.event_id]);
  const targets = targetsOf(e);
  const [miss, setMiss] = useState<string | null>(null);
  useEffect(() => setMiss(null), [e.event_id]);
  const kv = (k: string, v?: string | number) => (v === undefined || v === '' ? null : (
    <div className="cm-kv" key={k}>
      <dt>{k}</dt>
      <dd className="mono">{String(v)}</dd>
    </div>
  ));
  return (
    <section className="cm-detail" aria-label="Message detail">
      <button ref={back} type="button" className="cm-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden /> Back to messages
      </button>
      <h3 className="cm-detail__sum">{e.summary}</h3>
      <dl className="cm-kvs">
        {kv('From', `${e.sender.id} (${e.sender.class})`)}
        {kv('To', e.recipient ? `${e.recipient.id} (${e.recipient.class})` : undefined)}
        {kv('Kind', kindLabel(e.message_type))}
        {kv('Boundary', e.subtype)}
        {kv('Stage', e.phase)}
        {kv('Status', e.status)}
        {kv('Sim time', `${fmtSim(e.sim_time_ms)} (tick ${e.sim_tick})`)}
        {kv('Wall time', e.wall_time_utc ? `${e.wall_time_utc} UTC` : undefined)}
        {kv('Run', e.run_id)}
        {kv('Sequence', e.seq)}
        {kv('Event', e.event_id)}
        {kv('Caused by', e.causal_event_id)}
        {kv('Thread', e.thread_id)}
        {kv('Task', e.task_id)}
        {kv('Mission', e.mission_id)}
        {kv('Incident', e.incident_id)}
        {kv('Robot', e.robot_id)}
        {kv('Asset', e.asset_id)}
        {kv('Provider', e.model_provider)}
        {kv('Model', e.model_id)}
        {kv('Schema', e.schema_version)}
      </dl>
      {e.evidence_ids && e.evidence_ids.length > 0 && (
        <>
          <h4 className="cm-h4">Evidence</h4>
          <ul className="cm-ev-list mono">
            {e.evidence_ids.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {e.detail && (
        <>
          <h4 className="cm-h4">Structured detail</h4>
          <pre className="cm-json mono" tabIndex={0}>{JSON.stringify(e.detail, null, 1)}</pre>
        </>
      )}
      {targets.length > 0 && (
        <div className="cm-jumps">
          {targets.map((t) => (
            <button key={t.kind + t.id} type="button" className="cm-chip" onClick={() => setMiss(jumpTo(t) ? null : `${t.id} is not in the world currently on screen (it may belong to another run or layout).`)} title="Keeps this run and the playback position">
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="cm-jumps">
        <button type="button" className="cm-chip" onClick={() => setMiss(seekToMessage(e).note)} title="Move the 30:00 timeline to this message's tick">
          Seek timeline to tick {e.sim_tick}
        </button>
        <button type="button" className="cm-chip" onClick={() => setMiss(focusMessage(e).note)} title="Focus the 3D camera on the robot or asset">
          Focus camera
        </button>
      </div>
      {miss && <p className="cm-miss" role="status">{miss}</p>}
    </section>
  );
}
