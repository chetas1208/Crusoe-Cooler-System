// Shared helpers for the V10 mobile baseline / matrix runs (local only; no CI).
// Playwright is not a repo dependency: point PW_PATH at an install (default: the shared one under /tmp).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PW = process.env.PW_PATH ?? '/tmp/claude-1989081997/shots/node_modules/playwright/index.mjs';
export const { chromium } = await import(PW);
export const CHROME = process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
process.env.LD_LIBRARY_PATH = `${process.env.HOME}/.local/lib:${process.env.LD_LIBRARY_PATH ?? ''}`;

export const VIEWPORTS = {
  d1440: { w: 1440, h: 900, mobile: false },
  d1920: { w: 1920, h: 1080, mobile: false },
  d1280: { w: 1280, h: 720, mobile: false },
  d900: { w: 900, h: 600, mobile: false },
  p390: { w: 390, h: 844, mobile: true, dpr: 3 },
  p360: { w: 360, h: 800, mobile: true, dpr: 3 },
  p412: { w: 412, h: 915, mobile: true, dpr: 2.625 },
  p320: { w: 320, h: 640, mobile: true, dpr: 2 },
  l844: { w: 844, h: 390, mobile: true, dpr: 3 },
  l915: { w: 915, h: 412, mobile: true, dpr: 2.625 },
  t820: { w: 820, h: 1180, mobile: true, dpr: 2 },
  t768: { w: 768, h: 1024, mobile: true, dpr: 2 },
  t1024: { w: 1024, h: 768, mobile: true, dpr: 2 },
};

export async function launch({ webgl = true } = {}) {
  const args = webgl
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl']
    : ['--disable-gpu', '--disable-webgl', '--disable-3d-apis'];
  return chromium.launch({ executablePath: CHROME, args });
}

export async function newPage(browser, vp, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr ?? 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile,
    reducedMotion: opts.reducedMotion ?? 'no-preference', ...(opts.ctx ?? {}),
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** Static server with SPA fallback + gzip (to measure transfer bytes like a real host). Returns {url, close, stats}. */
export function serve(dir, { port = 0, gzip = true } = {}) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.glb': 'model/gltf-binary' };
  const stats = { requests: 0 };
  const srv = http.createServer((req, res) => {
    stats.requests++;
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, 'index.html');
    const ext = path.extname(f);
    let body = fs.readFileSync(f);
    const h = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': f.includes('/assets/') ? 'public,max-age=31536000,immutable' : 'no-cache' };
    if (gzip && /gzip/.test(req.headers['accept-encoding'] ?? '') && /\.(js|css|html|svg|json)$/.test(ext)) { body = zlib.gzipSync(body, { level: 6 }); h['content-encoding'] = 'gzip'; }
    h['content-length'] = body.length;
    res.writeHead(200, h).end(body);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(), stats })));
}

export const NET = {
  '4g': { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  none: null,
};

/** Install observers before any app script runs. */
export const INIT_SCRIPT = `
  window.__lk = { longTasks: [], t0: performance.now(), firstUsable: null, errors: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lk.longTasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  window.addEventListener('error', (e) => window.__lk.errors.push(String(e.message).slice(0, 200)));
  window.addEventListener('unhandledrejection', (e) => window.__lk.errors.push('rej:' + String(e.reason).slice(0, 200)));
`;

export async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vv = window.visualViewport;
    const small = [];
    for (const el of document.querySelectorAll('button, a[href], [role=tab], [role=button], input, select, summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (r.width < 44 || r.height < 44) small.push((el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24));
    }
    let overflowers = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > de.clientWidth + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') { overflowers.push((el.className && String(el.className).slice(0, 40)) || el.tagName); if (overflowers.length > 8) break; }
    }
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, cssW: Math.round(c.getBoundingClientRect().width), cssH: Math.round(c.getBoundingClientRect().height) }));
    const gl = (() => { try { const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); return g ? { ok: true, renderer: (g.getExtension('WEBGL_debug_renderer_info') ? g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL) : 'n/a'), maxTex: g.getParameter(g.MAX_TEXTURE_SIZE) } : { ok: false }; } catch { return { ok: false }; } })();
    const lk = window.__lk ?? {};
    return {
      inner: [innerWidth, innerHeight], client: [de.clientWidth, de.clientHeight], scrollW: de.scrollWidth, scrollH: de.scrollHeight, bodyScrollW: document.body.scrollWidth,
      xOverflow: de.scrollWidth > de.clientWidth + 1, vv: vv ? [Math.round(vv.width), Math.round(vv.height)] : null,
      canvases, gl, smallTargets: small.length, smallTargetSample: small.slice(0, 8), overflowers,
      longTasks: lk.longTasks?.length ?? 0, longTaskMaxMs: Math.max(0, ...(lk.longTasks ?? []).map((t) => t.d)), longTaskTotalMs: (lk.longTasks ?? []).reduce((a, t) => a + t.d, 0),
      errors: lk.errors ?? [], tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent?.trim()),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      domNodes: document.getElementsByTagName('*').length,
    };
  });
}

export async function cdpNetworkBytes(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  const rows = [];
  const byId = new Map();
  cdp.on('Network.responseReceived', (e) => byId.set(e.requestId, { url: e.response.url, status: e.response.status, type: e.type, mime: e.response.mimeType }));
  cdp.on('Network.loadingFinished', (e) => { const r = byId.get(e.requestId); if (r) rows.push({ ...r, enc: e.encodedDataLength }); });
  return { cdp, rows, total: () => rows.reduce((a, r) => a + r.enc, 0), js: () => rows.filter((r) => /javascript/.test(r.mime)).reduce((a, r) => a + r.enc, 0) };
}
