import { useView, useMapCamera, type Layers } from '@loopkeeper/scene';

const TOGGLES: Array<{ key: keyof Layers | 'xray'; label: string; hint: string }> = [
  { key: 'rows', label: 'Rack rows', hint: 'Rack rows ROW-01..05 (racks, containment, cable trays)' },
  { key: 'roads', label: 'Exterior roads', hint: 'Robot roads ROAD-01..04 and cross-aisles painted on the floor' },
  { key: 'tcs_supply', label: 'TCS supply', hint: 'Technology cooling, supply side' },
  { key: 'tcs_return', label: 'TCS return', hint: 'Technology cooling, return side' },
  { key: 'facility_water', label: 'FWS', hint: 'Facility water loop (plant ↔ CDU primary)' },
  { key: 'robot_access', label: 'Robot access', hint: 'Highlight what robots can reach' },
  { key: 'xray', label: 'X-ray / cutaway', hint: 'Fade walls, floor and servers so the pipework reads' },
];

/** Map layer toggles. View-only. */
export function MapLayers() {
  const layers = useView((s) => s.layers);
  const xray = useView((s) => s.xray);
  const mode = useMapCamera((s) => s.cameraMode);
  if (mode !== 'tactical') return null;
  return (
    <div className="map-layers" role="group" aria-label="Map layers" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
      {TOGGLES.map((t) => {
        const on = t.key === 'xray' ? xray : layers[t.key];
        return (
          <button
            key={t.key}
            className={`btn btn--sm ${on ? 'btn--primary' : 'btn--ghost'}`}
            title={t.hint}
            aria-pressed={on}
            style={{ whiteSpace: 'nowrap', fontSize: 10.5 }}
            onClick={() => (t.key === 'xray' ? useView.getState().toggleXray() : useView.getState().setLayer(t.key, !layers[t.key]))}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
