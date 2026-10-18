import { authFetch } from '@loopkeeper/core/client';
import { resolveApiUrl } from './api';

export type Got<T = unknown> = { status: 'ok'; json: T } | { status: 'unavailable' } | { status: 'error'; message: string };

export const apiBase = () => `${resolveApiUrl()}/api/v1`;

/** GET a JSON resource. 404/501 mean "this backend does not serve that" (nothing is invented in its place). */
export async function getJson<T = unknown>(path: string): Promise<Got<T>> {
  try {
    const r = await authFetch(`${apiBase()}${path}`, { headers: { Accept: 'application/json' } });
    if (r.status === 404 || r.status === 501) return { status: 'unavailable' };
    if (!r.ok) return { status: 'error', message: `HTTP ${r.status}` };
    return { status: 'ok', json: (await r.json()) as T };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function postJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Got<T> & { httpStatus?: number }> {
  try {
    const r = await authFetch(`${apiBase()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = (await r.json()) as { error?: { message?: string }; detail?: unknown };
        msg = j.error?.message ?? (typeof j.detail === 'string' ? j.detail : msg);
      } catch {
        /* non-JSON error body */
      }
      return { status: 'error', message: msg, httpStatus: r.status };
    }
    return { status: 'ok', json: (await r.json()) as T };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
