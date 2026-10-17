import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getLiveWorldState } from '@loopkeeper/core/store';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  GitFork,
  Plus,
  RotateCcw,
  Sliders,
  X,
  AlertTriangle,
  Info,
  CheckCircle2,
} from 'lucide-react';
import {
  usePlayer,
  usePlayhead,
  seek,
  play,
  stopPlay,
  stepFrame,
  stepEvent,
  setSpeed,
  SPEEDS,
  LANES,
  type Marker,
  type RunSummary,
} from '@loopkeeper/core/runs';
import {
  useExec,
  BASELINE,
  activeLiveRunId,
  isReplayOnly,
  fmtTick,
  fmtClock,
  runBadge,
  resolveRunsApi,
  type ExecMode,
} from './state';
import {
  useRunsPolling,
  useWorldBinding,
  useLabelResolver,
  startFork,
  runCommand,
} from './controller';
import { useOverviewFit } from '../dashboard/useOverviewFit';
import { apiFetch } from './api';
import './exec.css';

import { useExecutionPanels } from './ExecutionPanelsStore';
import { ScenarioLibrary } from './ScenarioLibrary';
import { DodChips, DodRail, ScorecardHost } from '../../features/dod/Panels';
import { CommunicationsDock } from '../../features/communications/CommunicationsPanel';
import { CommunicationsLauncher } from '../../features/communications/Launcher';
import { useCommunications } from '../../features/communications/communicationStore';

const useExecMonitor = () => usePlayer.getState().monitor;

export function ExecutionTab() {
  useRunsPolling();
  useWorldBinding();
  useLabelResolver();
  // same fitted overview camera as the Dashboard, framed in the area the side panels and the timeline leave free
  useOverviewFit();

  const mode = useExec((s) => s.mode);
  const selectedId = useExec((s) => s.selectedId);
  const notice = useExec((s) => s.notice);
  const tick = usePlayhead((s) => s.tick);
  const simTimeS = usePlayhead((s) => s.simTimeS);
  const selRun = useExec((s) => s.runs.find((r) => r.run_id === s.selectedId));
  const stamp = useExec((s) => s.topoStamp);
  const panels = useExecutionPanels();
  const commsOpen = useCommunications((s) => s.open);
  // a stopped run is a replay whatever chip is lit
  const eff = mode === 'live' && isReplayOnly(selRun) && selRun ? 'replay' : mode;

  return (
    <div className="ex" data-comms={commsOpen ? 'open' : 'closed'} data-timeline={panels.timelinePanel ? 'open' : 'closed'}>
      {stamp?.source === 'unavailable' && selRun?.run_id === stamp.runId && (
        <div className="ex-void" role="status">
          <b>Topology unavailable for {stamp.runId}</b>
          <span>
            This run was recorded on <span className="mono">{stamp.recorded}</span>, and the backend no longer has that layout, so its geometry cannot be rebuilt.
            The 3D view is left empty on purpose instead of drawing today&apos;s hall with the old run&apos;s data. The event timeline below is still the real recording.
          </span>
        </div>
      )}
      <div className="ex-frame" data-kind={eff} />

      {/* Top status indicator & Panel toggle rail */}
      <div className="ex-state" data-kind={eff}>
        <span className="ex-state__tag">{(selRun?.mode === 'FORK' && eff === 'live' ? 'FORK' : eff).toUpperCase()}</span>
        <span className="ex-state__v mono">Run: {selectedId ?? 'None'}</span>
        {selRun?.topology_version && <span className="ex-state__m mono">{selRun.topology_version}</span>}
        <span className="ex-state__m mono" style={{ color: '#00e5ff', fontWeight: 600 }}>
          {fmtClock(simTimeS)} / 30:00
        </span>

        {/* Reversible Panel Toggles */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 12, borderLeft: '1px solid var(--line-2)', paddingLeft: 12, alignItems: 'center' }}>
          <CommunicationsLauncher />
          <DodChips />
          <button
            className="chip"
            data-active={panels.scenarioLibrary}
            onClick={() => panels.togglePanel('scenarioLibrary')}
            title="Toggle Scenario Library"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Scenarios (9)
          </button>
          <button
            className="chip"
            data-active={panels.runsPanel}
            onClick={() => panels.togglePanel('runsPanel')}
            title="Toggle Runs List"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Runs
          </button>
          <button
            className="chip"
            data-active={panels.runInspector}
            onClick={() => panels.togglePanel('runInspector')}
            title="Toggle Inspector"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Details
          </button>
          <button
            className="chip"
            data-active={panels.timelinePanel}
            onClick={() => panels.togglePanel('timelinePanel')}
            title="Toggle Timeline Player"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            Timeline
          </button>
          <button
            className="chip"
            onClick={() => {
              if (panels.scenarioLibrary || panels.runsPanel || panels.runInspector || panels.timelinePanel) {
                panels.closeAll();
              } else {
                panels.openAll();
              }
            }}
            title="Toggle all overlays (Esc)"
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {panels.scenarioLibrary || panels.runsPanel || panels.runInspector || panels.timelinePanel ? 'Hide All' : 'Show All'}
          </button>
        </div>
      </div>

      {/* Main panels */}
      {panels.scenarioLibrary && <ScenarioLibrary />}
      {panels.runsPanel && <RunsPanel />}
      {panels.runInspector && <RunInspectorPanel />}
      {panels.timelinePanel && <TimelinePanel />}

      <DodRail />
      <ScorecardHost />
      <CommunicationsDock />

      {/* Notifications / Alerts */}
      {notice && (
        <div
          className="ex-problem"
          data-tone={notice.tone}
          style={{ position: 'absolute', bottom: 'calc(var(--tl-h) + 36px)', left: 330, zIndex: 30 }}
        >
          <b>{notice.tone === 'ok' ? 'Success' : notice.tone === 'warning' ? 'Warning' : 'Notice'}</b>
          <div>{notice.text}</div>
        </div>
      )}
    </div>
  );
}

