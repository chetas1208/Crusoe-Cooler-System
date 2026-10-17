#!/usr/bin/env python3
"""Capture V4 post-implementation screenshots at the three required resolutions:
1366x768, 1440x900, and 1920x1080 across Dashboard and Map tabs.
"""
import os
import sys
import time
from playwright.sync_api import sync_playwright

AFTER_DIR = "/home/923873155/Crusoe_Project/artifacts/screenshots/after"
os.makedirs(AFTER_DIR, exist_ok=True)

RESOLUTIONS = [
    ("1366x768", 1366, 768),
    ("1440x900", 1440, 900),
    ("1920x1080", 1920, 1080),
]

def capture_all():
    print(f"Starting screenshot capture to {AFTER_DIR}...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        )

        for name, width, height in RESOLUTIONS:
            print(f"Capturing resolution {name} ({width}x{height})...")
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()

            # 1. Dashboard Tab
            url = "http://localhost:5173/?seed=8"
            print(f"  Loading {url} for Dashboard...")
            page.goto(url, wait_until="networkidle", timeout=30000)
            time.sleep(5.0)  # Allow WebGL scene, instancing, and layout to render

            dash_path = os.path.join(AFTER_DIR, f"dashboard_{name}.png")
            page.screenshot(path=dash_path)
            print(f"  -> Saved {dash_path} ({os.path.getsize(dash_path)} bytes)")

            # 2. Map Tab
            map_btn = page.locator("button", has_text="Map").or_(page.get_by_role("tab", name="Map")).first
            if map_btn.count() > 0:
                print("  Navigating to Map tab...")
                map_btn.click()
                time.sleep(4.0)  # Allow Map view and robot fleet drawer to settle
                map_path = os.path.join(AFTER_DIR, f"map_{name}.png")
                page.screenshot(path=map_path)
                print(f"  -> Saved {map_path} ({os.path.getsize(map_path)} bytes)")
            else:
                print("  [WARN] Map button not found!")

            context.close()

        browser.close()
    print("Screenshot capture complete!")

if __name__ == "__main__":
    capture_all()
