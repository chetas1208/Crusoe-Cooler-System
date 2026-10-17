import { useEffect } from 'react';
import { AppState } from 'react-native';
import { LiveTransport } from '@loopkeeper/core/client';
import { startWorld, stopWorld, useWorld } from '@loopkeeper/core/store';
import { resolveApiUrl } from '@/lib/api';

/**
 * Boots the world store against the backend and keeps retrying while it is unreachable,
 * so a late-starting server (or one that restarts) never leaves the app stuck on an error.
 * Everything downstream reads `useWorld().phase / connection / stale` — nothing is faked.
 */
export function useWorldBootstrap() {
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const url = resolveApiUrl();

    const boot = async () => {
      if (cancelled) return;
      await startWorld(new LiveTransport(url, 'lab_01', url));
      if (cancelled) return;
      if (useWorld.getState().phase === 'error') retry = setTimeout(boot, 2500);
    };
    void boot();

    // coming back from the background: resync from a fresh snapshot instead of trusting a sleeping socket
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && !cancelled) {
        const st = useWorld.getState();
        if (st.phase === 'error' || st.connection === 'offline') {
          if (retry) clearTimeout(retry);
          void boot();
        }
      }
    });

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      sub.remove();
      stopWorld();
    };
  }, []);
}
