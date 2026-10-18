import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { ChevronsLeft, ChevronsRight, FlaskConical, Pause, Play, StepBack, StepForward, X } from 'lucide-react-native';
import { SPEEDS, play, seek, setSpeed, stepEvent, stepFrame, usePlayer, usePlayhead } from '@loopkeeper/core/runs';
import type { FaultKind } from '@loopkeeper/core/contracts';
import { formatSimClock } from '@loopkeeper/core';
import { commands, useWorld } from '@loopkeeper/core/store';
import { alpha, colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { useLinkStatus } from '@/hooks/useConnection';
import { liveRunIdOf, useRuns } from '@/hooks/useRuns';
import { Button, Chip, PressableScale, Segmented, T } from '@/components/ui';
import { exitReplay, runBadge, startReplay } from './runs';

const SIM_SPEEDS = [1, 2, 6, 10, 30];
const FAULTS: { kind: FaultKind; target?: string; label: string }[] = [
  { kind: 'fouling', target: 'p_17', label: 'Foul P-17' },
  { kind: 'strainer_blockage', target: 'strainer_02', label: 'Clog S-02' },
  { kind: 'valve_stuck', target: 'valve_b1', label: 'Stick V-B1' },
  { kind: 'pump_degradation', label: 'Wear TCS-PMP' },
  { kind: 'sensor_drift', target: 'sn_flow_zb', label: 'Drift FM-17' },
  { kind: 'workload_spike', target: 'rack_a2', label: 'Surge R-A2' },
];

function Scrubber({ from, to, value, onSeek }: { from: number; to: number; value: number; onSeek: (tick: number) => void }) {
  const [w, setW] = useState(0);
  const span = Math.max(1, to - from);
  const frac = Math.max(0, Math.min(1, (value - from) / span));
  const at = (x: number) => onSeek(Math.round(from + Math.max(0, Math.min(1, x / Math.max(w, 1))) * span));
  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      accessibilityRole="adjustable"
      accessibilityLabel="Replay position"
      accessibilityValue={{ min: from, max: to, now: Math.round(value) }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => at(e.nativeEvent.locationX)}
      onResponderMove={(e) => at(e.nativeEvent.locationX)}
      style={{ height: 36, justifyContent: 'center' }}
    >
      <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.1)' }}>
        <View style={{ width: `${frac * 100}%`, height: '100%', borderRadius: 3, backgroundColor: colors.watch }} />
      </View>
      <View style={{ position: 'absolute', left: Math.max(0, frac * w - 9), width: 18, height: 18, borderRadius: 9, backgroundColor: colors.watch, borderWidth: 2, borderColor: colors.bg }} />
    </View>
  );
}

function ReplayControls() {
  const p = usePlayer();
  const head = usePlayhead();
  if (p.phase === 'loading') return <T v="callout" color={colors.t2}>Loading the recording…</T>;
  if (p.phase === 'error') {
    return (
      <View style={{ gap: 8 }}>
        <T v="callout" color={colors.critical}>
          {p.problem?.message ?? 'Could not open the replay.'}
        </T>
        <Button label="Back to live" onPress={exitReplay} />
      </View>
    );
  }
  if (p.phase !== 'ready' || p.monitor) return null;
  const ev = p.timeline ? p.eventCount : 0;
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: 18, backgroundColor: alpha(colors.watch, 0.07), borderWidth: 1, borderColor: alpha(colors.watch, 0.32) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Chip tone="watch">REPLAY · READ-ONLY</Chip>
        <T v="monoSmall" color={colors.t3} style={{ flex: 1 }} numberOfLines={1}>
          {p.runId}
        </T>
        <T v="mono" color={colors.t1}>
          T+{formatSimClock(head.simTimeS)}
        </T>
      </View>
      <Scrubber from={p.from} to={p.to} value={head.tick} onSeek={(t) => void seek(t, true)} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T v="monoSmall" color={colors.t3}>
          tick {Math.round(head.tick)} / {Math.round(p.to)}
        </T>
        <T v="monoSmall" color={colors.t3}>
          {ev} events{p.fetching ? ' · loading' : ''}
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="" a11yLabel="Previous event" icon={ChevronsLeft} size="sm" flex onPress={() => stepEvent(-1)} />
        <Button label="" a11yLabel="Previous frame" icon={StepBack} size="sm" flex onPress={() => stepFrame(-1)} />
        <Button label={p.playing ? 'Pause' : 'Play'} icon={p.playing ? Pause : Play} size="sm" variant="tone" tone="watch" flex={false} style={{ minWidth: 96 }} onPress={() => play(!p.playing)} />
        <Button label="" a11yLabel="Next frame" icon={StepForward} size="sm" flex onPress={() => stepFrame(1)} />
        <Button label="" a11yLabel="Next event" icon={ChevronsRight} size="sm" flex onPress={() => stepEvent(1)} />
      </View>
      <Segmented<string> small value={String(p.speed)} onChange={(v) => setSpeed(Number(v))} items={SPEEDS.map((s) => ({ id: String(s), label: `${s}×` }))} />
      <Button label="Exit replay" icon={X} onPress={exitReplay} />
      {p.proj && !p.proj.exact ? (
        <T v="caption" color={colors.t3}>
          Showing the nearest recorded frame (tick {p.proj.base}); the recording is coarse here.
        </T>
      ) : null}
    </View>
  );
}