/** which topology version the replay/fork world is drawn with (the run's recorded one; never today's layout) */
function TopologyStamp() {
  const t = useExec((s) => s.topoStamp);
  const live = getLiveWorldState().topology?.facility;
  const liveV = (live as { topology_version?: string } | undefined)?.topology_version ?? live?.topology_hash ?? '';
  if (!t) return null;
  const bad = t.source === 'live-fallback' || t.source === 'unavailable';
  return (
    <div className="ex-run__lineage mono" title={t.error ? `GET /runs/${t.runId}/topology: ${t.error}` : 'topology the 3D world is drawn with'} style={{ color: bad ? 'var(--warning)' : undefined }}>
      {t.source === 'unavailable'
        ? `topology ${t.recorded} unavailable · 3D not drawn`
        : `drawn on ${t.shown}${t.source === 'parent' ? " (parent's)" : ''}${t.source === 'live-fallback' ? ' · live layout fallback (run topology unavailable)' : t.matchesLive ? ' · = live' : ` · recorded layout (live is ${liveV})`}`}
    </div>
  );
}

function RunsPanel() {
  const mode = useExec((s) => s.mode);
  const runs = useExec((s) => s.runs);
  const selectedId = useExec((s) => s.selectedId);
  const setMode = useExec((s) => s.setMode);
  const select = useExec((s) => s.select);
  const runsError = useExec((s) => s.runsError);
  const activeLive = useExec((s) => activeLiveRunId(s.runs));

  return (
    <aside className="ex-left panel" data-inset="left">
      <header className="ex-head">
        <h2>Runs & Branches</h2>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {(['live', 'replay', 'branch'] as ExecMode[]).map((m) => (
            <button
              key={m}
              className="chip"
              data-active={mode === m}
              onClick={() => setMode(m)}
              style={{ fontSize: 11, padding: '2px 8px', textTransform: 'capitalize' }}
            >
              {m}
            </button>
          ))}
          <button
            className="btn btn--icon"
            onClick={() => useExecutionPanels.getState().setPanel('runsPanel', false)}
            title="Close Panel"
            style={{ width: 22, height: 22, padding: 0, marginLeft: 4 }}
          >
            <X size={13} />
          </button>
        </div>
      </header>

      {runsError && (
        <div className="ex-problem" data-tone="warning">
          <b>Runs Backend Error</b>
          <div>{runsError}</div>
        </div>
      )}

      <div className="ex-scroll">
        {runs.map((r) => {
          const badge = runBadge(r);
          const isCurrent = r.run_id === selectedId;
          return (
            <button
              key={r.run_id}
              className="ex-run"
              aria-current={isCurrent}
              data-kind={r.mode.toLowerCase()}
              onClick={() => (select(r.run_id), setMode(isReplayOnly(r) ? 'replay' : r.run_id === activeLive ? 'live' : mode === 'replay' ? 'replay' : 'live'))}
            >
              <div className="ex-run__top">
                <span className="ex-run__name">{r.label || r.run_id}</span>
                <span className={`chip tone-${badge.tone}`} style={{ fontSize: 10, padding: '1px 6px' }}>
                  {badge.text}
                </span>
              </div>
              <div className="ex-run__meta">
                <span className="mono">Tick {fmtTick(r.current_tick)}</span>
                <span>{fmtClock(r.current_time_s)}</span>
                <span>Seed {r.seed}</span>
              </div>
              <div className="ex-run__lineage mono" title="topology_version this run was recorded on">{r.topology_version ?? `#${r.topology_hash}`}</div>
              {isCurrent && <TopologyStamp />}
              {r.parent_run_id && (
                <div className="ex-run__lineage mono">
                  ↳ from {r.parent_run_id} @ tick {fmtTick(r.fork_tick ?? 0)}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function RunInspectorPanel() {
  const mode = useExec((s) => s.mode);
  const selectedId = useExec((s) => s.selectedId);
  const runs = useExec((s) => s.runs);
  const forking = useExec((s) => s.forking);
  const run = runs.find((r) => r.run_id === selectedId);
  const api = resolveRunsApi();
  const [verdictData, setVerdictData] = useState<any>(null);

  useEffect(() => {
    let unmounted = false;
    if (run?.run_id) {
      apiFetch(`/runs/${run.run_id}/verdict`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!unmounted && d?.verdict) {
            setVerdictData(d.verdict);
          }
        })
        .catch(() => {});
    }
    return () => {
      unmounted = true;
    };
  }, [run?.run_id]);

  if (!run) {
    return (
      <aside className="ex-right panel" data-inset="right">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px 0' }}>
          <b style={{ fontSize: 13 }}>Inspector</b>
          <button
            className="btn btn--icon"
            onClick={() => useExecutionPanels.getState().setPanel('runInspector', false)}
            title="Close Panel"
            style={{ width: 22, height: 22, padding: 0 }}
          >
            <X size={13} />
          </button>
        </div>
        <div className="ex-empty">
          <b>No Run Selected</b>
          <span>Select a run from the list on the left.</span>
        </div>
      </aside>
    );
  }

  const verdict = verdictData || (run as any)?.meta?.verdict;

  return (
    <aside className="ex-right panel" data-inset="right">
      <div className="ex-sec">
        <h3>
          <span>Run Details</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <small className="mono">{run.run_id}</small>
            <button
              className="btn btn--icon"
              onClick={() => useExecutionPanels.getState().setPanel('runInspector', false)}
              title="Close Panel"
              style={{ width: 22, height: 22, padding: 0 }}
            >
              <X size={13} />
            </button>
          </div>
        </h3>
        <div className="ex-kv">
          <span>Mode</span>
          <span className="v mono">{run.mode}</span>
          <span className="d">{run.state}</span>

          <span>Current Tick</span>
          <span className="v mono">{fmtTick(run.current_tick)}</span>
          <span className="d">{fmtClock(run.current_time_s)} / 30:00</span>

          <span>Seed</span>
          <span className="v mono">{run.seed}</span>
          <span className="d" />

          <span>Topology</span>
          <span className="v mono" style={{ overflowWrap: 'anywhere', textAlign: 'right', gridColumn: 'span 2' }}>{run.topology_version ?? `#${run.topology_hash}`}</span>

          <span>Checkpoints</span>
          <span className="v mono">{run.recording.checkpoints}</span>
          <span className="d" />
        </div>

        {verdict && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: 'var(--panel-2, #14171f)', border: '1px solid var(--line, #232936)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--t3)' }}>Outcome:</span>
              <span
                className="mono"
                style={{
                  fontWeight: 700,
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 4,
                  color: verdict.outcome === 'VERIFIED_RECOVERY' ? '#00e5ff' : verdict.outcome === 'CONTAINED' ? '#41d6a3' : '#ff5252',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid currentColor',
                }}
              >
                {verdict.outcome}
              </span>
            </div>
            {verdict.checks && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, marginTop: 6 }}>
                {verdict.checks.map((chk: any) => (
                  <div key={chk.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={11} style={{ color: chk.passed ? '#41d6a3' : '#ff5252' }} />
                    <span style={{ color: 'var(--t2)' }}>{chk.id.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ex-sec">
        <h3>
          <span>Actions</span>
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {api && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() =>
                  runCommand(api, run.run_id, run.state === 'paused' ? 'resume' : 'pause')
                }
              >
                {run.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                className="btn"
                title="1× standard pacing"
                onClick={() => runCommand(api, run.run_id, 'set_sim_speed', undefined, { speed: 1 })}
              >
                1×
              </button>
              <button
                className="btn"
                title="2× double speed"
                onClick={() => runCommand(api, run.run_id, 'set_sim_speed', undefined, { speed: 2 })}
              >
                2×
              </button>
              <button
                className="btn"
                title="3× maximum accelerated"
                onClick={() => runCommand(api, run.run_id, 'set_sim_speed', undefined, { speed: 3 })}
              >
                3×
              </button>
            </div>
          )}

          <button
            className="btn btn--primary"
            disabled={forking}
            onClick={() => startFork(`Fork of ${run.label || run.run_id}`)}
          >
            <GitFork size={14} style={{ marginRight: 6 }} />
            {forking ? 'Forking...' : 'Fork from Playhead'}
          </button>
        </div>
      </div>

      <div className="ex-note">
        <b>Deterministic Execution</b>
        <p style={{ margin: '4px 0 0' }}>
          {mode === 'replay'
            ? 'Replay mode is read-only. Seek the playhead to any tick, then fork to branch off a new simulation.'
            : mode === 'branch'
            ? 'Compare divergence between the parent scenario and branch states.'
            : 'Live execution is streamed from the authoritative engine.'}
        </p>
      </div>
    </aside>
  );
}

function TimelinePanel() {
  const mode = useExec((s) => s.mode);
  const player = usePlayer();
  const tick = usePlayhead((s) => s.tick);
  const simTimeS = usePlayhead((s) => s.simTimeS);
  const timeline = player.timeline;
  const monitor = player.monitor;
  const trackRef = useRef<HTMLDivElement>(null);

  const from = player.from;
  const to = Math.max(from + 1, player.to);
  const span = to - from;
  const clampedTick = Math.max(from, Math.min(to, tick));
  const pct = span > 0 ? ((clampedTick - from) / span) * 100 : 0;

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      const targetTick = Math.round(from + ratio * span);
      if (useExecMonitor()) {
        useExec.getState().say('info', `Live monitor: tick ${fmtTick(targetTick)} is in the recorded event log, but this backend recorded no world frames, so the 3D world cannot be rewound. Hover a marker for its details.`);
        return;
      }
      void seek(targetTick);
    },
    [from, span],
  );

  return (
    <div className="ex-tl panel" data-kind={mode} data-inset="bottom">
      <div className="ex-tl__bar">
        <button
          className="btn btn--icon"
          title={player.playing ? 'Pause' : 'Play'}
          onClick={() => play(!player.playing)}
          disabled={player.phase !== 'ready' || monitor}
        >
          {player.playing ? <Pause size={14} /> : <Play size={14} />}
        </button>

        <button
          className="btn btn--icon"
          title="Step back 1 event"
          onClick={() => stepEvent(-1)}
          disabled={player.phase !== 'ready' || monitor}
        >
          <ChevronLeft size={14} />
        </button>

        <button
          className="btn btn--icon"
          title="Step forward 1 event"
          onClick={() => stepEvent(1)}
          disabled={player.phase !== 'ready' || monitor}
        >
          <ChevronRight size={14} />
        </button>

        <span className="ex-tl__time">
          Tick {fmtTick(Math.round(clampedTick))} <small>({fmtClock(simTimeS)})</small>
        </span>

        <span className="ex-tag" data-kind={mode}>
          {monitor ? 'LIVE TAIL' : mode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, color: 'var(--t3)' }}>
          {player.phase === 'loading' ? 'Loading recording…' : player.phase === 'error' ? player.problem?.message : `${player.eventCount} recorded events · ${player.checkpoints.length} checkpoints${player.timeline ? ` · ${player.timeline.markers.length} markers` : ''}`}
        </span>

        <div className="grow" />

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--t3)', marginRight: 4 }}>Speed:</span>
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              className="chip"
              data-active={player.speed === sp}
              onClick={() => setSpeed(sp)}
              style={{ fontSize: 11, padding: '1px 6px' }}
            >
              {sp}×
            </button>
          ))}
          <button
            className="btn btn--icon"
            onClick={() => useExecutionPanels.getState().setPanel('timelinePanel', false)}
            title="Minimize Timeline"
            style={{ width: 24, height: 24, padding: 0, marginLeft: 6 }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="ex-tl__body">
        <div className="ex-lanes">
          {LANES.map((lane) => (
            <div key={lane.id} className="ex-lane-label">
              {lane.label}
            </div>
          ))}
        </div>

        <div className="ex-track" ref={trackRef} onClick={handleTrackClick}>
          <svg preserveAspectRatio="none">
            {/* Background grid lines */}
            <line x1="0%" y1="20%" x2="100%" y2="20%" stroke="var(--line)" />
            <line x1="0%" y1="40%" x2="100%" y2="40%" stroke="var(--line)" />
            <line x1="0%" y1="60%" x2="100%" y2="60%" stroke="var(--line)" />
            <line x1="0%" y1="80%" x2="100%" y2="80%" stroke="var(--line)" />

            {/* Render markers */}
            {timeline?.markers.map((mk) => {
              const mkFrom = Math.max(from, mk.from);
              const mkTo = Math.max(mkFrom + 1, mk.to);
              const mPctStart = ((mkFrom - from) / span) * 100;
              const mWidth = Math.max(0.8, ((mkTo - mkFrom) / span) * 100);
              const laneIndex = LANES.findIndex((l) => l.id === mk.lane);
              const y = laneIndex >= 0 ? laneIndex * 24 + 4 : 4;

              const toneColor =
                mk.tone === 'critical'
                  ? 'var(--critical)'
                  : mk.tone === 'warning'
                  ? 'var(--warning)'
                  : mk.tone === 'watch'
                  ? 'var(--replay)'
                  : mk.tone === 'ok'
                  ? 'var(--nominal)'
                  : 'var(--panel-3)';

              return (
                <rect
                  key={mk.id}
                  x={`${mPctStart}%`}
                  y={y}
                  width={`${mWidth}%`}
                  height="16"
                  rx="3"
                  fill={toneColor}
                  opacity="0.85"
                  className="ex-mk"
                >
                  <title>{`${mk.label} (${mk.detail || mk.lane})`}</title>
                </rect>
              );
            })}
          </svg>

          {/* Interactive Playhead */}
          <div className="ex-playhead" style={{ left: `${pct}%` }}>
            <b />
            <i />
          </div>
        </div>
      </div>
    </div>
  );
}
