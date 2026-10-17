import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { ChevronDown, FlaskConical, Pause, Play } from 'lucide-react-native';
import { commands, useWorld } from '@loopkeeper/core/store';
import type { FaultKind } from '@loopkeeper/core/contracts';
import { formatDuration, formatSimClock } from '@loopkeeper/core';
import { useView } from '@loopkeeper/scene';
import { alpha, colors } from '@/theme';
import { resolveApiUrl } from '@/lib/api';
import { RENDER_SCALE } from '@/lib/quality';
import { haptic } from '@/lib/haptics';
import { ScreenScroll } from '@/components/ScreenScroll';
import { useLinkStatus } from '@/hooks/useConnection';
import { Button, Card, Chip, GroupTitle, PressableScale, Row, Segmented, T } from '@/components/ui';

const SPEEDS = [1, 2, 6, 10, 30];
const FAULTS: { kind: FaultKind; target?: string; label: string; hint: string }[] = [
  { kind: 'fouling', target: 'p_17', label: 'Foul P-17', hint: 'progressive deposit' },
  { kind: 'strainer_blockage', target: 'strainer_02', label: 'Clog S-02', hint: 'strainer ΔP rise' },
  { kind: 'valve_stuck', target: 'valve_b1', label: 'Stick V-B1', hint: 'partial opening' },
  { kind: 'pump_degradation', label: 'Wear TCS-PMP', hint: 'head below curve' },
  { kind: 'sensor_drift', target: 'sn_flow_zb', label: 'Drift FM-17', hint: 'inconsistent reading' },
  { kind: 'workload_spike', target: 'rack_a2', label: 'Surge R-A2', hint: 'thermal load only' },
];

