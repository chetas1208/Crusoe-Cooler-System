import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, ChevronUp, CircleAlert, Crosshair, FileSearch, Hand, Loader, Network, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { commands, tasksOf, useWorld } from '@loopkeeper/core/store';
import { CAUSE_LABEL, INCIDENT_STATUS_LABEL, formatDuration, labelOfId } from '@loopkeeper/core';
import type { Incident } from '@loopkeeper/core/contracts';
import { useView } from '@loopkeeper/scene';
import { Chip, Dot, Eyebrow, Ring } from './kit';
import { StageDots } from './Dock';
import { useUi, usePinnedIncident } from './store';

const sevTone = (i: Incident) => (i.closed_tick ? (i.status === 'dismissed' ? 'isolated' : 'nominal') : i.status === 'escalated' ? 'critical' : i.severity);

export function IncidentCard() {
  const inc = usePinnedIncident();
  const collapsed = useUi((s) => s.incidentCollapsed);
  const setCollapsed = useUi((s) => s.setCollapsed);
  const pin = useUi((s) => s.pin);
  const focus = useView((s) => s.focusIncident);
  const setMode = useView((s) => s.setMode);
  const simTime = useWorld((s) => s.simTimeS);
  const working = useWorld((s) => (inc ? tasksOf(s, inc.id).some((t) => t.status === 'working') : false));
  const manualPin = useUi((s) => s.pinned);

  return (
    <AnimatePresence mode="popLayout">
      {inc && (
        <motion.section
          key={inc.id}
          layout
          className="incident panel"
          data-tone={sevTone(inc)}
          initial={{ opacity: 0, x: 18, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 18, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
        >
          <header className="incident__head">
            <span className={`incident__sev tone-${sevTone(inc)}`}>
              {inc.closed_tick ? <Check size={14} strokeWidth={2.6} /> : inc.severity === 'critical' || inc.status === 'escalated' ? <TriangleAlert size={14} strokeWidth={2.4} /> : <CircleAlert size={14} strokeWidth={2.4} />}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="incident__id mono">
                {inc.id} <span>· {formatDuration(simTime - inc.opened_at_s)}{inc.closed_tick ? ' total' : ' open'}</span>
              </div>
              <div className="incident__title">{inc.title}</div>
            </div>
            <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand incident' : 'Collapse incident'}>
              {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
            {manualPin && (
              <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => pin(null)} aria-label="Unpin incident" title="Back to auto">
                <X size={14} />
              </button>
            )}
          </header>

          <div className="incident__chips">
            <Chip tone={inc.status === 'escalated' ? 'critical' : inc.closed_tick ? 'nominal' : 'accent'} sm>
              {working && !inc.closed_tick ? <span className="spinner" style={{ width: 9, height: 9 }} /> : <Dot tone={inc.closed_tick ? 'nominal' : 'accent'} />}
              {INCIDENT_STATUS_LABEL[inc.status]}
            </Chip>
            <Chip sm>{CAUSE_LABEL[inc.cause]}</Chip>
            {inc.attempts > 0 && <Chip tone="warning" sm>attempt {inc.attempts + 1}</Chip>}
          </div>

          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }} style={{ overflow: 'hidden' }}>
                <div className="incident__body">
                  <StageDots inc={inc} />
                  <p className="incident__summary">{inc.summary}</p>
                  <ApprovalBanner inc={inc} />
                  <VerificationBlock inc={inc} />
                  <Hypotheses inc={inc} />
                  <div className="incident__actions">
                    <button className="btn btn--sm" onClick={() => focus(inc.id)}>
                      <Crosshair size={13} /> Show on map
                    </button>
                    <button
                      className="btn btn--sm"
                      onClick={() => {
                        useView.getState().focusIncident(inc.id);
                        setMode('agents');
                      }}
                    >
                      <Network size={13} /> Agent trace
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function ApprovalBanner({ inc }: { inc: Incident }) {
  const a = inc.approval;
  const simTime = useWorld((s) => s.simTimeS);
  const speed = useWorld((s) => s.simSpeed);
  const health = useWorld((s) => s.health);
  if (!a || (a.status !== 'pending' && a.status !== 'held')) return null;
  const window = health?.approval_window_s ?? 24;
  const held = a.status === 'held';
  const auto = a.auto_approve_at_s !== null && !held;
  const remainSim = auto ? Math.max(0, (a.auto_approve_at_s ?? 0) - simTime) : 0;
  const remainWall = remainSim / Math.max(speed, 0.1);
  return (
    <motion.div className="approval" data-held={held} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
      <Ring value={auto ? remainSim / window : 1} size={38} tone={held ? 'watch' : 'accent'}>
        {auto ? Math.ceil(remainWall) : <Hand size={13} />}
      </Ring>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="approval__t">{a.action}</div>
        <div className="approval__s">
          {held ? 'On hold — nothing moves until you approve.' : auto ? `Auto-approves in ${Math.ceil(remainWall)} s unless you hold it` : 'Needs your explicit approval'}
        </div>
      </div>
      <div className="approval__btns">
        {!held && auto && (
          <button className="btn btn--sm" onClick={() => void commands.hold(a.id)}>
            Hold
          </button>
        )}
        <button className="btn btn--sm btn--primary" onClick={() => void commands.approve(a.id)}>
          Approve
        </button>
      </div>
      <ul className="approval__steps">
        {a.steps.slice(0, 5).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </motion.div>
  );
}

function VerificationBlock({ inc }: { inc: Incident }) {
  const v = inc.verification;
  if (!v) return null;
  if (v.status === 'pending')
    return (
      <div className="verify">
        <Ring value={v.progress} size={34} tone="sentinel">
          <ShieldCheck size={13} />
        </Ring>
        <div style={{ flex: 1 }}>
          <div className="verify__t">Independent verification</div>
          <div className="verify__s">
            Stabilisation window · {Math.round(v.elapsed_s)} / {Math.round(v.window_s)} s of simulated time
          </div>
        </div>
        <Chip tone="sentinel" sm>
          PENDING
        </Chip>
      </div>
    );
  const ok = v.status === 'verified';
  return (
    <div className="verify verify--done" data-ok={ok}>
      <div className="verify__row">
        <span className={`verify__badge tone-${ok ? 'nominal' : 'critical'}`}>{ok ? <Check size={13} strokeWidth={3} /> : <X size={13} strokeWidth={3} />}</span>
        <div style={{ flex: 1 }}>
          <div className="verify__t">{ok ? 'Verified by physics' : 'Rejected — repair did not recover the plant'}</div>
          <div className="verify__s">
            attempt {v.attempt} · confidence {Math.round(v.confidence * 100)}%
          </div>
        </div>
      </div>
      <div className="checks">
        {v.checks.map((c) => (
          <div key={c.id} className="check" data-pass={c.pass}>
            <span className="check__icon">{c.pass ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}</span>
            <span className="check__label">{c.label}</span>
            <span className="check__vals num">
              {c.before.toFixed(2)} <i>→</i> <b>{c.after.toFixed(2)}</b> <em>{c.unit}</em>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Hypotheses({ inc }: { inc: Incident }) {
  if (!inc.hypotheses.length) return null;
  return (
    <div className="hyp">
      <Eyebrow style={{ marginBottom: 8 }}>Hypotheses</Eyebrow>
      {inc.hypotheses.slice(0, 3).map((h) => (
        <div key={h.id} className="hyp__row" data-status={h.status}>
          <div className="hyp__top">
            <span className="hyp__label">{h.label}</span>
            <span className="hyp__pct num">{h.status === 'confirmed' ? 'confirmed' : h.status === 'refuted' ? 'ruled out' : `${Math.round(h.confidence * 100)}%`}</span>
          </div>
          <div className="hyp__bar">
            <i style={{ width: `${Math.max(2, h.confidence * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export { FileSearch, Loader, labelOfId };
