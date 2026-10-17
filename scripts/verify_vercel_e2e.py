#!/usr/bin/env python3
import os
import time
from playwright.sync_api import sync_playwright

ARTIFACT_DIR = "/home/923873155/.gemini/antigravity-cli/brain/1205d87b-351e-4e87-a198-d513bea96829"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

def verify_vercel():
    url = "https://your-app.vercel.app/?seed=8"
    print(f"Verifying live Vercel deployment E2E at {url}...")

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

        errors = []
        page.on("pageerror", lambda err: errors.append(f"PAGE ERROR: {err}"))
        page.on("console", lambda msg: print(f"[CONSOLE {msg.type}] {msg.text}") if msg.type in ["error", "warning"] else None)

        print(f"Loading {url}...")
        resp = page.goto(url, wait_until="networkidle", timeout=45000)
        print(f"Response status: {resp.status if resp else 'None'}")
        time.sleep(5.0)

        # 1. Verify Dashboard Tab & 3D Canvas
        canvas = page.locator("canvas")
        print(f"Canvas count: {canvas.count()}")

        dash_path = os.path.join(ARTIFACT_DIR, "vercel-e2e-dashboard.png")
        page.screenshot(path=dash_path)
        print(f"Captured live Vercel Dashboard -> {dash_path} ({os.path.getsize(dash_path)} bytes)")

        # 2. Verify Map Tab
        print("Navigating to Map Tab on Vercel...")
        page.locator("button", has_text="Map").first.click()
        time.sleep(3.0)
        map_path = os.path.join(ARTIFACT_DIR, "vercel-e2e-map.png")
        page.screenshot(path=map_path)
        print(f"Captured live Vercel Map -> {map_path} ({os.path.getsize(map_path)} bytes)")

        # 3. Verify Agents Tab
        print("Navigating to Agents Tab on Vercel...")
        page.locator("button", has_text="Agents").first.click()
        time.sleep(3.0)
        agents_path = os.path.join(ARTIFACT_DIR, "vercel-e2e-agents.png")
        page.screenshot(path=agents_path)
        print(f"Captured live Vercel Agents -> {agents_path} ({os.path.getsize(agents_path)} bytes)")

        # 4. Verify Execution Tab (V8 Crisis Execution Lab)
        print("Navigating to Execution Tab on Vercel...")
        page.locator("button", has_text="Execution").first.click()
        time.sleep(3.0)
        exec_path = os.path.join(ARTIFACT_DIR, "vercel-e2e-execution.png")
        page.screenshot(path=exec_path)
        print(f"Captured live Vercel Execution Lab -> {exec_path} ({os.path.getsize(exec_path)} bytes)")

        browser.close()
        print("Vercel E2E verification complete!")

if __name__ == "__main__":
    verify_vercel()
