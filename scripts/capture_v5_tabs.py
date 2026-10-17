#!/usr/bin/env python3
import os
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/user/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

def capture():
    print("Capturing V5 tabs from http://localhost:8787/...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-web-security",
                "--no-sandbox",
                "--enable-unsafe-swiftshader",
                "--ignore-gpu-blocklist",
                "--use-gl=angle",
                "--use-angle=swiftshader",
            ]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        print("Navigating to http://localhost:8787/...")
        page.goto("http://localhost:8787/", wait_until="networkidle", timeout=30000)
        time.sleep(5.0)

        # 1. Dashboard
        p1 = os.path.join(ARTIFACT_DIR, "v5-tab1-dashboard.png")
        page.screenshot(path=p1)
        print(f"Captured Dashboard -> {p1} ({os.path.getsize(p1)} bytes)")

        # 2. Map Tab
        print("Switching to Map...")
        map_btn = page.locator("button", has_text="Map").first
        map_btn.click()
        time.sleep(4.0)
        p2 = os.path.join(ARTIFACT_DIR, "v5-tab2-map.png")
        page.screenshot(path=p2)
        print(f"Captured Map -> {p2} ({os.path.getsize(p2)} bytes)")

        # In Map Tab: Try clicking Exterior robot OR-01 or "Exterior" toggle
        ext_btn = page.locator("button", has_text="Exterior").first
        if ext_btn.count() > 0:
            ext_btn.click()
            time.sleep(2.0)
        
        # Click OR-01 if available
        or_btn = page.locator("button", has_text="OR-01").first
        if or_btn.count() > 0:
            or_btn.click()
            time.sleep(2.0)

        p2_hud = os.path.join(ARTIFACT_DIR, "v5-tab2-map-4k-hud.png")
        page.screenshot(path=p2_hud)
        print(f"Captured Map OR-01 HUD -> {p2_hud} ({os.path.getsize(p2_hud)} bytes)")

        # 3. Agents Tab
        print("Switching to Agents...")
        agents_btn = page.locator("button", has_text="Agents").first
        agents_btn.click()
        time.sleep(4.0)
        p3 = os.path.join(ARTIFACT_DIR, "v5-tab3-agents-laya.png")
        page.screenshot(path=p3)
        print(f"Captured Agents (Laya + 5 Supervisors) -> {p3} ({os.path.getsize(p3)} bytes)")

        # 4. Execution Tab
        print("Switching to Execution...")
        exec_btn = page.locator("button", has_text="Execution").first
        exec_btn.click()
        time.sleep(4.0)
        p4 = os.path.join(ARTIFACT_DIR, "v5-tab4-execution.png")
        page.screenshot(path=p4)
        print(f"Captured Execution -> {p4} ({os.path.getsize(p4)} bytes)")

        browser.close()
    print("All V5 screenshots captured successfully!")

if __name__ == "__main__":
    capture()
