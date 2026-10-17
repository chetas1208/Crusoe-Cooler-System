#!/usr/bin/env python3
import os
import sys
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

TABS = [
    ("Dashboard", "v4-tab1-dashboard.png"),
    ("Map", "v4-tab2-map.png"),
    ("Agents", "v4-tab3-agents.png"),
    ("Execution", "v4-tab4-execution.png"),
]

def capture_tabs():
    print("Capturing 4 locked tabs at 1440x900...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        page.goto("http://localhost:5173/?seed=8", wait_until="networkidle", timeout=30000)
        time.sleep(5.0)

        for tab_name, filename in TABS:
            btn = page.locator("button", has_text=tab_name).or_(page.get_by_role("tab", name=tab_name)).first
            if btn.count() > 0:
                print(f"  Switching to {tab_name}...")
                btn.click()
                time.sleep(3.5)
                out_path = os.path.join(ARTIFACT_DIR, filename)
                page.screenshot(path=out_path)
                print(f"  -> Saved {out_path} ({os.path.getsize(out_path)} bytes)")
            else:
                print(f"  [WARN] Tab {tab_name} not found!")

        context.close()
        browser.close()
    print("All tabs captured!")

if __name__ == "__main__":
    capture_tabs()
