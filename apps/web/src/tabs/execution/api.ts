import { authFetch } from '@loopkeeper/core/client';
import { activeTransport } from '@loopkeeper/core/store';

/**
 * REST helper for the Execution tab: the backend the app is actually connected to (with the operator token),
 * not a relative URL that only works behind the dev proxy. With the embedded mock there is no backend: base is '' and requests 404 honestly.
 */
export function apiBase(): string {
  const t = activeTransport();
  return `${t?.info.kind === 'live' && t.info.url ? t.info.url.replace(/\/$/, '') : ''}/api/v1`;
}
export const apiFetch = (path: string, init?: RequestInit) => authFetch(`${apiBase()}${path}`, init);
