import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Activity, Bot, Cpu, Layers, LayoutDashboard, Map as MapIcon, FlaskConical, Pause, PlayCircle, Play, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { commands, useWorld } from '@loopkeeper/core/store';
import { useView, type QualityPreset } from '@loopkeeper/scene';
import { formatSimClock, PRODUCT_BRAND } from '@loopkeeper/core';
import type { FaultKind } from '@loopkeeper/core/contracts';
import { TABS, type TabId } from '../tabs/types';
import { useUi } from './store';
import { Chip, Dot, Eyebrow, LogoMark, Segmented } from './kit';
import { CommunicationsLauncher } from '../features/communications/Launcher';
import { DodChips } from '../features/dod/Panels';
import { Button, IconButton } from './kit/index';

const TAB_ICON = { dashboard: LayoutDashboard, map: MapIcon, agents: Bot, execution: PlayCircle } as const;

/**
 * ONE top-bar design, fitted instead of guessed: the bar starts with everything and drops secondary content in a fixed priority order until the three
 * clusters (brand | tabs | actions) fit without touching each other. It re-fits whenever the bar resizes (the app narrows beside the dock) or its text changes.
 * Levels (see styles/topbar.css): 1 sub-line to tooltip, 2 chip words to icons, 3 model chip, 4 TCS flow, 5 "Simulate", 6 wordmark, 7 key hints,
 * 8 remaining vitals + panel chips (reachable from the panel host), 9 icon tabs and icon-only Simulate, 10 facility name.
 */
export const MAX_DENSITY = 10;
export function barCrowded(bar: HTMLElement): boolean {
  const parts = [...bar.children].filter((c) => c instanceof HTMLElement && c.getClientRects().length) as HTMLElement[];
  const box = bar.getBoundingClientRect();
  const rects = parts.map((p) => p.getBoundingClientRect());
  for (let i = 0; i < parts.length; i++) {
    if (rects[i].right > box.right + 0.5 || rects[i].left < box.left - 0.5) return true;
    if (parts[i].scrollWidth > parts[i].clientWidth + 1) return true;
    if (i > 0 && rects[i].left < rects[i - 1].right + 8 - 0.5) return true;
  }
  return false;
}
function useFitDensity(ref: React.RefObject<HTMLElement | null>) {
  const [level, setLevel] = useState(0);
  const [tick, setTick] = useState(0);
  const last = useRef(-1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const bump = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), setTick((t) => t + 1)));
    };
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    const mo = new MutationObserver(bump);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (last.current !== tick) {
      last.current = tick;
      if (level !== 0) return setLevel(0); // re-fit from the full bar; all of this happens before paint
    }
    if (barCrowded(el) && level < MAX_DENSITY) setLevel(level + 1);
  }, [tick, level, ref]);
  return level;
}

function connLabel(connection: string, stale: boolean, paused: boolean) {
  if (connection === 'offline') return { text: 'OFFLINE', tone: 'critical' };
  if (connection === 'reconnecting' || connection === 'connecting') return { text: 'RECONNECTING', tone: 'warning' };
  if (stale) return { text: 'STALE', tone: 'warning' };
  if (paused) return { text: 'PAUSED', tone: 'watch' };
  return { text: 'LIVE', tone: 'nominal' };
}