/** Run and replay controls: live pace (play/pause/speed on the live run), the run list, and read-only replay with a scrubber. */
export function RunPanel() {
  const runs = useRuns((s) => s.runs);
  const error = useRuns((s) => s.error);
  const selected = useRuns((s) => s.selectedId);
  const liveId = liveRunIdOf(runs);
  const link = useLinkStatus();
  const status = useWorld((s) => s.simStatus);
  const speed = useWorld((s) => s.simSpeed);
  const topoHash = useWorld((s) => s.topology?.facility.topology_hash);
  const replaying = usePlayer((s) => (s.phase === 'ready' && !s.monitor) || s.phase === 'loading');
  const [msg, setMsg] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  const paused = status === 'paused';
  const offline = link.degraded && link.level !== 'stale';

  useEffect(() => {
    void useRuns.getState().refresh();
  }, []);

  const run = async (p: Promise<{ accepted: boolean; reason?: string }>, ok: string) => {
    try {
      const ack = await p;
      setMsg(ack.accepted ? ok : (ack.reason ?? 'Not accepted by the backend.'));
      if (ack.accepted) haptic.success();
      else haptic.error();
    } catch {
      setMsg('Could not reach the backend.');
      haptic.error();
    }
  };
  const speedKey = SIM_SPEEDS.reduce((best, s) => (Math.abs(s - speed) < Math.abs(best - speed) ? s : best), SIM_SPEEDS[0]);

  return (
    <View style={{ gap: 16 }}>
      <ReplayControls />

      {!replaying ? (
        <View style={{ gap: 10, padding: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: colors.line }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T v="eyebrow">Live run</T>
            <Chip sm tone={paused ? 'watch' : 'nominal'}>
              {status}
            </Chip>
            <T v="monoSmall" color={colors.t3} style={{ flex: 1 }} numberOfLines={1}>
              {liveId ?? 'no live run'}
            </T>
          </View>
          <T v="caption" color={colors.t2}>
            Speed
          </T>
          <Segmented<string> value={String(speedKey)} onChange={(v) => void run(commands.setSpeed(Number(v)), `Speed set to ×${v}`)} items={SIM_SPEEDS.map((s) => ({ id: String(s), label: `×${s}` }))} />
          <Button label={paused ? 'Resume simulation' : 'Pause simulation'} icon={paused ? Play : Pause} disabled={offline} onPress={() => void run(paused ? commands.resume() : commands.pause(), paused ? 'Resumed' : 'Paused')} />
          {msg ? (
            <T v="caption" color={colors.t2}>
              {msg}
            </T>
          ) : null}
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <T v="eyebrow">Runs</T>
        {error ? (
          <T v="caption" color={colors.warning}>
            {error}
          </T>
        ) : null}
        {runs.length === 0 ? (
          <T v="callout" color={colors.t3}>
            No runs listed by this backend.
          </T>
        ) : (
          <View style={{ borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.line, overflow: 'hidden' }}>
            {runs.map((r, i) => {
              const b = runBadge(r);
              const on = (selected ?? liveId) === r.run_id;
              const mismatch = !!topoHash && !!r.topology_hash && r.topology_hash !== topoHash;
              return (
                <View key={r.run_id} style={{ gap: 8, padding: 12, backgroundColor: on ? alpha(colors.accent, 0.07) : 'transparent', borderBottomWidth: i === runs.length - 1 ? 0 : 1, borderBottomColor: colors.line }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T v="headline" style={{ fontSize: 14.5, flex: 1 }} numberOfLines={1}>
                      {r.label || r.run_id}
                    </T>
                    <Chip sm tone={b.tone}>
                      {b.text}
                    </Chip>
                  </View>
                  <T v="monoSmall" color={colors.t3} numberOfLines={1}>
                    {r.run_id} · tick {r.current_tick} · T+{formatSimClock(r.current_time_s)} · {r.incidents.opened} opened / {r.incidents.resolved} resolved
                  </T>
                  {mismatch ? (
                    <T v="micro" color={colors.t4}>
                      Recorded on another facility layout; a replay draws it on the current topology.
                    </T>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <PressableScale style={{ flex: 1 }} onPress={() => useRuns.getState().select(r.run_id === liveId ? null : r.run_id)} accessibilityRole="button" accessibilityLabel={`Use ${r.run_id} for comms and Definition of Done`}>
                      <Chip tone={on ? 'accent' : 'neutral'} style={{ alignSelf: 'stretch', justifyContent: 'center' }}>
                        {on ? 'Comms / DoD source' : 'Use for comms / DoD'}
                      </Chip>
                    </PressableScale>
                    <Button label="Replay" size="sm" variant="tone" tone="watch" icon={FlaskConical} onPress={() => startReplay(r.run_id)} disabled={offline && !replaying} />
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <PressableScale scaleTo={0.99} onPress={() => setTests((t) => !t)} accessibilityRole="button" accessibilityState={{ expanded: tests }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: tests ? alpha(colors.watch, 0.35) : colors.line }}>
          <FlaskConical size={17} color={colors.watch} />
          <View style={{ flex: 1 }}>
            <T v="headline" style={{ fontSize: 14.5 }}>
              Engineering test controls
            </T>
            <T v="caption" color={colors.t3}>
              Inject a simulated fault · testing only
            </T>
          </View>
        </View>
      </PressableScale>
      {tests ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {FAULTS.map((f) => (
            <View key={f.kind + (f.target ?? '')} style={{ width: '48%' }}>
              <Button label={f.label} variant="tone" tone="watch" size="sm" disabled={offline || replaying} onPress={() => void run(commands.injectFault(f.kind, f.target), `${f.label}: fault requested`)} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
