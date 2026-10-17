/**
 * Bearer-token credentials for the live backend.
 *
 * The token is typed in by the operator and kept in this browser only (localStorage, in-memory fallback).
 * It is never baked into the bundle: anything in a public bundle is not a secret.
 * Every request goes through `authFetch`; a 401 flips `authRequired` so the UI can ask for a token.
 */
const KEY = 'lk.token';
let memory: string | null = null;
let required = false;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  return memory ?? readStored();
}

export function setAuthToken(token: string | null) {
  memory = token && token.trim() ? token.trim() : null;
  try {
    if (memory) globalThis.localStorage?.setItem(KEY, memory);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* private mode: keep it in memory only */
  }
  setRequired(false);
}

function setRequired(v: boolean) {
  if (required === v) return;
  required = v;
  listeners.forEach((l) => l());
}

export function isAuthRequired() {
  return required;
}

export function subscribeAuth(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** fetch + `Authorization: Bearer …` when a token is set; a 401/403-on-auth marks the session as needing a token. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) setRequired(true);
  return res;
}

/** WebSocket subprotocols carrying the token (never in the URL: URLs end up in logs). */
export function wsProtocols(): string[] | undefined {
  const token = getAuthToken();
  return token ? ['loopkeeper.v1', `bearer.${token}`] : undefined;
}
