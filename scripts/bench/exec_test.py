#!/usr/bin/env python3
"""Execution-tab end-to-end check against a live backend: timeline load time, list of runs, Fork from the UI, replay of a stopped/fork run.
  LD_LIBRARY_PATH=$HOME/.cache/lk-libs python3 scripts/bench/exec_test.py [--url URL] [--api http://127.0.0.1:8801] [--shots artifacts/v6/exec]
"""
import argparse, json, os, time, urllib.request
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:5183/'); ap.add_argument('--api', default='http://127.0.0.1:8801'); ap.add_argument('--shots', default='artifacts/v6/exec')
ap.add_argument('--mock-old', action='store_true', help='intercept /runs: add a stopped run with an unrecoverable topology (409) and a stopped run on a reduced 2-row topology')
ap.add_argument('--fork-replay', action='store_true')
ap.add_argument('--fork', action='store_true'); ap.add_argument('--replay', default='')
a = ap.parse_args()
os.makedirs(os.path.dirname(a.shots) or '.', exist_ok=True)
runs = lambda: json.load(urllib.request.urlopen(a.api + '/api/v1/runs'))
print('runs before:', [(r['run_id'], r['kind'], r['state'], r.get('topology_version')) for r in runs()])
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'])
    page = b.new_context(viewport={'width': 1440, 'height': 900}).new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append('pageerror ' + str(e)[:200])); page.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' else None)
    if a.mock_old:
        base = json.load(urllib.request.urlopen(a.api + '/api/v1/runs'))
        live = next(r for r in base if r['kind'] == 'baseline')
        gone = dict(live, run_id='run_gone', label='Old small hall', state='stopped', topology_version='facility-small@0.1#98c10fbf', topology_hash='98c10fbf', created_at='2026-10-15T00:00:00.000Z')
        legacy = dict(live, run_id='run_legacy', label='Old large hall (16 racks)', state='stopped', topology_version='facility-large@0.1#6a6f3d96', topology_hash='6a6f3d96', created_at='2026-10-15T01:00:00.000Z')
        topo = json.load(urllib.request.urlopen(a.api + '/api/v1/topology'))
        keep = lambda i: not any(i.startswith(f'rack_{c}') or i.startswith(f'valve_{c}') or i.startswith(f'sn_rack_{c}') for c in 'cde')
        small = dict(topo, assets=[x for x in topo['assets'] if keep(x['id'])], edges=[e for e in topo['edges'] if keep(e['id'].replace('p_sd_', 'rack_').replace('p_rd_', 'rack_'))])
        small['facility'] = dict(topo['facility'], topology_version='facility-large@0.1#6a6f3d96', topology_hash='6a6f3d96')
        def handle(route, request):
            print('ROUTE', request.method, request.url.split('/api/v1')[-1][:80]) if ('run_legacy' in request.url) else None
            u = request.url
            if request.method == 'POST' and u.endswith('/fork') and ('run_gone' in u or 'run_legacy' in u):
                return fork409(route, request)
            if request.method == 'OPTIONS' and ('run_gone' in u or 'run_legacy' in u):
                return route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'})
            if u.endswith('/api/v1/runs') and request.method == 'GET':
                return route.fulfill(json=[live, gone, legacy] + [r for r in base if r['run_id'] != live['run_id']])
            for rid, src in (('run_gone', live), ('run_legacy', live)):
                if f'/runs/{rid}' in u:
                    tail = u.split(f'/runs/{rid}')[1]
                    if tail.startswith('/topology'):
                        return route.fulfill(status=409, headers={'X-Problem-Code': 'topology_unavailable'}, json={'error': {'code': 'topology_unavailable', 'message': 'the topology recorded for this run is not stored'}}) if rid == 'run_gone' else route.fulfill(json=small)
                    r = route.fetch(url=u.replace(f'/runs/{rid}', f'/runs/{src["run_id"]}'))
                    if tail == '' or tail == '/':
                        return route.fulfill(json=dict(json.loads(r.text()), run_id=rid, state='stopped', label=gone['label'] if rid == 'run_gone' else legacy['label'], topology_version=(gone if rid == 'run_gone' else legacy)['topology_version']))
                    return route.fulfill(response=r, headers={**r.headers, 'access-control-allow-origin': '*'})
            return route.continue_()
        def fork409(route, request):
            return route.fulfill(status=409, headers={'X-Problem-Code': 'topology_mismatch'}, json={'error': {'code': 'topology_mismatch', 'message': 'run recorded on another topology'}})
        page.route('**/api/v1/runs/run_*gone/fork', fork409); page.route('**/api/v1/runs/run_legacy/fork', fork409)
        page.route('**/api/v1/runs**', handle)
    page.on('response', lambda r: print('HTTP', r.status, r.url.split('/api/v1')[-1][:90]) if '/runs/' in r.url and r.request.method != 'OPTIONS' and 'world' not in r.url else None)
    page.goto(a.url, wait_until='load'); page.wait_for_function('window.__lk && window.__lk.three && window.__lk.world.getState().topology', timeout=60000); time.sleep(4)
    t0 = time.time(); page.locator('button', has_text='Execution').first.click()
    ok = False
    while time.time() - t0 < 90:
        txt = page.evaluate('document.body.innerText')
        import re
        m = re.search(r'([\d,]+) recorded events', txt)
        if 'Loading recording' not in txt and m and int(m.group(1).replace(',', '')) > 0: ok = True; print('events:', m.group(1)); break
        time.sleep(0.25)
    print(f'timeline load: {time.time()-t0:.2f}s (loaded={ok})')
    time.sleep(2); page.screenshot(path=a.shots + '_live.png')
    if a.replay:
        page.locator('.ex-run', has_text=a.replay).first.click(); time.sleep(1)
        if a.fork_replay: page.locator('.ex-head button', has_text='Replay').first.click()
        page.wait_for_timeout(15000); page.screenshot(path=a.shots + f'_replay_{a.replay.split()[-1]}.png')
        print('racks in scene:', page.evaluate("() => window.__lk.world.getState().topology.assets.filter(x => x.type === 'rack').length"), '| player:', page.evaluate("() => document.querySelector('.ex-tl')?.innerText.replace(/\\n/g,' ').slice(0,160)"))
        print('player:', page.evaluate("() => { const p = window.__lk.player.getState(); return {phase: p.phase, problem: p.problem, from: p.from, to: p.to, ev: p.eventCount, run: p.run && p.run.state} }"))
        if a.mock_old:
            page.get_by_text('Fork from Playhead').click(); page.wait_for_timeout(2500); print('notice:', page.evaluate("() => document.querySelector('.ex-problem')?.innerText"))
        print('stamp:', page.evaluate("() => document.querySelector('.ex-left')?.innerText.slice(0,400)"))
    if a.fork:
        page.locator('.ex-run').first.click(); time.sleep(3)
        page.get_by_text('Fork from Playhead').click(); time.sleep(6)
        page.screenshot(path=a.shots + '_after_fork.png')
        print('notice:', page.evaluate("() => document.querySelector('.ex-problem')?.innerText"))
        print('left:', page.evaluate("() => document.querySelector('.ex-left')?.innerText.slice(0,600)"))
    print('runs after:', [(r['run_id'], r['kind'], r['state'], r.get('parent_run_id'), r.get('topology_version')) for r in runs()])
    print('console errors:', errs)
    b.close()
