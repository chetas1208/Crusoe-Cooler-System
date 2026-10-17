#!/usr/bin/env python3
import os
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

def capture_v8():
    print("Capturing V8 Execution Lab artifacts from http://localhost:8787/...")
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
        time.sleep(4.0)

        # Navigate to Execution Tab
        print("Switching to Execution Tab...")
        exec_btn = page.locator("button", has_text="Execution").first
        exec_btn.click()
        time.sleep(3.0)

        # 1. Capture Scenario Library (9 Scenario Cards)
        p_lib = os.path.join(ARTIFACT_DIR, "v8-tab4-execution-library.png")
        page.screenshot(path=p_lib)
        print(f"Captured Scenario Library -> {p_lib} ({os.path.getsize(p_lib)} bytes)")

        # 2. Start Episode for CR-02 (Manifold Rupture & Flood)
        print("Launching CR-02 episode from library...")
        # Find CR-02 card specifically
        cr02_card = page.locator("div", has_text="CR-02").filter(has_text="Manifold rupture").first
        cr02_btn = cr02_card.locator("button", has_text="Start Episode").first if cr02_card.count() > 0 else page.locator("button", has_text="Start Episode").first

        try:
            with page.expect_response(lambda r: "/api/v1/runs" in r.url and r.request.method == "POST", timeout=45000):
                cr02_btn.click()
            print("Received episode response, waiting for UI sync...")
            time.sleep(3.0)
        except Exception as e:
            print(f"Waiting exception or already loaded: {e}")
            time.sleep(5.0)

        # Capture Playback view (30:00 world clock, scrub bar, speed chips, runs panel)
        p_play = os.path.join(ARTIFACT_DIR, "v8-tab4-execution-playback-30min.png")
        page.screenshot(path=p_play)
        print(f"Captured 30:00 Episode Player -> {p_play} ({os.path.getsize(p_play)} bytes)")

        # 3. Capture CR-02 Leak & Hazard Zone
        p_cr02 = os.path.join(ARTIFACT_DIR, "v8-tab4-execution-cr02-leak.png")
        page.screenshot(path=p_cr02)
        print(f"Captured CR-02 Leak Hazard -> {p_cr02} ({os.path.getsize(p_cr02)} bytes)")

        # 4. Collapse Panels (Escape key dismiss) to show clean 3D facility
        print("Collapsing panels via Escape key...")
        page.keyboard.press("Escape")
        time.sleep(2.0)

        p_collapsed = os.path.join(ARTIFACT_DIR, "v8-tab4-execution-panels-collapsed.png")
        page.screenshot(path=p_collapsed)
        print(f"Captured Collapsed Panels View -> {p_collapsed} ({os.path.getsize(p_collapsed)} bytes)")

        # 5. Reopen panels via Escape key and inspect Run Details / Fork
        print("Reopening panels via Escape key for counterfactual inspection...")
        page.keyboard.press("Escape")
        time.sleep(2.0)

        p_counterfactual = os.path.join(ARTIFACT_DIR, "v8-tab4-execution-cr07-counterfactual.png")
        page.screenshot(path=p_counterfactual)
        print(f"Captured Counterfactual Details -> {p_counterfactual} ({os.path.getsize(p_counterfactual)} bytes)")

        browser.close()
        print("V8 captures complete!")

if __name__ == "__main__":
    capture_v8()
