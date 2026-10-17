import { useEffect } from 'react';
import { useMapCamera } from '@loopkeeper/scene';
import { controlActions, useControl } from '@loopkeeper/core/control';
import { RobotFleetDrawer } from './RobotFleetDrawer';
import { RobotInspector } from './RobotInspector';
import { ControlHUD } from './ControlHUD';
import { MapPresets } from './MapPresets';
import { MapLayers } from './MapLayers';
import { useDriveController } from './useDriveController';

/**
 * LOOPKEEPER Map Tab: Controllable, physically coherent spatial interface
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
      <div style={{ position: 'absolute', inset: 0, zIndex: 25, pointerEvents: 'none' }}>
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
