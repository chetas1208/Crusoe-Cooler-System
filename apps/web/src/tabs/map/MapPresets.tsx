import { useEffect, useState } from 'react';
import { useMapCamera } from '@loopkeeper/scene';
import { PresetBar } from '../../ui/PresetBar';
import { flyTo } from '../../ui/EntityIds';
import { refitActivePreset, resetPreset } from '../../ui/presets';
import { useView } from '@loopkeeper/scene';
import { useStageInsets } from './stageInsets';

/**
 * Bottom dock of the Map tab: layer toggles are stacked above the camera presets in ONE `data-inset="bottom"` box,
 * so the camera rig and every preset fit keep the building clear of it.
 */
export function MapPresets({ children }: { children?: React.ReactNode }) {
  const mode = useMapCamera((s) => s.cameraMode);
  const stageLeft = useStageInsets((s) => s.left);
  // collapsed by default: the bottom-centre of the stage belongs to the robot control HUD, so this dock lives top-left
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('lk.mapdock') === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem('lk.mapdock', o ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !o;
    });
  // entering the tab: whole facility again (or the entity selected elsewhere); re-solve the preset when the window changes
  useEffect(() => {
    resetPreset();
    const t = setTimeout(() => {
      const sel = useView.getState().selectedId;
      if (sel && !useView.getState().followRobotId) flyTo(sel);
      else refitActivePreset();
    }, 120);
    let rt: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(refitActivePreset, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      clearTimeout(rt);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  if (mode !== 'tactical') return null;      // in first person the bottom strip belongs to the camera-slot buttons (front/rear/left/right/top); the dock used to cover them
  return (
    <div
      className="map-dock panel"
      data-panel="map-view"
      data-inset={open ? 'top' : undefined}
      style={{ position: 'absolute', left: stageLeft + 12, top: 64, zIndex: open ? 40 : 24, display: 'flex', flexDirection: 'column', gap: 6, padding: 8, maxWidth: 'min(640px, calc(100vw - 24px))' }}
    >
      <button
        type="button"
        className="btn btn--sm"
        aria-expanded={open}
        aria-controls="map-view-controls"
        onClick={toggle}
        title="Camera presets and layer toggles"
        style={{ alignSelf: 'flex-start', minHeight: 32, whiteSpace: 'nowrap' }}
      >
        View {open ? '▴' : '▾'}
      </button>
      {open && (
        <div id="map-view-controls" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {children}
          <PresetBar />
        </div>
      )}
    </div>
  );
}
