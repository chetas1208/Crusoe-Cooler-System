#!/usr/bin/env python3
import os
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=["--disable-web-security", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    )
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    page = context.new_page()

    page.goto("http://localhost:5173/?seed=8", wait_until="networkidle", timeout=30000)
    time.sleep(4.0)

    # Click Map
    page.locator("button", has_text="Map").or_(page.get_by_role("tab", name="Map")).first.click()
    time.sleep(3.0)

    # Click Exterior (6)
    ext_btn = page.locator("button", has_text="Exterior").first
    if ext_btn.count() > 0:
        ext_btn.click()
        time.sleep(3.0)

    out_path = os.path.join(ARTIFACT_DIR, "v4-tab2-map-exterior.png")
    page.screenshot(path=out_path)
    print(f"Saved {out_path} ({os.path.getsize(out_path)} bytes)")

    browser.close()
