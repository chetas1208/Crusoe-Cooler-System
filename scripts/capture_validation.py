#!/usr/bin/env python3
"""Capture validation screenshots of Dashboard, Map, and Cutaway presets at desktop breakpoints."""
import os
import sys
import time
from playwright.sync_api import sync_playwright

OUT_DIR = "/home/923873155/Crusoe_Project/artifacts/validation_screenshots"
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
            time.sleep(3.5) # Wait for WebGL render
            dash_path = os.path.join(OUT_DIR, f"rebuilt_dashboard_{name}.png")
            page.screenshot(path=dash_path)
            print(f"Captured {dash_path}")

            # Cutaway Presets on 1440x900
            if name == "1440x900":
                presets = [
                    ("structure", "preset_structure.png"),
                    ("exterior", "preset_exterior.png"),
                    ("cooling", "preset_cooling_network.png"),
                    ("racks", "preset_rack_zone.png"),
                    ("plant", "preset_mechanical_plant.png"),
                ]
                for p_name, file_name in presets:
                    page.evaluate(f"window.__lk.useView.getState().preset('{p_name}')")
                    time.sleep(2.0)
                    p_path = os.path.join(OUT_DIR, file_name)
                    page.screenshot(path=p_path)
                    print(f"Captured {p_path}")

                # Reset to structure
                page.evaluate("window.__lk.useView.getState().preset('structure')")
                time.sleep(1.0)

            # Map Tab
            map_btn = page.locator("button", has_text="Map").first
            if map_btn.count() > 0:
                map_btn.click()
                time.sleep(2.5)
                map_path = os.path.join(OUT_DIR, f"rebuilt_map_{name}.png")
                page.screenshot(path=map_path)
                print(f"Captured {map_path}")

            context.close()
        browser.close()

if __name__ == "__main__":
    capture()
