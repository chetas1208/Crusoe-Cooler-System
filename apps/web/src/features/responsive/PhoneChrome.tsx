import { useEffect, useState } from 'react';
import { BottomSheet } from './BottomSheet';
import { MobileTabBar } from './MobileTabBar';
import { DriveButtons } from './DriveButtons';
import { PanelsHost } from './PanelsHost';
import { useLayoutMode } from './layout';
import { useVisualViewportVar } from './phone';
import { ViewerSwitch } from '../visualization/ViewerSwitch';

/**
 * Everything the layout model adds on top of the component tree: the panel host (dock / drawer / sheet, every layout), and for the
 * compact chrome the tab bar (a bottom bar in portrait, a left rail in landscape), the drive pad and the viewer-mode sheet.
 */
export function PhoneChrome() {
  const { compact } = useLayoutMode();
  useVisualViewportVar();
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    const h = () => setViewerOpen(true);
    window.addEventListener('lk-viewer-mode', h);
    return () => window.removeEventListener('lk-viewer-mode', h);
  }, []);
  return (
    <>
      {compact && <MobileTabBar />}
      {compact && <DriveButtons />}
      <PanelsHost />
      {compact && viewerOpen && (
        <BottomSheet state="expanded" onState={() => setViewerOpen(false)} title="Spatial view" onClose={() => setViewerOpen(false)} className="sheet--viewer">
          <ViewerSwitch onPick={() => setViewerOpen(false)} />
        </BottomSheet>
      )}
    </>
  );
}
