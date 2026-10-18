import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { usePreviewDrive } from '@loopkeeper/core/store';
import { controlActions, useControl } from '@loopkeeper/core/control';
import { useMapSel } from './store';

const holding = () => {
  const s = useControl.getState().state;
  return s === 'MANUAL_ARMED' || s === 'MANUAL_DRIVING' || s === 'LEASE_REQUESTED';
};

/**
 * Safe-stop rules for the Map tab, enforced here and not left to the screen:
 *  - the app leaves the foreground (inactive/background)   -> safe-stop ('client_hidden'), ghost preview ends
 *  - the operator leaves the Map tab                        -> planned release, ghost preview ends
 *  - the operator selects a different robot                 -> planned release
 *  - unmount                                                -> planned release
 * (Stream loss, a lost lease or an unanswered link are handled by the control session itself.)
 */
export function useDriveSafety() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') return;
      if (holding()) controlActions.safeStop('client_hidden');
      if (usePreviewDrive.getState().active) usePreviewDrive.getState().exitPreview();
    });
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(
      () => () => {
        if (holding()) controlActions.release('operator_release');
        if (usePreviewDrive.getState().active) usePreviewDrive.getState().exitPreview();
      },
      [],
    ),
  );

  useEffect(
    () =>
      useMapSel.subscribe((s, prev) => {
        if (s.selectedId === prev.selectedId) return;
        const robot = useControl.getState().robotId;
        if (holding() && robot && robot !== s.selectedId) controlActions.release('operator_release');
        const p = usePreviewDrive.getState();
        if (p.active && p.robotId !== s.selectedId) p.exitPreview();
      }),
    [],
  );

  useEffect(
    () => () => {
      if (holding()) controlActions.release('operator_release');
      if (usePreviewDrive.getState().active) usePreviewDrive.getState().exitPreview();
    },
    [],
  );
}