export function TopBar({ onPalette }: { onPalette: () => void }) {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const facility = useWorld((s) => s.topology?.facility);
  const connection = useWorld((s) => s.connection);
  const stale = useWorld((s) => s.stale);
  const simTime = useWorld((s) => s.simTimeS);
  const speed = useWorld((s) => s.simSpeed);
  const status = useWorld((s) => s.simStatus);
  const health = useWorld((s) => s.health);
  const kpis = useWorld((s) => s.kpis);
  const limits = useWorld((s) => s.topology?.limits);
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const density = useFitDensity(barRef);
  const c = connLabel(connection, stale, status === 'paused');

  const margin = kpis?.min_margin_k ?? 0;
  const mTone = limits && margin < limits.margin_crit_k ? 'critical' : limits && margin < limits.margin_warn_k ? 'warning' : 'nominal';
  const open_i = kpis?.open_incidents ?? 0;
  const mock = health?.backend === 'mock';

  return (
    <header className="topbar" ref={barRef} data-d={density}>
      <div className="topbar__left panel panel--tight">
        <button className="brand" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="System status">
          <LogoMark />
          <span className="brand__word">{PRODUCT_BRAND.name}</span>
        </button>
        <span className="topbar__sep" />
        <button className="status" onClick={() => setOpen((o) => !o)} title={`Simulated facility · T+${formatSimClock(simTime)} · ×${speed % 1 ? speed.toFixed(1) : speed}`}>
          <span className="status__top">
            <Dot tone={c.tone} pulse={c.tone === 'nominal'} />
            <span className="status__name">{facility?.name ?? 'Connecting…'}</span>
            <span className="status__live" data-tone={c.tone}>{c.text}</span>
          </span>
          <span className="status__sub mono">
            SIMULATED FACILITY · T+{formatSimClock(simTime)} · ×{speed % 1 ? speed.toFixed(1) : speed}
          </span>
        </button>
        <AnimatePresence>{open && <SystemPopover onClose={() => setOpen(false)} />}</AnimatePresence>
      </div>

      <div className="topbar__center panel panel--tight">
        <Segmented<TabId>
          group="tab"
          value={tab}
          onChange={setTab}
          items={TABS.map((t) => {
            const Icon = TAB_ICON[t.id];
            return { id: t.id, aria: t.label, label: <><Icon size={15} className="seg__ico" aria-hidden /><span className="seg__lbl">{t.label}</span></>, hint: t.key };
          })}
        />
        <span className="topbar__sep topbar__sep--tabs" aria-hidden />
        <div className="seg seg--comms" role="group" aria-label="Communications">
          <CommunicationsLauncher variant="tab" />
        </div>
      </div>

      <div className="topbar__right panel panel--tight">
        <div className="topbar__vitals">
        <div className="vital vital--margin" title={margin < 0 ? `Minimum GPU thermal margin across racks: ${margin.toFixed(1)} K. Below 0 K is past the throttle limit (unrecovered).` : margin !== 0 && limits && margin < limits.margin_warn_k ? `Minimum GPU thermal margin across racks: ${margin.toFixed(1)} K (warning below ${limits.margin_warn_k} K).` : 'Minimum GPU thermal margin across racks'}>
          <span className="vital__label">Margin</span>
          <span className={`vital__value num tone-${mTone}`}>{margin.toFixed(1)}<small>K</small></span>
        </div>
        <div className="vital vital--flow" title="Technology-cooling mass flow">
          <span className="vital__label">TCS flow</span>
          <span className="vital__value num">{(kpis?.tcs_flow_kg_s ?? 0).toFixed(1)}<small>kg/s</small></span>
        </div>
        <div className="vital vital--inc" title="Open incidents">
          <span className="vital__label">Incidents</span>
          <span className={`vital__value num ${open_i ? 'tone-warning' : 'tone-nominal'}`}>{open_i}</span>
        </div>
        </div>
        <span className="topbar__sep topbar__sep--vitals" />
        {health && (
          <span className="hide-md">
          <Chip tone={health.intelligence.status === 'live' ? 'nominal' : 'sentinel'} sm title={`${health.intelligence.provider} · ${health.intelligence.model_id}`}>
            <Cpu size={11} /> {health.intelligence.status === 'mock' ? 'MOCK AGENTS' : health.intelligence.status === 'live' ? 'NEMOTRON LIVE' : 'AUTONOMOUS POLICY'}
          </Chip>
          </span>
        )}
        {mock && (
          <span className="hide-sm">
            <Chip tone="watch" sm title="A development simulator is serving this data, not the real backend.">
              <FlaskConical size={11} /> MOCK
            </Chip>
          </span>
        )}
        <div className="topbar__panels" role="group" aria-label="Panels">
          <span className="topbar__chips"><DodChips /></span>
        </div>
        <Button
          variant="primary"
          size="sm"
          className="btn--sim"
          icon={<Sparkles size={13} />}
          onClick={() => useUi.getState().setLauncher(true)}
          title="Simulate an incident with Natural Language (Crusoe Nemotron + Laya)"
        >
          <span className="sim__long">Simulate an incident</span>
          <span className="sim__short">Simulate</span>
        </Button>
        <IconButton className="topbar__view" size="sm" onClick={() => window.dispatchEvent(new Event('lk-viewer-mode'))} aria-label="Spatial view mode" icon={<Layers size={16} />} />
        <IconButton size="sm" onClick={onPalette} aria-label="Search" tip="Search · ⌘K" icon={<Search size={16} />} />
      </div>
    </header>
  );
}

const FAULTS: Array<{ kind: FaultKind; target?: string; label: string }> = [
  { kind: 'fouling', target: 'p_hs_b', label: 'Foul P-HS-B' },
  { kind: 'strainer_blockage', target: 'strainer_02', label: 'Clog S-02' },
  { kind: 'valve_stuck', target: 'valve_b1', label: 'Stick V-B1' },
  { kind: 'pump_degradation', label: 'Wear TCS-PMP' },
  { kind: 'sensor_drift', target: 'sn_flow_zb', label: 'Drift FM-17' },
  { kind: 'workload_spike', target: 'rack_a2', label: 'Surge R-A2' },
];

