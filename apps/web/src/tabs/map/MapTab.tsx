import { useEffect } from 'react';
import { useMapCamera } from '@loopkeeper/scene';
import { bindNavEvents, controlActions, navActions, useControl, useNav } from '@loopkeeper/core/control';
import { useWorld } from '@loopkeeper/core/store';
import { RobotFleetDrawer } from './RobotFleetDrawer';
import { RobotInspector } from './RobotInspector';
import { ControlHUD } from './ControlHUD';
import { MapPresets } from './MapPresets';
import { MapLayers } from './MapLayers';
import { useDriveController } from './useDriveController';
import { useStageInsetsProbe } from './stageInsets';

/**
 * Crusoe Cooler System Map Tab: Controllable, physically coherent spatial interface
 * supporting both virtual robot classes (INPIPE Crawler & OUTRIG Exterior Rover)
 * with First-Person (Robot POV), Third-Person (Chase, Orbit, Cutaway), and Tactical views.
 */
export function MapTab() {
  const active = useMapCamera((s) => s.active);
  const setActive = useMapCamera((s) => s.setActive);
  const immersive = useMapCamera((s) => s.immersiveHud);
  const toggleImmersive = useMapCamera((s) => s.toggleImmersiveHud);

  // Activate map camera rig on mount, restore on unmount
  useEffect(() => {
    setActive(true);
    return () => {
      setActive(false);
      const ctl = useControl.getState();
      if (ctl.state === 'MANUAL_DRIVING' || ctl.state === 'MANUAL_ARMED') {
        controlActions.safeStop('client_hidden');
      }
    };
  }, [setActive]);

  // V12 navigation: route / traffic events from the live stream, and the published graphs (for the road name and destination nodes)
  const live = useWorld((s) => s.connection === 'live');
  const graphStale = useNav((s) => s.graphStale);
  useEffect(() => bindNavEvents(), []);
  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // load what is missing; a failed read (slow host, backend restart) is retried with backoff instead of leaving the map without graphs
    const tick = async (delay: number) => {
      const g = useNav.getState().graphs;
      const want = (['exterior', 'interior'] as const).filter((k) => !g[k] || useNav.getState().graphStale);
      if (!want.length || stop) return;
      await Promise.all(want.map((k) => navActions.loadGraph(k)));
      const left = (['exterior', 'interior'] as const).some((k) => !useNav.getState().graphs[k]);
      if (left && !stop) timer = setTimeout(() => void tick(Math.min(delay * 2, 15000)), delay);
    };
    void tick(2000);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [live, graphStale]);
  useEffect(() => () => navActions.dismiss(), []);
  useStageInsetsProbe();
  // verification seam (only with ?e2e in the URL): the control session's transitions, so a browser test can say WHY a session ended
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('e2e')) return;
    const log: Array<{ t: number; state: string; stop?: string; notice?: string; linkOk: boolean }> = [];
    (window as unknown as { __lkControlLog: typeof log }).__lkControlLog = log;
    return useControl.subscribe((s, p) => {
      if (s.state !== p.state || s.stop !== p.stop || s.notice !== p.notice) log.push({ t: Math.round(performance.now()), state: s.state, stop: s.stop?.reason, notice: s.notice?.text, linkOk: s.linkOk });
    });
  }, []);

  // Game-style drive controls, camera switching, tool triggers, and blur safe-stop
  useDriveController(true);

  return (
    <div
      className="map-tab-container"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {/* Left Drawer: Robot Class Selection + Fleet List + Authoritative Mini-Map */}
      <div
        className="map-leftcol"
        style={{
          position: 'absolute',
          zIndex: 20,
          top: 64,
          left: 12,
          bottom: 24,
          pointerEvents: 'none',
          display: 'flex',
        }}
      >
        <div style={{ pointerEvents: 'auto', display: 'flex', height: '100%' }}>
          <RobotFleetDrawer collapsed={immersive} onToggleCollapse={toggleImmersive} />
        </div>
      </div>

      <MapPresets>
        <MapLayers />
      </MapPresets>

      {/* Floating Control HUD: Mode Switcher, Reticle, Driving Telemetry & Key Hints */}
      <div className="map-hudwrap" style={{ position: 'absolute', inset: 0, zIndex: 25, pointerEvents: 'none' }}>
        <ControlHUD immersive={immersive} onToggleImmersive={toggleImmersive} />
      </div>

      {/* Right Drawer: Active Robot Inspector, Lease Status, Live Telemetry & Actuators */}
      <div
        className="map-rightcol"
        style={{
          position: 'absolute',
          zIndex: 20,
          top: 64,
          right: 12,
          bottom: 24,
          pointerEvents: 'none',
          display: 'flex',
        }}
      >
        <div style={{ pointerEvents: 'auto', display: 'flex', height: '100%' }}>
          <RobotInspector collapsed={immersive} onToggleCollapse={toggleImmersive} />
        </div>
      </div>
    </div>
  );
}
