import { useEffect } from 'react';
import { useMapCamera } from '@loopkeeper/scene';
import { PresetBar } from '../../ui/PresetBar';
import { flyTo } from '../../ui/EntityIds';
import { refitActivePreset, resetPreset } from '../../ui/presets';
import { useView } from '@loopkeeper/scene';

/**
 * Bottom dock of the Map tab: layer toggles are stacked above the camera presets in ONE `data-inset="bottom"` box,
 * so the camera rig and every preset fit keep the building clear of it.
 */
export function MapPresets({ children }: { children?: React.ReactNode }) {
  const mode = useMapCamera((s) => s.cameraMode);
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
    <div className="map-dock panel" data-inset="bottom" style={{ position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)', zIndex: 26, display: 'flex', flexDirection: 'column', gap: 4, padding: 5, borderRadius: 12, pointerEvents: 'auto', background: 'rgba(15,18,24,0.9)', maxWidth: 'calc(100vw - 660px)' }}>
      {children}
      <PresetBar />
    </div>
  );
}