const PRESETS: Array<{ id: QualityPreset; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'high', label: 'High' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'performance', label: 'Performance' },
];

/** Rendering quality only: DPR, shadows, pipe tessellation, cosmetics. Simulated robots, topology and physics never change. */
function RenderQuality() {
  const preset = useView((s) => s.qualityPreset);
  const tier = useView((s) => s.quality);
  const setPreset = useView((s) => s.setPreset);
  return (
    <div>
      <Eyebrow>Rendering quality</Eyebrow>
      <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
        {PRESETS.map((p) => (
          <button key={p.id} className="btn btn--sm" style={preset === p.id ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'rgba(91,227,208,.3)' } : undefined} onClick={() => setPreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>
        Graphics only; simulation, robots and physics are unchanged.{preset === 'auto' ? ` Auto is currently using the ${tier === 'medium' ? 'Balanced' : tier === 'low' ? 'Performance' : 'High'} tier.` : ''}
      </div>
    </div>
  );
}

function SystemPopover({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const health = useWorld((s) => s.health);
  const transport = useWorld((s) => s.transport);
  const speed = useWorld((s) => s.simSpeed);
  const status = useWorld((s) => s.simStatus);
  const [tests, setTests] = useState(false);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.topbar__left')) onClose();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);
  if (!health) return null;
  const speeds = [1, 3, 6, 12, 24];
  return (
    <motion.div ref={ref} className="popover panel" initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
      <div className="popover__head">
        <div>
          <Eyebrow>System</Eyebrow>
          <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>Lab Hall 01</div>
        </div>
        <Chip tone={health.backend === 'mock' ? 'watch' : 'nominal'}>{health.backend === 'mock' ? 'MOCK BACKEND' : 'LIVE BACKEND'}</Chip>
      </div>
      <div className="kv">
        <span>Data source</span><b>{transport?.label}{transport?.url ? <em className="mono"> {transport.url.replace(/^https?:\/\//, '')}</em> : null}</b>
        <span>World seed</span><b className="mono">{health.seed}</b>
        <span>Physics solver</span><b className="tone-nominal">{health.solver.status} · res {health.solver.residual.toExponential(0)}</b>
        <span>Agent intelligence</span><b>{health.intelligence.provider} · <span className="mono">{health.intelligence.model_id}</span></b>
        <span>Model state</span><b className="tone-nominal">{health.intelligence.status === 'live' ? 'Online' : 'Active (Autonomous Policy)'}</b>
        <span>Checkpointer</span><b className="mono">{health.intelligence.checkpointer ?? 'postgres'}</b>
        <span>Operator mode</span><b>{health.safe_automation_mode === 'autonomous' ? `Autonomous · ${health.approval_window_s}s veto window` : 'Supervised · explicit approval'}</b>
      </div>
      <hr className="hr" />
      <div className="popover__row">
        <div>
          <Eyebrow>Simulation speed</Eyebrow>
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            {speeds.map((s) => (
              <button key={s} className="btn btn--sm" style={speed === s ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'rgba(91,227,208,.3)' } : undefined} onClick={() => void commands.setSpeed(s)}>
                ×{s}
              </button>
            ))}
          </div>
        </div>
        <button className="btn" onClick={() => void (status === 'paused' ? commands.resume() : commands.pause())}>
          {status === 'paused' ? <><Play size={14} /> Resume</> : <><Pause size={14} /> Pause</>}
        </button>
      </div>
      <hr className="hr" />
      <RenderQuality />
      <hr className="hr" />
      <button className="disclosure" onClick={() => setTests((t) => !t)} aria-expanded={tests}>
        <FlaskConical size={13} /> Engineering test controls
        <span style={{ marginLeft: 'auto', color: 'var(--t3)' }}>{tests ? '–' : '+'}</span>
      </button>
      {tests && (
        <div style={{ padding: '4px 0 2px' }}>
          <div style={{ fontSize: 11, color: 'var(--t3)', marginBottom: 8 }}>
            Faults normally arrive from seeded wear. These force one through the same physics, for testing only.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {FAULTS.map((f) => (
              <button key={f.label} className="btn btn--sm" onClick={() => void commands.injectFault(f.kind, f.target)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="popover__foot">
        <ShieldCheck size={12} /> Virtual robots only · real-plant actuation disabled
        <Activity size={12} style={{ marginLeft: 'auto' }} />
      </div>
    </motion.div>
  );
}
