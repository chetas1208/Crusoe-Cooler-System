#!/usr/bin/env python3
"""Ad-hoc probe: open the app, switch tab, run JS snippets (window.__lk available), screenshot after each.
  python3 scripts/bench/probe_shot.py --tab map --size 1440x900 --step "js1" --shot out1.png --step "js2" --shot out2.png
Steps run in order; each --shot takes a screenshot of the state after the preceding steps. Prints return values of JS steps."""
import argparse, json, os, sys, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:5183/')
ap.add_argument('--tab', default='dashboard')
ap.add_argument('--size', default='1440x900')
ap.add_argument('--settle', type=float, default=6)
ap.add_argument('--after', type=float, default=3.0, help='seconds to wait after each js step before a shot')
ap.add_argument('--seq', nargs='*', default=[], help='sequence: js:<code> | shot:<path> | click:<text> | wait:<s>')
a = ap.parse_args()
w, h = map(int, a.size.split('x'))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'])
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
    page = ctx.new_page()
    logs = []
    page.on('pageerror', lambda e: logs.append('pageerror ' + str(e)[:300]))
    page.on('console', lambda m: logs.append(m.type + ' ' + m.text[:300]) if m.type in ('error', 'warning') else None)
    page.goto(a.url, wait_until='load', timeout=60000)
    page.wait_for_function('window.__lk && window.__lk.three && window.__lk.world.getState().topology', timeout=60000)
    time.sleep(a.settle)
    if a.tab != 'dashboard':
        page.locator('button', has_text=a.tab.capitalize()).first.click(); time.sleep(a.settle)
    for s in a.seq:
        k, _, v = s.partition(':')
        if k == 'js':
            r = page.evaluate(v if v.strip().startswith('(') else f'() => {{ {v} }}')
            if r is not None: print('JS ->', json.dumps(r)[:1500])
            time.sleep(a.after)
        elif k == 'shot':
            os.makedirs(os.path.dirname(v) or '.', exist_ok=True); page.screenshot(path=v); print('saved', v)
        elif k == 'click':
            page.locator('button', has_text=v).first.click(); time.sleep(a.after)
        elif k == 'wait':
            time.sleep(float(v))
    for l in logs[:20]: print('LOG', l)
    b.close()
