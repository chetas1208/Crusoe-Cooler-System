#!/usr/bin/env python3
import os
import sys
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

def run():
    print("Starting V5 screenshot captures...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-web-security",
                "--no-sandbox",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
                "--use-gl=angle",
                "--use-angle=swiftshader"
            ]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        print("Navigating to http://localhost:5173/?seed=8...")
        page.goto("http://localhost:5173/?seed=8", wait_until="networkidle", timeout=30000)
        time.sleep(4.0)

        # 1. Dashboard
        dash_btn = page.locator("button", has_text="Dashboard").or_(page.get_by_role("tab", name="Dashboard")).first
        if dash_btn.count() > 0:
            dash_btn.click()
            time.sleep(3.0)
            p1 = os.path.join(ARTIFACT_DIR, "v5-tab1-dashboard.png")
            page.screenshot(path=p1)
            print(f"Captured Dashboard -> {p1} ({os.path.getsize(p1)} bytes)")

        # 2. Map (Select OR-01 with 6-DOF arm HUD)
        map_btn = page.locator("button", has_text="Map").or_(page.get_by_role("tab", name="Map")).first
        if map_btn.count() > 0:
            map_btn.click()
            time.sleep(3.0)
            
            # Click "Exterior" or "OR-01"
            ext_btn = page.locator("button", has_text="Exterior").first
            if ext_btn.count() > 0:
                ext_btn.click()
                time.sleep(1.5)

            # Try to click robot OR-01 in list
            r_btn = page.locator("button", has_text="OR-01").first
            if r_btn.count() > 0:
                r_btn.click()
                time.sleep(2.0)

            p2 = os.path.join(ARTIFACT_DIR, "v5-tab2-map-4k-hud.png")
            page.screenshot(path=p2)
            print(f"Captured Map (OR-01 & HUD) -> {p2} ({os.path.getsize(p2)} bytes)")

        # 3. Agents (Laya + 5 Supervisors)
        agents_btn = page.locator("button", has_text="Agents").or_(page.get_by_role("tab", name="Agents")).first
        if agents_btn.count() > 0:
            agents_btn.click()
            time.sleep(3.0)
            p3 = os.path.join(ARTIFACT_DIR, "v5-tab3-agents-laya.png")
            page.screenshot(path=p3)
            print(f"Captured Agents (Laya System 1 Router) -> {p3} ({os.path.getsize(p3)} bytes)")

        # 4. Execution
        exec_btn = page.locator("button", has_text="Execution").or_(page.get_by_role("tab", name="Execution")).first
        if exec_btn.count() > 0:
            exec_btn.click()
            time.sleep(3.0)
            p4 = os.path.join(ARTIFACT_DIR, "v5-tab4-execution.png")
            page.screenshot(path=p4)
            print(f"Captured Execution -> {p4} ({os.path.getsize(p4)} bytes)")

        browser.close()
    print("Done capturing V5 artifacts!")

if __name__ == "__main__":
    run()
