import { useEffect } from 'react';
import { setInterest, getInterest, getLastInterestReply } from '@loopkeeper/core/client';
import { useControl } from '@loopkeeper/core/control';
import { useMapCamera, useView } from '@loopkeeper/scene';
import { useUi } from '../ui/store';

/**
 * Keeps the server informed about what this browser is looking at (selected entity, camera mode, visible zones when tiles are
 * streaming). Only sent when it changes, debounced, and ignored by servers that do not implement it.
 */
export function useInterest() {
  useEffect(() => {
    const compute = () => {
      const ui = useUi.getState();
      const v = useView.getState();
      const mc = useMapCamera.getState();
      const ctl = useControl.getState();
      const driving = ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED';
      let mode: 'overview' | 'orbit' | 'chase' | 'pov' | 'map' | 'inspect' | 'drive' = 'overview';
      if (ui.tab === 'map') mode = driving ? 'drive' : mc.cameraMode === 'first_person' ? 'pov' : mc.cameraMode === 'third_person' ? (mc.thirdPersonMode === 'orbit' ? 'orbit' : 'chase') : 'map';
      else if (v.selectedId) mode = 'inspect';
      const selected = (ui.tab === 'map' && mc.hasRobot() ? mc.selectedRobotId : v.selectedId) ?? null;
      const zones = (window as unknown as { __lkTiles?: { manager: () => { visibleZones(): string[]; manifest: { manifest_id: string } } | null } }).__lkTiles?.manager();
      setInterest({ camera_mode: mode, selected_entity_id: selected, ...(zones ? { visible_zone_ids: zones.visibleZones(), manifest_id: zones.manifest.manifest_id } : {}), rate_budget: 80 });
    };
    (window as unknown as { __lkInterest?: () => unknown }).__lkInterest = () => ({ sent: getInterest(), reply: getLastInterestReply() });
    compute();
    const offs = [useUi.subscribe(compute), useView.subscribe(compute), useMapCamera.subscribe(compute), useControl.subscribe(compute)];
    const t = setInterval(compute, 1500); // visible zones change with the camera, which is not in a store
    return () => {
      offs.forEach((o) => o());
      clearInterval(t);
    };
  }, []);
}
