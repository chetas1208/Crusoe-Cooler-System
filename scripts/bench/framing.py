#!/usr/bin/env python3
"""Framing measurement. Projects the hall (all five rows, four roads, cross-aisles, mechanical bay) with the LIVE camera
and compares its screen bounding box with the free central region (viewport minus [data-inset] panels).

  LD_LIBRARY_PATH=$HOME/.cache/lk-libs python3 scripts/bench/framing.py [--url URL] [--sizes 1440x900,3840x2160] [--tabs dashboard,map] [--out artifacts/v6/framing.json]

Needs the dev server (or a build opened with ?probe) that exposes window.__lk.
"""
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright

JS = """
() => {
  const lk = window.__lk; const T = lk.three; const THREE_cam = T.camera; const size = T.size;
  const w = lk.world.getState(); const topo = w.topology;
  const L = topo.facility_layout_v6; const hall = L.hall;
  const W = innerWidth, H = innerHeight;
  // free region from the DOM, same rules as Shell.useSafeArea (top bar 70 px minimum)
  let left = 0, right = 0, bottom = 0, top = 70;
  document.querySelectorAll('[data-inset]').forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    const s = el.dataset.inset;
    if (s === 'left') left = Math.max(left, r.right + 8);
    if (s === 'right') right = Math.max(right, W - r.left + 8);
    if (s === 'bottom') bottom = Math.max(bottom, H - r.top + 4);
    if (s === 'top') top = Math.max(top, r.bottom + 6);
  });
  const free = { x0: left, y0: top, x1: W - right, y1: H - bottom };
  const cam = THREE_cam; cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  const proj = (x, y, z) => { const v = cam.position.clone().set(x, y, z).project(cam); return [(v.x * 0.5 + 0.5) * size.width, (1 - (v.y * 0.5 + 0.5)) * size.height]; };
  const yTop = 3.4;
  const box = (x0, x1, z0, z1, y1) => { const pts = []; for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, y1]) pts.push(proj(x, y, z)); return pts; };
  const bb = (pts) => ({ x0: Math.min(...pts.map(p => p[0])), x1: Math.max(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), y1: Math.max(...pts.map(p => p[1])) });
  const hallPts = box(hall.x_min_m, hall.x_max_m, hall.z_min_m, hall.z_max_m, yTop);
  const b = bb(hallPts);
  const rowsPts = L.rows.flatMap(r => box(r.x_min_m, r.x_max_m, r.z_m - 0.65, r.z_m + 0.65, 2.4));
  const rb = bb(rowsPts);
  const fw = free.x1 - free.x0, fh = free.y1 - free.y0;
  const fx = (b.x1 - b.x0) / fw, fy = (b.y1 - b.y0) / fh;
  const tol = 1;
  const inside = b.x0 >= free.x0 - tol && b.x1 <= free.x1 + tol && b.y0 >= free.y0 - tol && b.y1 <= free.y1 + tol;
  // pixel gap between neighbouring rows' projected footprints, measured at row mid-length (how countable the five rows are)
  const mid = (L.rows[0].x_min_m + L.rows[0].x_max_m) / 2;
  const rowsAtMid = L.rows.map(r => proj(mid, 1.2, r.z_m)[1]);
  const gaps = rowsAtMid.slice(1).map((y, i) => Math.round(Math.abs(y - rowsAtMid[i])));
  const cdu = topo.assets.find(a => a.type === 'cdu'); const cp = cdu ? proj(...cdu.position_xyz_m) : null;
  const cduIn = cp ? cp[0] >= free.x0 && cp[0] <= free.x1 && cp[1] >= free.y0 && cp[1] <= free.y1 : null;
  const pass = Math.max(fx, fy) >= 0.75 && Math.max(fx, fy) <= 0.86 && inside;
  return { pass_75_85_inside_free: pass, viewport: [W, H], free, free_size: [fw, fh], hall_bbox: b, rows_bbox: rb, hall_fraction_w: +fx.toFixed(3), hall_fraction_h: +fy.toFixed(3), hall_fraction_binding: +Math.max(fx, fy).toFixed(3), hall_inside_free_rect: inside, row_pitch_px: gaps, cdu_px: cp && cp.map(Math.round), cdu_in_free: cduIn, cam: { az: lk.view.getState().cam.azimuth, el: lk.view.getState().cam.elevation, dist: lk.view.getState().cam.distance }, camera_pos: cam.position.toArray().map(v => +v.toFixed(2)), view_offset: cam.view ? { x: cam.view.offsetX, y: cam.view.offsetY } : null };
}
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:5183/')
    ap.add_argument('--sizes', default='1440x900,3840x2160')
    ap.add_argument('--tabs', default='dashboard,map')
    ap.add_argument('--out', default='artifacts/v6/framing.json')
    ap.add_argument('--shots', default='')
    ap.add_argument('--settle', type=float, default=6.0)
    a = ap.parse_args()
    res = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'])
        for s in a.sizes.split(','):
            w, h = map(int, s.split('x'))
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
            page = ctx.new_page()
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' else None)
            page.goto(a.url, wait_until='load', timeout=60000)
            page.wait_for_function('window.__lk && window.__lk.three && window.__lk.world.getState().topology', timeout=60000)
            time.sleep(a.settle)
            for t in a.tabs.split(','):
                if t != 'dashboard':
                    page.locator('button[role=tab], button', has_text=t.capitalize()).first.click()
                time.sleep(a.settle)
                m = page.evaluate(JS)
                res[f'{t}_{s}'] = m
                print(f"{t:10s} {s:10s} pass={m['pass_75_85_inside_free']} fill w/h = {m['hall_fraction_w']}/{m['hall_fraction_h']} binding={m['hall_fraction_binding']} inside={m['hall_inside_free_rect']} row_pitch_px={m['row_pitch_px']} cdu_in_free={m['cdu_in_free']}")
                if a.shots:
                    page.screenshot(path=os.path.join(a.shots, f'framing_{t}_{s}.png'))
            res.setdefault('console_errors', {})[s] = errs[:10]
            ctx.close()
        b.close()
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(res, open(a.out, 'w'), indent=2)
    print('wrote', a.out)

main()
