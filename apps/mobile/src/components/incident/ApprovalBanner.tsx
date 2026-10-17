import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { ChevronDown, Hand, Pause, ShieldCheck } from 'lucide-react-native';
import { commands, useWorld } from '@loopkeeper/core/store';
import type { Incident } from '@loopkeeper/core/contracts';
import { alpha, colors } from '@/theme';
import { haptic } from '@/lib/haptics';
import { useLinkStatus } from '@/hooks/useConnection';
import { Button, PressableScale, Ring, T } from '@/components/ui';

/**
 * Operator veto window. The countdown is sim-time remaining ÷ sim speed (what the operator actually waits),
 * driven only by streamed world time — if the stream stalls the ring stops, it never invents progress.
 */
export function ApprovalBanner({ inc }: { inc: Incident }) {
  const a = inc.approval;
  const simTime = useWorld((s) => s.simTimeS);
  const speed = useWorld((s) => s.simSpeed);
  const windowS = useWorld((s) => s.health?.approval_window_s ?? 24);
  const paused = useWorld((s) => s.simStatus === 'paused');
  const link = useLinkStatus();
  const offline = link.level === 'offline' || link.level === 'reconnecting' || link.level === 'connecting';
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState<null | 'hold' | 'approve'>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!a || (a.status !== 'pending' && a.status !== 'held')) return null;

  const held = a.status === 'held';
  const auto = a.auto_approve_at_s !== null && !held;
  const remainSim = auto ? Math.max(0, (a.auto_approve_at_s ?? 0) - simTime) : 0;
  const remainWall = remainSim / Math.max(speed, 0.1);
  const tone = held ? colors.watch : colors.accent;

  const run = async (kind: 'hold' | 'approve') => {
    setBusy(kind);
    setErr(null);
    if (kind === 'approve') haptic.success();
    else haptic.medium();
    try {
      const ack = kind === 'approve' ? await commands.approve(a.id) : await commands.hold(a.id);
      if (!ack.accepted) {
        setErr(ack.reason ?? 'The backend did not accept that command.');
        haptic.error();
      }
    } catch {
      setErr('Could not reach the backend.');
      haptic.error();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Animated.View entering={FadeIn.duration(260)} exiting={FadeOut.duration(160)} layout={LinearTransition.springify().damping(24)} style={{ borderRadius: 16, padding: 14, gap: 12, backgroundColor: alpha(tone, held ? 0.08 : 0.09), borderWidth: 1, borderColor: alpha(tone, held ? 0.3 : 0.32) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
        <Ring value={auto ? remainSim / Math.max(windowS, 1) : 1} size={52} stroke={4} tone={held ? 'watch' : 'accent'}>
          {auto && !paused ? (
            <T v="num" style={{ fontSize: 17 }}>
              {Math.ceil(remainWall)}
            </T>
          ) : paused && auto ? (
            <Pause size={17} color={colors.watch} strokeWidth={2.4} />
          ) : (
            <Hand size={18} color={tone} strokeWidth={2.2} />
          )}
        </Ring>
        <View style={{ flex: 1, gap: 3 }}>
          <T v="eyebrow" color={tone}>
            {held ? 'On hold' : 'Operator approval'}
          </T>
          <T v="headline" style={{ fontSize: 15, lineHeight: 20 }}>
            {a.action}
          </T>
          <T v="caption" color={colors.t2}>
            {held ? 'Nothing moves until you approve.' : auto ? (paused ? 'Simulation paused — the countdown resumes with it' : `Auto-approves in ${Math.ceil(remainWall)} s unless you hold it`) : 'Needs your explicit approval'}
          </T>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        {!held && auto ? <Button label={busy === 'hold' ? 'Holding…' : 'Hold'} icon={Hand} flex disabled={busy !== null || offline} haptics="none" onPress={() => void run('hold')} /> : null}
        <Button label={busy === 'approve' ? 'Approving…' : 'Approve'} icon={ShieldCheck} variant="primary" flex disabled={busy !== null || offline} haptics="none" onPress={() => void run('approve')} />
      </View>

      {a.steps.length > 0 && (
        <View style={{ paddingTop: 2 }}>
          <PressableScale onPress={() => setSteps((x) => !x)} scaleTo={0.98} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 2 }}>
            <T v="caption" color={colors.t2}>
              {steps ? 'Hide plan' : `Show plan · ${a.steps.length} steps`}
            </T>
            <View style={{ transform: [{ rotate: steps ? '180deg' : '0deg' }] }}>
              <ChevronDown size={13} color={colors.t3} />
            </View>
          </PressableScale>
          {steps && (
            <Animated.View entering={FadeIn.duration(160)} style={{ gap: 6, paddingTop: 8 }}>
              {a.steps.map((st, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
                  <T v="monoSmall" color={colors.t4} style={{ width: 14 }}>
                    {i + 1}
                  </T>
                  <T v="callout" color={colors.t2} style={{ flex: 1, fontSize: 12.5, lineHeight: 17 }}>
                    {st}
                  </T>
                </View>
              ))}
            </Animated.View>
          )}
        </View>
      )}
      {offline ? (
        <T v="caption" color={colors.warning}>
          Commands are unavailable until the link to the backend recovers.
        </T>
      ) : null}
      {err ? (
        <T v="caption" color={colors.critical}>
          {err}
        </T>
      ) : null}
    </Animated.View>
  );
}
