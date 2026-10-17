import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react';
import { useViewerMode, applyModeQuality } from './viewerMode';
import { Tactical2D } from './Tactical2D';
import { useView } from '@loopkeeper/scene';
import './visualization.css';

/** three, R3F, drei and the whole scene live behind this dynamic import: the shell (tabs, run picker, incidents, comms, scenarios) paints without them. */
const Viewport3D = lazy(() => import('../../ui/Viewport').then((m) => ({ default: m.Viewport })));

class ViewerBoundary extends Component<{ onError: (msg: string) => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(err: unknown) {
    this.props.onError(`The 3D viewer failed to load or crashed (${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}).`);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ViewerPlaceholder() {
  return (
    <div className="viewer-placeholder" data-testid="viewer-placeholder" aria-busy="true">
      <div>
        <div className="viewer-placeholder__ring" />
        Loading 3D view…
      </div>
    </div>
  );
}

/** Explains (once) why the spatial view is not the full 3D one, with a way back. Never blocks anything. */
function ViewerNotice() {
  const failure = useViewerMode((s) => s.failure);
  const retry = useViewerMode((s) => s.retry);
  if (!failure) return null;
  return (
    <div className="viewer-notice panel" role="status" data-testid="viewer-notice">
      <span>{failure} Showing the Tactical 2D plan; all controls still work.</span>
      <button onClick={retry}>Try 3D again</button>
    </div>
  );
}

export function ViewerHost() {
  const mode = useViewerMode((s) => s.effective);
  const fail = useViewerMode((s) => s.fail);
  useEffect(() => {
    applyModeQuality(mode);
    document.documentElement.dataset.viewer = mode;
    return () => {
      delete document.documentElement.dataset.viewer;
    };
  }, [mode]);
  // leaving the 3D view must not leave a stale camera-follow / pipe cockpit pointing at a renderer that no longer exists
  useEffect(() => {
    if (mode === 'TACTICAL_2D') {
      const v = useView.getState();
      if (v.mode === 'pipe') v.exitPipe();
    }
  }, [mode]);
  return (
    <>
      {mode === 'TACTICAL_2D' ? (
        <Tactical2D />
      ) : (
        <ViewerBoundary key={mode} onError={fail}>
          <Suspense fallback={<ViewerPlaceholder />}>
            <Viewport3D />
          </Suspense>
        </ViewerBoundary>
      )}
      <ViewerNotice />
    </>
  );
}
