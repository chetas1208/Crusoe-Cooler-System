#!/usr/bin/env python3
import os
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

def capture_ui_polish():
    print("Capturing UI Polish artifacts from http://localhost:8787/...")
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

        print("Navigating to http://localhost:8787/?seed=8...")
        page.goto("http://localhost:8787/?seed=8", wait_until="networkidle", timeout=30000)
        time.sleep(4.0)

        # 1. System Popover showing model_state & checkpointer
        print("Opening System Popover...")
        brand_btn = page.locator("button.brand").first
        brand_btn.click()
        time.sleep(1.5)
        p_popover = os.path.join(ARTIFACT_DIR, "v8-system-popover.png")
        page.screenshot(path=p_popover)
        print(f"Captured System Popover -> {p_popover} ({os.path.getsize(p_popover)} bytes)")

        # Close Popover
        page.keyboard.press("Escape")
        time.sleep(1.0)

        # 2. Pipe Interior Preset
        print("Selecting Pipe Interior preset...")
        # Open right layers dock if not open or click Pipe Interior button
        pipe_btn = page.locator("button", has_text="Pipe Interior").first
        if pipe_btn.count() > 0:
            pipe_btn.click()
            time.sleep(3.0)
        else:
            # Try palette shortcut ⌘K -> Pipe interior
            page.keyboard.press("Control+k")
            time.sleep(1.0)
            p_item = page.locator("button", has_text="Pipe interior").first
            if p_item.count() > 0:
                p_item.click()
                time.sleep(3.0)

        p_pipe = os.path.join(ARTIFACT_DIR, "v8-pipe-interior-preset.png")
        page.screenshot(path=p_pipe)
        print(f"Captured Pipe Interior Preset -> {p_pipe} ({os.path.getsize(p_pipe)} bytes)")

        # 3. True OFFLINE state with non-overlapping banner
        print("Simulating true OFFLINE state...")
        # Return to Map or Dashboard facility view
        reset_btn = page.locator("button", has_text="Exterior").first
        if reset_btn.count() > 0:
            reset_btn.click()
            time.sleep(1.5)

        # Switch to Map Tab to verify non-overlap with ControlHUD
        map_btn = page.locator("button", has_text="Map").first
        if map_btn.count() > 0:
            map_btn.click()
            time.sleep(2.0)

        # Disconnect network
        context.set_offline(True)
        time.sleep(3.0)

        p_offline = os.path.join(ARTIFACT_DIR, "v8-offline-banner.png")
        page.screenshot(path=p_offline)
        print(f"Captured OFFLINE State Banner -> {p_offline} ({os.path.getsize(p_offline)} bytes)")

        context.set_offline(False)
        browser.close()
        print("UI polish captures complete!")

if __name__ == "__main__":
    capture_ui_polish()
