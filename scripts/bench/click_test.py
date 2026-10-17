#!/usr/bin/env python3
"""Real-mouse pick test: project known entity points with the live camera, click them, read the selection store.
  LD_LIBRARY_PATH=$HOME/.cache/lk-libs python3 scripts/bench/click_test.py [--url URL] [--tab dashboard|map] [--preset 'Top-down']
Needs window.__lk (dev server / ?probe)."""
import argparse, json, time
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:5183/'); ap.add_argument('--tab', default='dashboard'); ap.add_argument('--preset', default='Top-down')
ap.add_argument('--size', default='1440x900')
a = ap.parse_args(); w, h = map(int, a.size.split('x'))
PROJ = """(pt) => { const T = window.__lk.three; const v = T.camera.position.clone().set(pt[0], pt[1], pt[2]).project(T.camera); return [(v.x*0.5+0.5)*T.size.width, (1-(v.y*0.5+0.5))*T.size.height]; }"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'])
    page = b.new_context(viewport={'width': w, 'height': h}).new_page()
    page.goto(a.url, wait_until='load'); page.wait_for_function('window.__lk && window.__lk.three && window.__lk.world.getState().topology', timeout=60000); time.sleep(6)
    if a.tab != 'dashboard': page.locator('button', has_text=a.tab.capitalize()).first.click(); time.sleep(5)
    page.locator('button', has_text=a.preset).first.click(); time.sleep(5)
    topo = page.evaluate("() => window.__lk.world.getState().topology")
    robots = page.evaluate("() => Object.fromEntries(Object.values(window.__lk.world.getState().robots).map(r => [r.id, r.pose.position_xyz_m]))")
    A = {x['id']: x for x in topo['assets']}; E = {e['id']: e for e in topo['edges']}
    targets = {
        'rack_a1': [*A['rack_a1']['position_xyz_m'][:1], 2.0, A['rack_a1']['position_xyz_m'][2]],
        'rack_e8': [A['rack_e8']['position_xyz_m'][0], 2.0, A['rack_e8']['position_xyz_m'][2]],
        'cdu_01': [A['cdu_01']['position_xyz_m'][0], 1.2, A['cdu_01']['position_xyz_m'][2]],
        'p_10': [-3.0, 3.2, -0.45] if False else E['p_10']['centerline_xyz_m'][2],
        'road:ROAD-03': [11.5, 0.02, 2.0],
        'IR-01': robots['IR-01'], 'OR-05': [robots['OR-05'][0], 0.5, robots['OR-05'][2]],
    }
    res = {}
    for k, pt in targets.items():
        page.evaluate("() => window.__lk.view.getState().select(null)"); time.sleep(0.6)
        x, y = page.evaluate(PROJ, pt)
        page.mouse.move(x, y); time.sleep(0.15); page.mouse.click(x, y); time.sleep(0.8)
        sel = page.evaluate("() => window.__lk.view.getState().selectedId")
        res[k] = {'click_px': [round(x), round(y)], 'selected': sel, 'ok': sel == k}
        print(f"{k:14s} click=({x:.0f},{y:.0f}) -> selected={sel} {'OK' if sel == k else 'MISMATCH'}")
    json.dump(res, open('/tmp/click_test.json', 'w'), indent=1)
    b.close()