export default function SystemScreen() {
  const link = useLinkStatus();
  const health = useWorld((s) => s.health);
  const facility = useWorld((s) => s.topology?.facility);
  const simTime = useWorld((s) => s.simTimeS);
  const speed = useWorld((s) => s.simSpeed);
  const status = useWorld((s) => s.simStatus);
  const reduced = useView((s) => s.reducedMotion);
  const [msg, setMsg] = useState<string | null>(null);
  const [tests, setTests] = useState(false);
  const paused = status === 'paused';
  const offline = link.level === 'offline' || link.level === 'reconnecting' || link.level === 'connecting';

  const run = async (p: Promise<{ accepted: boolean; reason?: string }>, okMsg: string) => {
    try {
      const ack = await p;
      setMsg(ack.accepted ? okMsg : ack.reason ?? 'Not accepted by the backend.');
      if (ack.accepted) haptic.success();
      else haptic.error();
    } catch {
      setMsg('Could not reach the backend.');
      haptic.error();
    }
  };

  const speedKey = SPEEDS.reduce((best, s) => (Math.abs(s - speed) < Math.abs(best - speed) ? s : best), SPEEDS[0]);

  return (
    <ScreenScroll title="System" contentStyle={{ paddingHorizontal: 16, gap: 22 }}>
      {/* honesty header */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip tone={link.tone}>{link.label}</Chip>
        <Chip tone="neutral">SIMULATED FACILITY</Chip>
        {health?.backend === 'mock' ? (
          <Chip tone="watch" icon={FlaskConical}>
            MOCK BACKEND
          </Chip>
        ) : health ? (
          <Chip tone="nominal">LIVE BACKEND</Chip>
        ) : null}
      </View>
      {health?.backend === 'mock' && (
        <T v="callout" color={colors.t3} style={{ marginTop: -10 }}>
          A development simulator is serving this data, not the real backend. Everything here — physics, robots, agents — is virtual; no real plant is connected or actuated.
        </T>
      )}

      <View style={{ gap: 10 }}>
        <GroupTitle>Simulation</GroupTitle>
        <Card>
          <Row label="Facility" value={facility?.name ?? '—'} />
          <Row label="Sim time" value={`T+${formatSimClock(simTime)}`} mono />
          <Row label="State" value={status} tone={status === 'running' ? colors.nominal : status === 'degraded' ? colors.warning : colors.watch} />
          <View style={{ padding: 14, gap: 12 }}>
            <T v="callout" color={colors.t2} style={{ fontSize: 14 }}>
              Speed
            </T>
            <Segmented<string> value={String(speedKey)} onChange={(v) => void run(commands.setSpeed(Number(v)), `Speed set to ×${v}`)} items={SPEEDS.map((s) => ({ id: String(s), label: `×${s}` }))} />
          </View>
          <View style={{ padding: 14, paddingTop: 0 }}>
            <Button label={paused ? 'Resume simulation' : 'Pause simulation'} icon={paused ? Play : Pause} disabled={offline} onPress={() => void run(paused ? commands.resume() : commands.pause(), paused ? 'Resumed' : 'Paused')} />
          </View>
        </Card>
        {msg ? (
          <Animated.View entering={FadeIn.duration(160)}>
            <T v="caption" color={colors.t2} style={{ paddingHorizontal: 4 }}>
              {msg}
            </T>
          </Animated.View>
        ) : null}
      </View>

      <View style={{ gap: 10 }}>
        <GroupTitle>Backend</GroupTitle>
        <Card>
          <Row label="Link" value={link.label} tone={link.level === 'live' ? colors.nominal : colors.warning} />
          <Row label="Endpoint" value={resolveApiUrl().replace(/^https?:\/\//, '')} mono />
          <Row label="Engine" value={health ? health.status : '—'} />
          <Row label="Tick rate" value={health ? `${health.tick_rate_hz} Hz` : '—'} mono />
          <Row label="Solver" value={health ? `${health.solver.status} · res ${health.solver.residual.toExponential(1)}` : '—'} mono tone={health && health.solver.status !== 'converged' ? colors.warning : undefined} />
          <Row label="Database" value={health?.database ?? '—'} />
          <Row label="Uptime" value={health ? formatDuration(health.uptime_s) : '—'} />
          <Row label="World seed" value={health ? String(health.seed) : '—'} mono last />
        </Card>
      </View>

      <View style={{ gap: 10 }}>
        <GroupTitle hint="Agents propose; deterministic simulation code decides what is legal and computes every consequence.">Intelligence</GroupTitle>
        <Card>
          <Row label="Provider" value={health ? `${health.intelligence.provider} · ${health.intelligence.model_id}` : '—'} mono />
          <Row label="Model status" value={health ? (health.intelligence.status === 'mock' ? 'mock agents' : health.intelligence.status) : '—'} tone={health?.intelligence.status === 'unavailable' ? colors.critical : undefined} />
          <Row label="Automation" value={health?.safe_automation_mode ?? '—'} />
          <Row label="Approval window" value={health ? `${health.approval_window_s} s sim` : '—'} last />
        </Card>
      </View>

      <View style={{ gap: 10 }}>
        <GroupTitle>This device</GroupTitle>
        <Card>
          <Row label="3D quality" value="Mobile · no shadows" />
          <Row label="Render scale" value={`${Math.round(RENDER_SCALE * 100)}%`} mono />
          <Row label="Reduce motion" value={reduced ? 'On (system)' : 'Off (system)'} last />
        </Card>
      </View>

      <Animated.View layout={LinearTransition.springify().damping(26)} style={{ gap: 10 }}>
        <PressableScale
          scaleTo={0.99}
          onPress={() => {
            haptic.select();
            setTests((t) => !t);
          }}
        >
          <Card style={{ borderColor: tests ? alpha(colors.watch, 0.3) : colors.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15 }}>
              <FlaskConical size={18} color={colors.watch} strokeWidth={2.2} />
              <View style={{ flex: 1, gap: 1 }}>
                <T v="headline" style={{ fontSize: 15 }}>
                  Engineering test controls
                </T>
                <T v="caption" color={colors.t3}>
                  Inject simulated faults · for testing only
                </T>
              </View>
              <View style={{ transform: [{ rotate: tests ? '180deg' : '0deg' }] }}>
                <ChevronDown size={18} color={colors.t3} />
              </View>
            </View>
          </Card>
        </PressableScale>
        {tests && (
          <Animated.View entering={FadeIn.duration(180)} style={{ gap: 12 }}>
            <T v="callout" color={colors.t3}>
              These controls ask the simulator to start a physical fault. They are test tools — the primary experience is a world that develops faults on its own.
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {FAULTS.map((f) => (
                <View key={f.kind + (f.target ?? '')} style={{ width: '48%' }}>
                  <Button label={f.label} variant="tone" tone="watch" size="sm" disabled={offline} onPress={() => void run(commands.injectFault(f.kind, f.target), `${f.label}: fault started (${f.hint})`)} />
                </View>
              ))}
            </View>
          </Animated.View>
        )}
      </Animated.View>

      <T v="micro" color={colors.t4} style={{ textAlign: 'center' }}>
        LOOPKEEPER mobile · simulated facility · virtual robots
      </T>
    </ScreenScroll>
  );
}
