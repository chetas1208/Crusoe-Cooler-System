#!/usr/bin/env python3
"""Capture baseline screenshots of Dashboard and Map at 1440x900 and 1366x768."""
import os
import sys
import time
from playwright.sync_api import sync_playwright

OUT_DIR = "/path/to/repo/artifacts/baseline_screenshots"
os.makedirs(OUT_DIR, exist_ok=True)

def capture():
    resolutions = [
        ("1440x900", 1440, 900),
        ("1366x768", 1366, 768),
        ("1920x1080", 1920, 1080),
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--enable-unsafe-swiftshader"]
        )

        for name, width, height in resolutions:
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()

            # Dashboard
            page.goto("http://localhost:5173/?seed=8", wait_until="networkidle", timeout=30000)
            time.sleep(3.0) # Wait for WebGL render
            dash_path = os.path.join(OUT_DIR, f"baseline_dashboard_{name}.png")
            page.screenshot(path=dash_path)
            print(f"Captured {dash_path}")

            # Map Tab
            map_btn = page.locator("button", has_text="Map").first
            if map_btn.count() > 0:
                map_btn.click()
                time.sleep(2.0)
                map_path = os.path.join(OUT_DIR, f"baseline_map_{name}.png")
                page.screenshot(path=map_path)
                print(f"Captured {map_path}")

            context.close()
        browser.close()

if __name__ == "__main__":
    capture()
