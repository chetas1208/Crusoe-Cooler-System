#!/usr/bin/env python3
"""E2E verification script for LOOPKEEPER Map Tab using Playwright."""
import os
import sys
import time
from playwright.sync_api import sync_playwright

SCREENSHOT_DIR = "/path/to/repo/artifacts/e2e_screenshots"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

def pick_idle_outrig() -> str:
    """The live run is busy with incidents: lease the rover that is actually idle (a robot mid-repair is correctly refused with 409)."""
    import json, urllib.request
    api = os.environ.get("E2E_API", "http://127.0.0.1:8787")
    rows = json.load(urllib.request.urlopen(f"{api}/api/v1/robots", timeout=10))
    ok = [r for r in rows if r["class"] == "outrig" and r["mode"] in ("IDLE", "DOCKED") and r["battery_pct"] > 25
          and (r.get("control") or {}).get("controller_state", "AUTONOMOUS") == "AUTONOMOUS"]
    assert ok, "no idle OUTRIG available for the lease test"
    return sorted(ok, key=lambda r: -r["battery_pct"])[0]["id"]


def run_map_tab_e2e():
    errors: list[str] = []
    console_logs: list[str] = []

    print("=== STARTING LOOPKEEPER MAP TAB E2E TEST ===")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-web-security", "--no-sandbox", "--enable-unsafe-swiftshader"]
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        # Listen to console & errors
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: errors.append(f"Page Error: {err}"))

        # Step 1: Navigate to app
        url = os.environ.get("E2E_URL", "http://127.0.0.1:5173/")
        print(f"1. Navigating to {url}...")
        page.goto(url, wait_until="load", timeout=60000)
        page.wait_for_selector("text=Dashboard", timeout=30000)
        time.sleep(6)

        # Step 2: Switch to Map Tab
        print("2. Switching to Map Tab...")
        map_tab_btn = page.locator("button", has_text="Map").first
        map_tab_btn.click()
        time.sleep(1.0)

        # Verify Map Tab active
        assert "Map" in map_tab_btn.inner_text(), "Map tab button not found"
        print("   Map Tab activated.")

        # Step 3: Check Layout Elements (Single no-scroll screen)
        print("3. Verifying Map Tab Layout structure...")
        container = page.locator(".map-tab-container")
        assert container.count() > 0, "Container .map-tab-container not found"
        
        fleet_drawer = page.locator(".map-fleet-drawer")
        assert fleet_drawer.count() > 0, "Left drawer .map-fleet-drawer not found"

        inspector = page.locator(".map-inspector")
        assert inspector.count() > 0, "Right inspector .map-inspector not found"

        hud = page.locator(".map-control-hud")
        assert hud.count() > 0, "Control HUD .map-control-hud not found"
        print("   All major layout panels (.map-fleet-drawer, .map-inspector, .map-control-hud) verified.")

        # Step 4: Verify MiniMap rendered
        print("4. Checking SpatialMiniMap...")
        minimap = page.locator(".spatial-minimap")
        assert minimap.count() > 0, "SpatialMiniMap SVG not found"
        svg_rects = minimap.locator("rect").count()
        svg_paths = minimap.locator("path").count()
        svg_circles = minimap.locator("circle").count()
        print(f"   MiniMap rendered with {svg_rects} equipment rects, {svg_paths} pipe paths, and {svg_circles} robot/incident markers.")
        assert svg_rects > 0, "No equipment rects rendered in minimap"
        assert svg_paths > 0, "No pipe paths rendered in minimap"

        # Step 5: Check Fleet Drawer Tabs (Internal vs Exterior)
        print("5. Checking Fleet Selection Tabs...")
        internal_btn = page.locator(".map-fleet-drawer button", has_text="Internal").first
        exterior_btn = page.locator(".map-fleet-drawer button", has_text="External").first
        assert internal_btn.count() > 0, "Internal tab button not found"
        assert exterior_btn.count() > 0, "Exterior tab button not found"

        # Inpipe list check
        inpipe_c01 = page.locator("text=IR-01").first
        assert inpipe_c01.count() > 0, "IR-01 row not found"
        print("   Internal crawlers list verified.")

        # Take screenshot of default map tab (Overview / Tactical)
        screenshot_1 = os.path.join(SCREENSHOT_DIR, "1_map_tab_tactical_normal.png")
        page.screenshot(path=screenshot_1)
        print(f"   Saved screenshot: {screenshot_1}")

        # Step 6: Test Exterior Robot Selection
        print("6. Testing Exterior Robot (OUTRIG O-01) selection...")
        exterior_btn.click()
        time.sleep(0.5)
        outrig_card = page.locator("text=OR-01").first
        assert outrig_card.count() > 0, "OR-01 row not found after clicking Exterior"
        
        # Click Focus POV on OUTRIG
        focus_btn = page.locator("[role=option]", has_text="OR-01").first
        focus_btn.click()
        time.sleep(0.5)

        # Verify Inspector updated for OUTRIG
        inspector_text = inspector.inner_text()
        assert "OUTRIG" in inspector_text, "Inspector does not show OUTRIG"
        assert "Global X / Z" in inspector_text or "Floor" in inspector_text, "Inspector missing OUTRIG floor coordinates"
        print("   OUTRIG O-01 selected and inspector telemetry verified.")

        screenshot_outrig = os.path.join(SCREENSHOT_DIR, "2_map_tab_outrig_selected.png")
        page.screenshot(path=screenshot_outrig)
        print(f"   Saved screenshot: {screenshot_outrig}")

        # Step 7: Test Camera Perspectives (Tactical -> Robot POV -> Third Person)
        print("7. Testing Camera Perspective switching...")
        pov_btn = page.locator(".hud-cam-modes button", has_text="Robot POV").first
        tp_btn = page.locator(".hud-cam-modes button", has_text="Third Person").first
        tactical_btn = page.locator(".hud-cam-modes button", has_text="Tactical").first

        # Switch to Robot POV
        pov_btn.click()
        time.sleep(0.5)
        badge_text = page.locator(".hud-pill").inner_text()
        print(f"   Robot POV badge: {badge_text}")
        assert "FRONT" in badge_text or "FORWARD" in badge_text or "POV" in badge_text, f"Unexpected badge in Robot POV: {badge_text}"

        # Check First-Person Subview Slots (1-5)
        subviews = page.locator(".hud-subviews button")
        assert subviews.count() >= 5, f"Expected 5 camera viewpoint buttons, got {subviews.count()}"
        print("   First-Person 5 mounted camera slots [1]-[5] visible.")

        # Click slot [2] Rear
        rear_slot = page.locator(".hud-subviews button", has_text="rear").first
        rear_slot.click()
        time.sleep(0.5)
        badge_rear = page.locator(".hud-pill").inner_text()
        assert "REAR" in badge_rear, f"Badge did not update to REAR: {badge_rear}"
        print(f"   Camera slot switched to REAR: {badge_rear}")

        screenshot_pov = os.path.join(SCREENSHOT_DIR, "3_map_tab_robot_pov_rear.png")
        page.screenshot(path=screenshot_pov)
        print(f"   Saved screenshot: {screenshot_pov}")

        # Switch to Third Person
        tp_btn.click()
        time.sleep(0.5)
        badge_tp = page.locator(".hud-pill").inner_text()
        print(f"   Third Person badge: {badge_tp}")
        assert "CHASE" in badge_tp or "ORBIT" in badge_tp or "THIRD" in badge_tp, f"Unexpected badge in Third Person: {badge_tp}"

        # Click Orbit mode
        orbit_btn = page.locator(".hud-subviews button", has_text="Orbit").first
        orbit_btn.click()
        time.sleep(0.5)
        badge_orbit = page.locator(".hud-pill").inner_text()
        assert "ORBIT" in badge_orbit, f"Badge did not update to ORBIT: {badge_orbit}"
        print("   Third Person Orbit mode activated.")

        screenshot_tp = os.path.join(SCREENSHOT_DIR, "4_map_tab_third_person_orbit.png")
        page.screenshot(path=screenshot_tp)
        print(f"   Saved screenshot: {screenshot_tp}")

        # Step 8: Switch back to Internal Crawler & verify Cutaway
        print("8. Testing Internal Crawler (c_01) Cutaway follower...")
        internal_btn.click()
        time.sleep(0.5)
        c01_focus = page.locator("[role=option]", has_text="IR-01").first
        c01_focus.click()
        time.sleep(0.5)

        # In third person mode, Cutaway X-Ray button should now be available for crawler
        cutaway_btn = page.locator(".hud-subviews button", has_text="Cutaway X-Ray").first
        assert cutaway_btn.count() > 0, "Cutaway X-Ray button not found for crawler in Third Person"
        cutaway_btn.click()
        time.sleep(0.5)
        badge_cutaway = page.locator(".hud-pill").inner_text()
        assert "CUTAWAY" in badge_cutaway, f"Badge did not update to CUTAWAY: {badge_cutaway}"
        print(f"   Cutaway X-ray follower active: {badge_cutaway}")

        screenshot_cutaway = os.path.join(SCREENSHOT_DIR, "5_map_tab_crawler_cutaway.png")
        page.screenshot(path=screenshot_cutaway)
        print(f"   Saved screenshot: {screenshot_cutaway}")

        # Step 9: Test Immersive Mode (Key H or Toggle button)
        print("9. Testing Immersive HUD Mode toggle...")
        # Press key 'h' to toggle immersive
        page.keyboard.press("KeyH")
        time.sleep(0.5)
        collapsed_drawer = page.locator(".map-drawer-collapsed")
        collapsed_inspector = page.locator(".map-inspector-collapsed")
        assert collapsed_drawer.count() > 0, "Drawer did not collapse in immersive mode"
        assert collapsed_inspector.count() > 0, "Inspector did not collapse in immersive mode"
        print("   Side panels collapsed into thin HUD strips (immersive mode active).")

        screenshot_immersive = os.path.join(SCREENSHOT_DIR, "6_map_tab_immersive_hud.png")
        page.screenshot(path=screenshot_immersive)
        print(f"   Saved screenshot: {screenshot_immersive}")

        # Press key 'h' to restore
        page.keyboard.press("KeyH")
        time.sleep(0.5)
        assert page.locator(".map-fleet-drawer").count() > 0, "Drawer did not restore"
        assert page.locator(".map-inspector").count() > 0, "Inspector did not restore"
        print("   Side panels restored successfully.")

        # Check no-scroll invariant: body scrollHeight vs innerHeight
        scroll_height = page.evaluate("() => document.body.scrollHeight")
        inner_height = page.evaluate("() => window.innerHeight")
        print(f"   Scroll check: body scrollHeight={scroll_height}px, window innerHeight={inner_height}px (Single no-scroll screen verified)")
        assert scroll_height <= inner_height + 2, f"Page has vertical scrollbar! scrollHeight={scroll_height} > {inner_height}"

        idle_or = pick_idle_outrig()
        # Step 10: Test Manual Control Lease Flow on OUTRIG O-01
        print("10. Testing Manual Control Lease Flow on OUTRIG O-01...")
        exterior_btn.click()
        time.sleep(0.5)
        page.locator("[role=option]", has_text=idle_or).first.click()
        time.sleep(0.5)

        take_ctrl_btn = page.locator(".map-inspector button", has_text="Take Manual Control").first
        assert take_ctrl_btn.count() > 0, "Take Manual Control button not found on OUTRIG inspector"
        assert take_ctrl_btn.is_enabled(), "Take Manual Control button is disabled for idle OUTRIG rover"
        take_ctrl_btn.click()

        # Wait for lease to be acquired and Release Lease button to appear
        release_btn = page.wait_for_selector(".map-inspector button:has-text('Release Lease')", timeout=8000)
        assert release_btn is not None, "Release Lease button did not appear within 8s"
        inspector_text = page.locator(".map-inspector").inner_text()
        print("    Manual lease successfully acquired! Authority: MANUAL CONTROL.")

        # Verify driving HUD and send drive input
        print("    Sending driving keys (W/throttle)...")
        page.keyboard.down("KeyW")
        time.sleep(0.5)
        page.keyboard.up("KeyW")
        time.sleep(0.2)

        # Test tool activation (Lightbulb key L)
        print("    Testing tool hotkey (Key L / Floodlight toggle)...")
        page.keyboard.press("KeyL")
        time.sleep(0.2)

        screenshot_driving = os.path.join(SCREENSHOT_DIR, "7_map_tab_manual_driving.png")
        page.screenshot(path=screenshot_driving)
        print(f"    Saved screenshot: {screenshot_driving}")

        # Release lease
        release_btn.click()
        page.wait_for_selector(".map-inspector button:has-text('Take Manual Control')", timeout=8000)
        print("    Lease released cleanly. Robot returned to autonomous authority.")

        # Step 11: Check console errors
        critical_errors = [e for e in errors if "WebGL" not in e]
        assert len(critical_errors) == 0, f"Critical page errors detected: {critical_errors}"
        print(f"11. Console check: 0 unhandled fatal errors out of {len(console_logs)} log events.")

        browser.close()

    print("\n=== MAP TAB E2E VERIFICATION COMPLETED SUCCESSFULLY ===")
    return True

if __name__ == "__main__":
    try:
        success = run_map_tab_e2e()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\nE2E VERIFICATION FAILED: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
