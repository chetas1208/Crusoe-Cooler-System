import { useCallback, useEffect } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { OVERVIEW_VIEW, useView } from '@loopkeeper/scene';
import { flyTo } from '../../ui/EntityIds';
import { refitActivePreset, resetPreset } from '../../ui/presets';

/**
 * Frame the whole facility in the canvas area that no dashboard panel covers.
 * Re-fits on mount and whenever the window or the panels change size, but only while the operator has not
 * picked something to look at or taken the camera themselves.
 */
/** the facility occupies ~85 % of the limiting dimension of the free central region */
export const FIT_FILL = OVERVIEW_VIEW.fill;

export function useOverviewFit() {
  const fit = useCallback(() => {
    if (!useWorld.getState().topology) return;
    refitActivePreset();
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = useView.getState();
        if (!v.selectedId && !v.followRobotId) fit();
      }, 120);
    };
    // first fit once the panels have laid out; a selection made in another tab is flown to, not forgotten
    resetPreset();
    const first = setTimeout(() => {
      const sel = useView.getState().selectedId;
      if (sel) flyTo(sel);
      else fit();
    }, 60);
    window.addEventListener('resize', run);
    const refit = () => setTimeout(fit, 30);
    window.addEventListener('lk-refit', refit);
    const ro = new ResizeObserver(run);
    document.querySelectorAll('.dash [data-inset]').forEach((el) => ro.observe(el));
    return () => {
      clearTimeout(first);
      clearTimeout(t);
      window.removeEventListener('resize', run);
      window.removeEventListener('lk-refit', refit);
      ro.disconnect();
    };
  }, [fit]);
  return fit;
}
