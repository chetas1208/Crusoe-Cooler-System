import { useEffect, useState } from 'react';
import { useCommunications } from '../communications/communicationStore';
import { CommunicationsPanel } from '../communications/CommunicationsPanel';
import { BottomSheet, type SheetState } from './BottomSheet';
import { MobileTabBar } from './MobileTabBar';
import { DriveButtons } from './DriveButtons';
import { usePhoneLayout, useVisualViewportVar } from './phone';
import { ViewerSwitch } from '../visualization/ViewerSwitch';

/** Everything the phone layout adds on top of the unchanged desktop component tree: bottom tab bar + Communications bottom sheet + viewer-mode sheet. */
export function PhoneChrome() {
  const phone = usePhoneLayout();
  useVisualViewportVar();
  const open = useCommunications((s) => s.open);
  const setOpen = useCommunications((s) => s.setOpen);
  const [state, setState] = useState<SheetState>('peek');
  useEffect(() => {
    if (open) setState((s) => (s === 'closed' ? 'peek' : s));
  }, [open]);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    const h = () => setViewerOpen(true);
    window.addEventListener('lk-viewer-mode', h);
    return () => window.removeEventListener('lk-viewer-mode', h);
  }, []);
  if (!phone) return null;
  return (
    <>
      <MobileTabBar />
      <DriveButtons />
      {open && (
        <BottomSheet state={state} onState={setState} title="Communications" onClose={() => setOpen(false)}>
          <CommunicationsPanel variant="sheet" onClose={() => setOpen(false)} />
        </BottomSheet>
      )}
      {viewerOpen && (
        <BottomSheet state="expanded" onState={() => setViewerOpen(false)} title="Spatial view" onClose={() => setViewerOpen(false)}>
          <ViewerSwitch onPick={() => setViewerOpen(false)} />
        </BottomSheet>
      )}
    </>
  );
}
