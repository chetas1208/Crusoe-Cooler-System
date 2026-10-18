import { View } from 'react-native';
import { Eye, Hand, Lightbulb, Radar, OctagonAlert } from 'lucide-react-native';
import { usePreviewDrive } from '@loopkeeper/core/store';
import { controlActions, useControl, type UiControlState } from '@loopkeeper/core/control';
import type { Robot } from '@loopkeeper/core/contracts';
import { ROBOT_MODE_LABEL, labelOfId } from '@loopkeeper/core';
import { alpha, colors, type Tone } from '@/theme';
import { haptic } from '@/lib/haptics';
import { useLinkStatus } from '@/hooks/useConnection';
import { Button, Chip, Segmented, T } from '@/components/ui';
import { DPad, type PadInput } from './DPad';
import { useMapSel } from './store';

const STATE_LABEL: Record<UiControlState, { label: string; tone: Tone }> = {
  AUTONOMOUS: { label: 'AUTONOMOUS', tone: 'nominal' },
  LEASE_REQUESTED: { label: 'REQUESTING LEASE', tone: 'watch' },
  MANUAL_ARMED: { label: 'MANUAL · ARMED', tone: 'warning' },
  MANUAL_DRIVING: { label: 'MANUAL · DRIVING', tone: 'warning' },
  SAFE_STOP: { label: 'SAFE STOP', tone: 'critical' },
  RELEASE_PENDING: { label: 'RELEASING', tone: 'watch' },
  SAFE_HOLD: { label: 'SAFE HOLD', tone: 'critical' },
};

function Banner({ tone, title, body }: { tone: string; title: string; body: string }) {
  return (
    <View style={{ gap: 4, padding: 12, borderRadius: 14, backgroundColor: alpha(tone, 0.09), borderWidth: 1, borderColor: alpha(tone, 0.34) }}>
      <T v="eyebrow" color={tone} style={{ fontSize: 10 }}>
        {title}
      </T>
      <T v="caption" color={colors.t2} style={{ lineHeight: 17 }}>
        {body}
      </T>
    </View>
  );
}

function Readout({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T v="eyebrow" style={{ fontSize: 9 }}>
        {k}
      </T>
      <T v="mono" numberOfLines={1}>
        {v}
      </T>
    </View>
  );
}

/**
 * Preview vs live, stated on screen:
 *  - PREVIEW: a local ghost. No network call, no lease, the simulation is unchanged.
 *  - LIVE: a server-granted lease. Input is enabled only after the lease is granted; intents go out at <= 15 Hz; releasing,
 *    backgrounding the app, leaving the tab or losing the link zeroes the input and safe-stops (handled by useDriveSafety).
 */
