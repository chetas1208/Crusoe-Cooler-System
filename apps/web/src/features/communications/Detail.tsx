import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge, Button, IconButton } from '../../ui/kit/index';
import { CopyButton, KindPill, MsgChipEl, OutcomeMark, PartyBadge } from './badges';
import { chipsOf, fmtMs, fmtSim, fmtWall, redact, shortModel } from './format';
import { jumpActions, type JumpAction } from './links';
import { useCommunications } from './communicationStore';
import type { CommunicationEventV1 } from './types';

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const pick = (d: Record<string, unknown> | undefined, keys: string[]): unknown => {
  for (const k of keys) if (d && d[k] !== undefined && d[k] !== null) return d[k];
  return undefined;
};

function Kv({ k, v, copy, mono = true }: { k: string; v?: string | number | null; copy?: boolean; mono?: boolean }) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  return (
    <div className="cm-kv">
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : undefined}>
        <span>{s}</span>
        {copy && <CopyButton value={s} label={k.toLowerCase()} />}
      </dd>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="cm-sec">
      <header className="cm-sec__h">
        <h4>{title}</h4>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Json({ value, label }: { value: unknown; label: string }) {
  const text = useMemo(() => JSON.stringify(redact(value), null, 2), [value]);
  return (
    <div className="cm-codewrap">
      <pre className="cm-json mono" tabIndex={0} aria-label={label}>{text}</pre>
      <CopyButton value={text} label={label.toLowerCase()} />
    </div>
  );
}

function CausalLink({ e, onOpen }: { e: CommunicationEventV1; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="cm-link" onClick={() => onOpen(e.event_id)} title={`Open ${e.event_id}`}>
      <span className="cm-time mono">{fmtSim(e.sim_time_ms)}</span>
      <PartyBadge p={e.sender} role="from" />
      <span className="cm-link__s">{e.summary}</span>
    </button>
  );
}

/**
 * Message detail drawer. It slides over the list inside the panel (the list underneath keeps its scroll position and focus),
 * and shows what the envelope actually carries: trace ids, tool / model fields (redacted), the causal chain and where to jump.
 */
