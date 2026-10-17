import { LiveTransport, type Transport } from '@loopkeeper/core/client';

const API_KEY = 'lk.api';
/** Hosts a runtime `?api=` link may point the app at. Anything else is ignored (a crafted link must not capture the token). */
const ALLOWED_RUNTIME_HOSTS = [
  /\.trycloudflare\.com$/i,
  /\.vercel\.app$/i,
  /\.ngrok-free\.app$/i,
  /\.ngrok\.io$/i,
  /\.railway\.app$/i,
  /\.fly\.dev$/i,
  /\.onrender\.com$/i,
  /\.run\.app$/i,
  /^localhost$/i,
  /^127\.0\.0\.1$/
];

function runtimeApiUrl(): string | undefined {
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q === 'reset') {
      localStorage.removeItem(API_KEY);
    } else if (q) {
      const u = new URL(q);
      const isCurrentHost = u.hostname === location.hostname;
      const okHost = isCurrentHost || ALLOWED_RUNTIME_HOSTS.some((re) => re.test(u.hostname));
      const okScheme = u.protocol === 'https:' || u.protocol === 'http:';
      if (okHost && okScheme) localStorage.setItem(API_KEY, u.origin);
    }
    if (q) {
      const clean = new URL(location.href);
      clean.searchParams.delete('api');
      history.replaceState(null, '', clean.toString());
    }
    return localStorage.getItem(API_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Optional default backend URL for hosted builds (set VITE_DEFAULT_API_URL at build time; empty = ask the user). */
export const DEFAULT_LIVE_TUNNEL: string = (import.meta.env.VITE_DEFAULT_API_URL as string | undefined) ?? '';

/**
 * Pick the data source:
 *  - Explicit ?api= or remembered runtime URL takes precedence
 *  - Remote clients on Vercel default to the active live tunnel if no explicit backend is set
 *  - Direct tunnel access routes through window.location.origin (Vite proxy)
 *  - VITE_API_URL set (build time) -> real REST + WebSocket backend
 *  - otherwise -> the deterministic simulator running inside the page
 */
export async function createTransport(forceMock = false): Promise<Transport> {
  if (forceMock) {
    const { EmbeddedTransport } = await import('@loopkeeper/core/engine');
    const seed = Number(new URLSearchParams(location.search).get('seed') ?? 8);
    const t = new EmbeddedTransport({ seed, speed: Number(new URLSearchParams(location.search).get('speed') ?? 6) });
    if (import.meta.env.DEV) (window as unknown as { __engine: unknown }).__engine = t.engine;
    return t;
  }

  const runtime = runtimeApiUrl();
  if (runtime) return new LiveTransport(runtime, 'lab_01', 'Live backend (tunnel)');

  const envUrl = import.meta.env.VITE_API_URL as string | undefined;
  const isTunnelOrigin = typeof window !== 'undefined' && window.location.hostname.endsWith('.trycloudflare.com');
  const isVercel = typeof window !== 'undefined' && window.location.hostname.endsWith('.vercel.app');

  let effectiveUrl = envUrl;
  if (isTunnelOrigin) {
    // Accessed directly through the Cloudflare tunnel: origin is proxied to port 8787
    effectiveUrl = window.location.origin;
  } else if (isVercel && (!envUrl || envUrl.includes('localhost') || envUrl.includes('127.0.0.1'))) {
    // On Vercel, default to the active live tunnel if no explicit URL is configured
    effectiveUrl = DEFAULT_LIVE_TUNNEL;
  }

  if (effectiveUrl) return new LiveTransport(effectiveUrl, 'lab_01', 'Live backend');
  const { EmbeddedTransport } = await import('@loopkeeper/core/engine');
  const seed = Number(new URLSearchParams(location.search).get('seed') ?? 8);
  const t = new EmbeddedTransport({ seed, speed: Number(new URLSearchParams(location.search).get('speed') ?? 6) });
  if (import.meta.env.DEV) (window as unknown as { __engine: unknown }).__engine = t.engine;
  return t;
}
