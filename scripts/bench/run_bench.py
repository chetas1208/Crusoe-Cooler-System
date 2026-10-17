#!/usr/bin/env python3
"""Run the in-browser benchmark harness via playwright.
Navigates to http://localhost:5173/?bench=1&seed=8, calls window.__lkBench.run(),
and outputs JSON to artifacts/benchmarks/.
"""
import argparse
import json
import os
import sys
import time
from playwright.sync_api import sync_playwright

def run_bench():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/benchmarks/after_hostgpu_1440x900.json")
    parser.add_argument("--label", default="after-hostgpu-1440x900")
    parser.add_argument("--url", default="http://localhost:5173/?bench=1&seed=8")
    parser.add_argument("--w", type=int, default=1440)
    parser.add_argument("--h", type=int, default=900)
    parser.add_argument("--duration", type=int, default=8000)
    parser.add_argument("--warmup", type=int, default=1500)
    parser.add_argument("--presets", default="high,balanced,performance")
    parser.add_argument("--gpu", action="store_true")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    browser_args = [
        "--no-sandbox",
        "--ignore-gpu-blocklist",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ]
    if args.gpu:
        browser_args.extend([
            "--use-angle=vulkan",
            "--enable-features=Vulkan",
            "--disable-vulkan-surface",
            "--enable-gpu-rasterization",
            "--disable-gpu-vsync",
            "--disable-frame-rate-limit",
        ])
    else:
        browser_args.extend(["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])

    print(f"Launching browser (gpu={args.gpu}) to run benchmark: {args.label}...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=browser_args)
        context = browser.new_context(viewport={"width": args.w, "height": args.h}, device_scale_factor=1)
        page = context.new_page()

        print(f"Navigating to {args.url}...")
        page.goto(args.url, wait_until="load", timeout=45000)

        # Wait for __lkBench to be ready
        print("Waiting for window.__lkBench.ready...")
        page.wait_for_function("() => window.__lkBench?.ready === true", timeout=90000)

        time.sleep(6.0) # allow initial world history and shaders to settle

        bench_options = {
            "label": args.label,
            "presets": args.presets.split(","),
            "durationMs": args.duration,
            "warmupMs": args.warmup,
        }
        print(f"Running benchmark with options: {bench_options}...")
        report = page.evaluate("(opts) => window.__lkBench.run(opts)", bench_options)

        browser.close()

    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)

    print(f"Successfully wrote {args.out} ({os.path.getsize(args.out)} bytes)")
    if "verdict" in report:
        print(f"Verdict: can_claim_120fps={report['verdict'].get('can_claim_120fps')} - {report['verdict'].get('reason')}")
    if "results" in report:
        for r in report["results"]:
            fi = r.get("frame_interval_ms", {})
            cpu = r.get("cpu_frame_ms", {})
            print(f"  {r.get('preset'):<12} {r.get('scenario'):<18} frames={r.get('frames'):>4} interval p50/p95={fi.get('p50')}/{fi.get('p95')}ms cpu p50/p95={cpu.get('p50')}/{cpu.get('p95')}ms")

if __name__ == "__main__":
    run_bench()
