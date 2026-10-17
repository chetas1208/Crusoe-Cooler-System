import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { Bot, ChevronDown, Gauge, Radar } from 'lucide-react-native';
import { ROBOT_MODE_LABEL, labelOfId } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import type { Robot } from '@loopkeeper/core/contracts';
import { alpha, colors, toneColor, type Tone } from '@/theme';
import { haptic } from '@/lib/haptics';
import { followRobot, openPipeCam, showEntityOnMap } from '@/lib/nav';
import { Button, Chip, Dot, Meter, PressableScale, Stat, T } from '@/components/ui';
import { MissionSteps } from '@/components/live/Inspector';

export function RobotCard({ robot: r }: { robot: Robot }) {
  const mission = useWorld((s) => (r.mission_id ? s.missions[r.mission_id] : undefined));
  const [open, setOpen] = useState(false);
  const inpipe = r.class === 'inpipe';
  const lane = inpipe ? colors.inpipe : colors.outrig;
  const active = r.mode !== 'DOCKED' && r.mode !== 'IDLE';
  const modeTone: Tone = r.mode === 'DOCKED' || r.mode === 'IDLE' ? 'isolated' : r.mode === 'FAILED' || r.mode === 'ABORTED' || r.mode === 'BLOCKED' ? 'critical' : r.mode === 'NEEDS_CHARGE' || r.mode === 'SAFE_HOLD' ? 'warning' : inpipe ? 'inpipe' : 'outrig';
  const batTone: Tone = r.battery_pct < 20 ? 'critical' : r.battery_pct < 45 ? 'warning' : 'nominal';
  const done = mission?.steps.filter((s) => s.status === 'done').length ?? 0;
  return (
    <Animated.View layout={LinearTransition.springify().damping(26)} entering={FadeIn.duration(220)} style={{ borderRadius: 20, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: active ? alpha(lane, 0.3) : colors.line }}>
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: lane, opacity: active ? 1 : 0.4 }} />
      <View style={{ padding: 16, paddingLeft: 19, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(lane, 0.14), borderWidth: 1, borderColor: alpha(lane, 0.3) }}>
            <Bot size={20} color={lane} strokeWidth={2.1} />
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <T v="headline" style={{ fontSize: 18 }}>{labelOfId(r.id)}</T>
            <T v="caption" color={colors.t3}>{inpipe ? 'INPIPE · internal crawler' : 'OUTRIG · external maintainer'}</T>
          </View>
          <Chip tone={modeTone} sm leading={active ? <Dot tone={modeTone} pulse size={6} /> : undefined}>
            {ROBOT_MODE_LABEL[r.mode]}
          </Chip>
        </View>

        <View style={{ gap: 9 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T v="eyebrow" style={{ fontSize: 9.5 }}>Battery</T>
            <T v="num" color={batTone === 'nominal' ? colors.t1 : toneColor[batTone]} style={{ fontSize: 15 }}>
              {Math.round(r.battery_pct)}
              <T v="micro" color={colors.t3}> %</T>
            </T>
          </View>
          <Meter value={r.battery_pct / 100} tone={batTone} height={5} />
        </View>

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <Stat label="Speed" value={r.pose.speed_m_s.toFixed(2)} unit="m/s" />
          <Stat label={r.pose.segment_id ? 'Segment' : 'Position'} value={r.pose.segment_id ? labelOfId(r.pose.segment_id) : `${r.pose.position_xyz_m[0].toFixed(1)}, ${r.pose.position_xyz_m[2].toFixed(1)}`} />
          <Stat label={r.pose.segment_id ? 'Along' : 'Tool'} value={r.pose.segment_id ? (r.pose.s_m ?? 0).toFixed(1) : r.tool ?? 'none'} unit={r.pose.segment_id ? 'm' : undefined} />
        </View>

        {mission ? (
          <View style={{ gap: 10, padding: 13, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.22)', borderWidth: 1, borderColor: colors.line }}>
            <PressableScale
              scaleTo={0.99}
              onPress={() => {
                haptic.select();
                setOpen((o) => !o);
              }}
              style={{ gap: 8 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T v="eyebrow" style={{ fontSize: 9.5, flex: 1 }}>Mission · {mission.id}</T>
                <T v="mono" color={colors.t2}>{done}/{mission.steps.length}</T>
                <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
                  <ChevronDown size={14} color={colors.t3} />
                </View>
              </View>
              <T v="headline" style={{ fontSize: 15, lineHeight: 20 }}>{mission.title}</T>
              <Meter value={mission.progress} tone={inpipe ? 'inpipe' : 'outrig'} height={3} />
            </PressableScale>
            {open ? (
              <Animated.View entering={FadeIn.duration(160)} style={{ paddingTop: 4 }}>
                <MissionSteps steps={mission.steps} />
              </Animated.View>
            ) : (
              <T v="callout" color={colors.t2} numberOfLines={1}>
                {mission.steps.find((s) => s.status === 'active')?.label ?? 'Waiting for the next step'}
              </T>
            )}
          </View>
        ) : (
          <T v="callout" color={colors.t3}>
            {r.mode === 'DOCKED' ? `Docked at ${labelOfId(r.home_id)} — ready for dispatch.` : 'No active mission.'}
          </T>
        )}

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Follow" icon={Radar} variant="primary" flex onPress={() => followRobot(r.id)} />
          {inpipe && r.pose.segment_id ? (
            <Button label="Robot cam" icon={Gauge} flex onPress={() => r.pose.segment_id && openPipeCam(r.pose.segment_id, r.id)} />
          ) : (
            <Button label="Locate" flex onPress={() => showEntityOnMap(r.id)} />
          )}
        </View>
      </View>
    </Animated.View>
  );
}
