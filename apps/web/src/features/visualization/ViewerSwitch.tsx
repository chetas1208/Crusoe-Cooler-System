import { MODE_LABEL, VIEWER_MODES, useViewerMode, type ViewerMode } from './viewerMode';
import { REMOTE_RENDERER } from './capability';
import './visualization.css';

const SUB: Record<ViewerMode, string> = {
  AUTO: 'Chooses from device capability and measured frame rate',
  LOCAL_3D: 'Full-quality WebGL',
  LOCAL_LITE_3D: 'WebGL at the performance tier',
  TACTICAL_2D: 'Plan view, no GPU needed',
  STREAMED_VIDEO: 'Server-rendered video',
};

/** Viewer mode picker (radiogroup). Choosing a mode never touches run, selection, filters or camera state. */
export function ViewerSwitch({ onPick }: { onPick?: () => void }) {
  const pref = useViewerMode((s) => s.preference);
  const eff = useViewerMode((s) => s.effective);
  const reason = useViewerMode((s) => s.reason);
  const set = useViewerMode((s) => s.setPreference);
  return (
    <div className="viewer-switch" role="radiogroup" aria-label="Spatial view mode" data-testid="viewer-switch">
      {VIEWER_MODES.map((m) => {
        const disabled = m === 'STREAMED_VIDEO' && !REMOTE_RENDERER.available;
        return (
          <button
            key={m}
            className="viewer-switch__item"
            role="radio"
            aria-checked={pref === m}
            aria-disabled={disabled}
            data-mode={m}
            onClick={() => {
              if (disabled) return;
              set(m);
              onPick?.();
            }}
          >
            <span>
              <span className="viewer-switch__t">{MODE_LABEL[m]}{pref === 'AUTO' && m === 'AUTO' ? ` → ${MODE_LABEL[eff]}` : ''}</span>
              <span className="viewer-switch__s" style={{ display: 'block' }}>{disabled ? REMOTE_RENDERER.reason : SUB[m]}</span>
            </span>
          </button>
        );
      })}
      <div className="viewer-switch__s" aria-live="polite">{reason}</div>
    </div>
  );
}
