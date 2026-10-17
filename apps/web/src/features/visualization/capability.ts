/**
 * Feature detection for the viewer-mode policy. Nothing here looks at the user agent: it asks the browser what it can do
 * (WebGL context, performance caveat, pointer type, viewport, memory hints) and later measures frame time.
 * Device emulation in Playwright is NOT a real mobile GPU; see docs/engineering/V10_MOBILE_TEST_REPORT.md.
 */
export type WebglKind = 'hardware' | 'software' | 'none';

export interface Capabilities {
  webgl: WebglKind;
  renderer: string | null;
  maxTextureSize: number | null;
  coarsePointer: boolean;
  anyHover: boolean;
  /** shortest side of the screen in CSS px */
  screenMinPx: number;
  deviceMemoryGB: number | null;
  cores: number | null;
  saveData: boolean;
  reducedMotion: boolean;
  dpr: number;
}

function probeWebgl(): Pick<Capabilities, 'webgl' | 'renderer' | 'maxTextureSize'> {
  const tryCtx = (failIfMajorPerformanceCaveat: boolean) => {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2', { failIfMajorPerformanceCaveat }) || c.getContext('webgl', { failIfMajorPerformanceCaveat })) as WebGLRenderingContext | null;
    return gl;
  };
  const describe = (gl: WebGLRenderingContext) => {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null, maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) };
    // give the context back immediately: probing must not eat one of the browser's few WebGL contexts
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  };
  try {
    const hw = tryCtx(true);
    if (hw) return { webgl: 'hardware', ...describe(hw) };
    const sw = tryCtx(false);
    if (sw) return { webgl: 'software', ...describe(sw) };
  } catch {
    /* fall through */
  }
  return { webgl: 'none', renderer: null, maxTextureSize: null };
}

let cached: Capabilities | null = null;
export function detectCapabilities(force = false): Capabilities {
  if (cached && !force) return cached;
  const mm = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  cached = {
    ...probeWebgl(),
    coarsePointer: mm('(pointer: coarse)'),
    anyHover: mm('(any-hover: hover)'),
    screenMinPx: Math.min(screen.width || innerWidth, screen.height || innerHeight, Math.max(innerWidth, innerHeight)),
    deviceMemoryGB: nav.deviceMemory ?? null,
    cores: nav.hardwareConcurrency ?? null,
    saveData: !!nav.connection?.saveData,
    reducedMotion: mm('(prefers-reduced-motion: reduce)'),
    dpr: window.devicePixelRatio || 1,
  };
  return cached;
}

/** A remote renderer exists only if the server says so. None is deployed: the V7 GPU probe gated remote streaming off (no encoder binding, no WebRTC stack, no TURN). */
export const REMOTE_RENDERER = { available: false, reason: 'No remote renderer is deployed on this server (GPU probe: remote streaming gated).' } as const;