export function ControlSurface({ robot }: { robot: Robot }) {
  const mode = useMapSel((s) => s.mode);
  const setMode = useMapSel((s) => s.setMode);
  const link = useLinkStatus();
  const ctl = useControl();
  const preview = usePreviewDrive();
  const mine = ctl.robotId === robot.id;
  const state: UiControlState = mine ? ctl.state : 'AUTONOMOUS';
  const st = STATE_LABEL[state];
  const control = robot.control;
  const controllable = control?.controllable !== false;
  const holdingElsewhere = !mine && ctl.robotId !== null && ctl.state !== 'AUTONOMOUS';
  const previewOn = preview.active && preview.robotId === robot.id;
  const tone = mode === 'preview' ? colors.watch : colors.warning;

  const switchMode = (m: 'preview' | 'live') => {
    if (m === mode) return;
    if (m === 'preview' && mine && (ctl.state === 'MANUAL_ARMED' || ctl.state === 'MANUAL_DRIVING' || ctl.state === 'LEASE_REQUESTED')) controlActions.release('operator_release');
    if (m === 'live' && preview.active) preview.exitPreview();
    setMode(m);
  };

  const startPreview = () => {
    const p = robot.pose;
    haptic.select();
    preview.startPreview(robot.id, robot.class, { position_xyz_m: p.position_xyz_m, yaw_rad: p.yaw_rad, segment_id: p.segment_id, s_m: p.s_m, speed_m_s: 0 });
  };

  const onPreviewInput = (v: PadInput, dt: number) => {
    if (usePreviewDrive.getState().active) usePreviewDrive.getState().updateGhostInput(v, dt);
  };
  const onLiveInput = (v: PadInput) => {
    if (useControl.getState().inputEnabled) controlActions.setInput('touch', v);
  };

  const inputEnabled = mine && ctl.inputEnabled;
  const manual = mine && (ctl.state === 'MANUAL_ARMED' || ctl.state === 'MANUAL_DRIVING');
  const canTake = !manual && state !== 'LEASE_REQUESTED' && state !== 'RELEASE_PENDING' && controllable && !link.degraded && !holdingElsewhere;
  const lampOn = control?.lamp ?? false;

  return (
    <View style={{ gap: 12, padding: 14, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.045)', borderWidth: 1, borderColor: alpha(tone, 0.35) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T v="headline" style={{ fontSize: 17 }}>
          {labelOfId(robot.id)}
        </T>
        <Chip sm tone={robot.class === 'inpipe' ? 'inpipe' : 'outrig'}>
          {robot.class === 'inpipe' ? 'internal' : 'external'}
        </Chip>
        <Chip sm tone="neutral">
          {ROBOT_MODE_LABEL[robot.mode]}
        </Chip>
        <T v="mono" color={colors.t2} style={{ marginLeft: 'auto' }}>
          {Math.round(robot.battery_pct)}%
        </T>
      </View>

      <Segmented<'preview' | 'live'>
        value={mode}
        onChange={switchMode}
        items={[
          { id: 'preview', label: 'Preview (ghost)' },
          { id: 'live', label: 'Live control' },
        ]}
      />

      {mode === 'preview' ? (
        <>
          <Banner tone={colors.watch} title="GHOST PREVIEW · LOCAL ONLY" body="Nothing is sent to the robot. No lease is taken and the simulation does not change. The dashed marker on the map is yours alone." />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {previewOn ? <Button label="Exit preview" icon={Eye} flex onPress={() => preview.exitPreview()} /> : <Button label="Start preview" icon={Eye} variant="tone" tone="watch" flex onPress={startPreview} />}
          </View>
          {robot.class === 'inpipe' && !robot.pose.segment_id ? (
            <T v="caption" color={colors.t3}>
              This crawler is not inside a pipe segment right now (it reports no segment position), so a ghost drive has nothing to move along.
            </T>
          ) : null}
          <DPad disabled={!previewOn} tone={colors.watch} onInput={onPreviewInput} steerLabel={robot.class === 'inpipe' ? 'Branch' : 'Steer'} />
          {previewOn ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Readout k="Ghost travelled" v={`${preview.distanceTraveledM.toFixed(1)} m`} />
              <Readout k="Ghost speed" v={`${(preview.ghostPose?.speed_m_s ?? 0).toFixed(2)} m/s`} />
              <Readout k="Robot" v="unchanged" />
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Banner tone={colors.warning} title="LIVE CONTROL · LEASE-BASED" body="Taking control asks the backend for an exclusive lease on this robot and pauses its agent mission. Input is enabled only once the lease is granted. Leaving this tab, backgrounding the app or losing the link releases and safe-stops it." />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Chip tone={st.tone}>{st.label}</Chip>
            {control ? (
              <Chip sm tone="neutral" mono>
                server: {control.authority} · {control.controller_state}
              </Chip>
            ) : null}
            {mine && ctl.leaseId ? (
              <Chip sm tone="neutral" mono>
                epoch {ctl.epoch}
              </Chip>
            ) : null}
          </View>
          {!controllable ? (
            <T v="caption" color={colors.warning}>
              Not controllable: {control?.uncontrollable_reason ?? 'the backend marks this robot as not controllable'}.
            </T>
          ) : null}
          {holdingElsewhere ? (
            <T v="caption" color={colors.warning}>
              You are controlling {ctl.robotId ? labelOfId(ctl.robotId) : 'another robot'}; release it first.
            </T>
          ) : null}
          {link.degraded ? (
            <T v="caption" color={colors.warning}>
              Link is {link.label.toLowerCase()}: control cannot be granted until the live stream is back.
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {manual ? (
              <>
                <Button label="Release" icon={Hand} flex onPress={() => (haptic.medium(), controlActions.release('operator_release'))} />
                <Button label="Safe stop" icon={OctagonAlert} variant="tone" tone="critical" flex haptics="medium" onPress={() => controlActions.safeStop('operator_stop')} />
              </>
            ) : state === 'LEASE_REQUESTED' ? (
              <Button label="Cancel request" flex onPress={() => controlActions.release('operator_release')} />
            ) : state === 'RELEASE_PENDING' ? (
              <Button label="Releasing…" flex disabled />
            ) : (
              <Button
                label={state === 'SAFE_STOP' || state === 'SAFE_HOLD' ? 'Take control again' : 'Take control'}
                icon={Hand}
                variant="tone"
                tone="warning"
                flex
                disabled={!canTake}
                haptics="medium"
                onPress={() => {
                  controlActions.dismiss();
                  void controlActions.takeControl(robot.id);
                }}
              />
            )}
          </View>
          <DPad disabled={!inputEnabled} tone={colors.warning} onInput={onLiveInput} steerLabel={robot.class === 'inpipe' ? 'Branch' : 'Steer'} />
          {robot.class === 'inpipe' ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button label={lampOn ? 'Lamp off' : 'Lamp on'} icon={Lightbulb} size="sm" flex disabled={!inputEnabled} onPress={() => controlActions.tool(lampOn ? 'lamp_off' : 'lamp_on')} />
              <Button label="Wall scan" icon={Radar} size="sm" flex disabled={!inputEnabled} onPress={() => controlActions.tool('scan')} />
            </View>
          ) : null}
          {mine && (manual || ctl.ack) ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Readout k="Velocity" v={`${(ctl.ack?.pose.velocity_m_s ?? 0).toFixed(2)} m/s`} />
              <Readout k="Position" v={ctl.ack?.pose.segment_id ? `${ctl.ack.pose.segment_id} @ ${ctl.ack.pose.s_m.toFixed(1)} m` : '—'} />
              <Readout k="Link RTT" v={ctl.rttMs === null ? '—' : `${Math.round(ctl.rttMs)} ms`} />
            </View>
          ) : null}
          {mine && ctl.stop ? (
            <T v="caption" color={colors.critical}>
              Stopped: {ctl.stop.text}
            </T>
          ) : null}
          {ctl.notice ? (
            <T v="caption" color={ctl.notice.tone === 'error' ? colors.critical : ctl.notice.tone === 'warn' ? colors.warning : colors.t2}>
              {ctl.notice.text}
            </T>
          ) : null}
        </>
      )}
    </View>
  );
}
