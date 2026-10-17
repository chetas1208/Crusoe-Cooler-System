#!/usr/bin/env python3
"""V6 captures.

  LD_LIBRARY_PATH=$HOME/.cache/lk-libs python3 scripts/capture_v6.py <label> [url] [WxH ...] [--focus]

Saves artifacts/v6/<label>_<tab>_<WxH>.png for the four tabs. With --focus (needs the dev server or a ?probe build, which expose
window.__lk) it also saves focused shots at the first size: <label>_focus_{cooling,road2,pipe_inspector,robot_pov,robot_chase,row,rack,cdu}_<WxH>.png
and prints console errors (anything of type error / pageerror) so a tab that throws is visible.
"""
import os, sys, time
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(__file__), "..", "artifacts", "v6")
os.makedirs(OUT, exist_ok=True)
args = [a for a in sys.argv[1:] if not a.startswith("--")]
focus = "--focus" in sys.argv
label = args[0] if len(args) > 0 else "cur"
url = args[1] if len(args) > 1 else "http://127.0.0.1:5183/"
sizes = [tuple(map(int, s.split("x"))) for s in args[2:]] or [(1440, 900)]
TABS = ["Dashboard", "Map", "Agents", "Execution"]


def click_tab(page, t):
    loc = page.get_by_role("tab", name=t).or_(page.locator("button", has_text=t)).first
    if loc.count():
        loc.click()


with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=["--no-sandbox", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-unsafe-webgpu",
                                               "--enable-features=Vulkan", "--disable-vulkan-surface"])
    for idx, (w, h) in enumerate(sizes):
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
        page = ctx.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
        page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
        page.goto(url, wait_until="load", timeout=60000)
        time.sleep(8)
        for t in TABS:
            if t != "Dashboard":
                click_tab(page, t)
                time.sleep(16 if t == 'Execution' else 5)  # Execution loads the run's recorded events (several MB)
            path = os.path.join(OUT, f"{label}_{t.lower()}_{w}x{h}.png")
            page.screenshot(path=path)
            print("saved", path)
        if focus and idx == 0:
            has_hook = page.evaluate("!!(window.__lk && window.__lk.view)")
            if not has_hook:
                print("no window.__lk: --focus needs the dev server or a build opened with ?probe")
            else:
                def shot(name):
                    path = os.path.join(OUT, f"{label}_focus_{name}_{w}x{h}.png")
                    page.screenshot(path=path)
                    print("saved", path)

                def js(code, wait=4):
                    page.evaluate(f"() => {{ const lk = window.__lk; {code} }}")
                    time.sleep(wait)

                click_tab(page, "Dashboard"); time.sleep(3)
                page.locator("button", has_text="Cooling cutaway").first.click(); time.sleep(4); shot("cooling")
                page.locator("button", has_text="Fit facility").first.click(); time.sleep(3)
                js("lk.view.getState().select('road:ROAD-02')"); shot("road2")
                js("lk.view.getState().select('row:ROW-03')"); shot("row")
                js("lk.view.getState().select('rack_c3')"); shot("rack")
                js("lk.view.getState().select('cdu_01')"); shot("cdu")
                js("lk.view.getState().select('p_hs_c')"); shot("pipe_inspector")
                click_tab(page, "Map"); time.sleep(4)
                js("lk.view.getState().select('OR-03')", 4)
                js("lk.mapCamera.getState().setCameraMode('first_person')", 4); shot("robot_pov")
                js("lk.mapCamera.getState().setThirdPersonMode('chase')", 4); shot("robot_chase")
        print(f"console errors at {w}x{h}: {len(logs)}")
        for l in logs[:15]:
            print("LOG", l[:300])
        ctx.close()
    b.close()
