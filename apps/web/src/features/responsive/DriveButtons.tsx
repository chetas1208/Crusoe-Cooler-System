import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, OctagonX } from 'lucide-react';
import { useControl } from '@loopkeeper/core/control';
import { usePreviewDrive } from '@loopkeeper/core/store';
import { useUi } from '../../ui/store';

/**
 * Thumb drive pad for the Map tab on phones. It does NOT drive anything itself: each press dispatches the same key events the desktop
 * controller listens to (useDriveController), so V9 semantics are identical - Preview Drive moves a local ghost only (no network, no lease),
 * live driving needs an acquired lease (`inputEnabled`), and release / blur / hidden tab / pointer cancel always end in the controller's
 * existing safe-stop path. Pinch / pan on the stage are view controls and never reach this pad.
 */
const KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', brake: 'Space' } as const;

function Hold({ code, label, children, enabled }: { code: string; label: string; children: React.ReactNode; enabled: boolean }) {
  const down = useRef(false);
  const fire = (type: 'keydown' | 'keyup') => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
  const release = () => {
    if (down.current) {
      down.current = false;
      fire('keyup');
    }
  };
  useEffect(() => release, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) release();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button
      className="drivepad__btn"
      data-code={code}
      aria-label={label}
      aria-disabled={!enabled}
      disabled={!enabled}
      onPointerDown={(e) => {
        if (!enabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        down.current = true;
        fire('keydown');
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

export function DriveButtons() {
  const tab = useUi((s) => s.tab);
  const preview = usePreviewDrive((s) => s.active);
  const live = useControl((s) => s.inputEnabled);
  if (tab !== 'map') return null;
  const enabled = preview || live;
  return (
    <div className="drivepad" role="group" aria-label="Drive controls (hold to move)" data-mode={preview ? 'preview' : live ? 'live' : 'off'}>
      <div className="drivepad__status" aria-live="polite">
        {preview ? 'Preview drive: local ghost only, no robot is moved' : live ? 'Live drive: you hold the control lease' : 'Drive off: take control in the robot panel, or start Preview Drive'}
      </div>
      <div className="drivepad__grid">
        <span />
        <Hold code={KEYS.up} label="Forward" enabled={enabled}><ArrowUp size={26} /></Hold>
        <span />
        <Hold code={KEYS.left} label="Turn left" enabled={enabled}><ArrowLeft size={26} /></Hold>
        <Hold code={KEYS.brake} label="Brake" enabled={enabled}><OctagonX size={24} /></Hold>
        <Hold code={KEYS.right} label="Turn right" enabled={enabled}><ArrowRight size={26} /></Hold>
        <span />
        <Hold code={KEYS.down} label="Reverse" enabled={enabled}><ArrowDown size={26} /></Hold>
        <span />
      </div>
    </div>
  );
}