export function Detail({ e, position, onBack, onSelect, onStep }: { e: CommunicationEventV1; position: { index: number; total: number }; onBack: () => void; onSelect: (id: string) => void; onStep: (d: 1 | -1) => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus({ preventScroll: true }), [e.event_id]);
  const events = useCommunications((s) => s.events);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [e.event_id]);

  const { parent, children } = useMemo(() => {
    const parent = e.causal_event_id ? events.find((x) => x.event_id === e.causal_event_id && x.run_id === e.run_id) : undefined;
    const children: CommunicationEventV1[] = [];
    for (const x of events) if (x.causal_event_id === e.event_id && x.run_id === e.run_id && children.length < 12) children.push(x);
    return { parent, children };
  }, [events, e.event_id, e.causal_event_id, e.run_id]);

  const d = e.detail;
  const tool = typeof d?.tool === 'string' ? d.tool : undefined;
  const isTool = Boolean(tool) || e.message_type === 'tool_event' || e.kind === 'REQUEST_TOOL' || e.kind === 'TOOL_ACCEPTED' || e.kind === 'TOOL_REJECTED';
  const args = pick(d, ['args', 'arguments', 'input', 'params']);
  const result = pick(d, ['result', 'output', 'error', 'reason']);
  const lat = typeof d?.latency_ms === 'number' ? (d.latency_ms as number) : undefined;
  const tin = typeof d?.tokens_in === 'number' ? (d.tokens_in as number) : undefined;
  const tout = typeof d?.tokens_out === 'number' ? (d.tokens_out as number) : undefined;
  const isModel = Boolean(e.model_id || e.model_provider) && (e.model_provider !== 'deterministic' || e.message_type === 'provider' || typeof d?.purpose === 'string');
  const jumps = jumpActions(e);
  const chips = chipsOf(e);
  const lost = position.index < 0; // the open message is filtered out of the list: stepping has no anchor
  const first = lost || position.index <= 0;
  const last = lost || position.index >= position.total - 1;

  const doJump = (j: JumpAction) => {
    if (j.reason) return;
    setNote(j.run());
  };

  return (
    <section
      className="cm-detail"
      aria-label="Message detail"
      onKeyDown={(ev) => {
        if ((ev.target as HTMLElement).closest('input,select,textarea')) return;
        if (ev.key === 'j' && !last) onStep(1);
        if (ev.key === 'k' && !first) onStep(-1);
      }}
    >
      <div className="cm-detail__bar">
        <Button ref={back} size="sm" variant="ghost" className="cm-back" icon={<ArrowLeft size={14} />} title="Back to messages (Esc)" onClick={onBack}>
          Messages
        </Button>
        <span className="cm-grow" />
        <span className="cm-detail__pos mono" aria-label={lost ? 'Message hidden by filters' : `Message ${position.index + 1} of ${position.total}`}>{lost ? 'filtered out' : `${position.index + 1} / ${position.total}`}</span>
        <IconButton size="sm" aria-label="Previous message" tip={lost ? 'This message is hidden by the current filters, so there is no previous one' : 'Previous message (k)'} disabledReason={first ? (lost ? 'This message is hidden by the current filters, so there is no previous one' : 'This is the oldest message in the list') : undefined} icon={<ChevronUp size={15} />} onClick={() => onStep(-1)} />
        <IconButton size="sm" aria-label="Next message" tip="Next message (j)" disabledReason={last ? (lost ? 'This message is hidden by the current filters, so there is no next one' : 'This is the newest message in the list') : undefined} icon={<ChevronDown size={15} />} onClick={() => onStep(1)} />
      </div>

      <div className="cm-detail__scroll">
        <div className="cm-detail__head">
          <div className="cm-detail__tags">
            <KindPill e={e} />
            <OutcomeMark e={e} />
            {e.priority && e.priority !== 'normal' && <Badge tone={e.priority === 'critical' ? 'critical' : 'neutral'} sm variant="outline" title="Message priority">{e.priority} priority</Badge>}
          </div>
          <h3 className="cm-detail__sum">{e.summary}</h3>
          <div className="cm-detail__route">
            <time className="cm-time mono" title={fmtWall(e.wall_time_utc)}>{fmtSim(e.sim_time_ms)}</time>
            <PartyBadge p={e.sender} role="from" />
            {e.recipient && (
              <>
                <span className="cm-arrow" aria-label="to">to</span>
                <PartyBadge p={e.recipient} role="to" />
              </>
            )}
          </div>
          {chips.length > 0 && (
            <div className="cm-detail__chips">
              {chips.map((c) => (
                <MsgChipEl key={c.id} c={c} />
              ))}
            </div>
          )}
        </div>

        <Section title="Trace">
          <dl className="cm-kvs">
            <Kv k="Event" v={e.event_id} copy />
            <Kv k="Message" v={e.message_id && e.message_id !== e.event_id ? e.message_id : undefined} copy />
            <Kv k="Run" v={e.run_id} copy />
            <Kv k="Sequence" v={e.seq} copy />
            <Kv k="Thread" v={e.thread_id} copy />
            <Kv k="Task" v={e.task_id} copy />
            <Kv k="Parent task" v={e.parent_id} copy />
            <Kv k="Mission" v={e.mission_id} copy />
            <Kv k="Incident" v={e.incident_id} copy />
            <Kv k="Robot" v={e.robot_id} copy />
            <Kv k="Asset" v={e.asset_id} copy />
            <Kv k="Boundary" v={e.subtype} />
            <Kv k="Stage" v={e.phase} />
            <Kv k="Status" v={e.status} />
            <Kv k="Scope" v={e.permission_scope} />
            <Kv k="Idempotency" v={e.idempotency_key} copy />
            <Kv k="Sim time" v={`${fmtSim(e.sim_time_ms)} (tick ${e.sim_tick})`} mono />
            <Kv k="Wall time" v={fmtWall(e.wall_time_utc)} mono />
            <Kv k="Schema" v={e.schema_version} />
          </dl>
        </Section>

        {isTool && (
          <Section title="Tool call">
            <dl className="cm-kvs">
              <Kv k="Tool" v={tool} />
              <Kv k="Call id" v={typeof d?.tool_call_id === 'string' ? d.tool_call_id : undefined} copy />
              <Kv k="Latency" v={lat !== undefined ? fmtMs(lat) : undefined} />
            </dl>
            <p className="cm-sublabel">Arguments</p>
            {args !== undefined ? <Json value={args} label="Arguments" /> : <p className="cm-none">This message did not record arguments.</p>}
            <p className="cm-sublabel">Result</p>
            {result !== undefined ? <Json value={result} label="Result" /> : <p className="cm-none">{e.status === 'pending' ? 'The call is still running.' : 'This message did not record a result.'}</p>}
            <p className="cm-fine">Secret-looking fields are redacted before they are shown.</p>
          </Section>
        )}

        {isModel && (
          <Section title="Model">
            <dl className="cm-kvs">
              <Kv k="Provider" v={e.model_provider} />
              <Kv k="Model" v={e.model_id ? `${shortModel(e.model_id)}` : undefined} copy />
              <Kv k="Purpose" v={typeof d?.purpose === 'string' ? d.purpose : undefined} mono={false} />
              <Kv k="Latency" v={lat !== undefined ? fmtMs(lat) : undefined} />
              <Kv k="Tokens in" v={tin !== undefined ? tin : 'not reported'} />
              <Kv k="Tokens out" v={tout !== undefined ? tout : 'not reported'} />
              <Kv k="Reason" v={typeof d?.reason === 'string' ? d.reason : undefined} mono={false} />
            </dl>
          </Section>
        )}

        <Section title="Caused by and leads to">
          {e.causal_event_id ? (
            parent ? (
              <div className="cm-links">
                <p className="cm-sublabel">Caused by</p>
                <CausalLink e={parent} onOpen={onSelect} />
              </div>
            ) : (
              <p className="cm-none" title="Not every backend event is a communication message, and older messages may have been trimmed from this panel.">Caused by <span className="mono">{e.causal_event_id}</span>. That event is not among the messages in this panel.</p>
            )
          ) : (
            <p className="cm-none">No causing message is recorded.</p>
          )}
          {children.length > 0 ? (
            <div className="cm-links">
              <p className="cm-sublabel">Led to {children.length === 12 ? '12 or more' : children.length}</p>
              {children.map((c) => (
                <CausalLink key={c.event_id} e={c} onOpen={onSelect} />
              ))}
            </div>
          ) : (
            <p className="cm-none">Nothing in view was caused by this message.</p>
          )}
        </Section>

        {e.evidence_ids && e.evidence_ids.length > 0 && (
          <Section title={`Evidence (${e.evidence_ids.length})`}>
            <ul className="cm-ev-list mono">
              {e.evidence_ids.map((x) => (
                <li key={x}>
                  <span>{x}</span>
                  <CopyButton value={x} label="evidence id" />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {d && isRec(d) && Object.keys(d).length > 0 && (
          <Section title="Structured detail">
            <Json value={d} label="Structured detail" />
          </Section>
        )}

        <Section title="Jump to">
          <div className="cm-jumps">
            {jumps.map((j) => (
              <Button key={j.id} size="sm" disabledReason={j.reason ?? undefined} title={j.reason ? undefined : j.hint} onClick={() => doJump(j)}>
                {j.label}
              </Button>
            ))}
          </div>
          {note && <p className="cm-miss" role="status">{note}</p>}
        </Section>
      </div>
    </section>
  );
}
