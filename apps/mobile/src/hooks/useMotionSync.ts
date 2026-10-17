import { useEffect } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useView } from '@loopkeeper/scene';

/** Mirrors the OS "Reduce Motion" setting into the shared scene (shorter camera glides, no cinematic eases). */
export function useMotionSync() {
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && useView.getState().setReducedMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => useView.getState().setReducedMotion(v));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
}
