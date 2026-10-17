"""GPU / NVENC / WebRTC-prerequisite PROBE (V7 section 5). Probe only: nothing here starts, enables or implements streaming.

    python -m loopkeeper.assets.gpu_probe [--out artifacts/perf/gpu_probe.json]

Every fact is measured from the running host (nvidia-smi, ffmpeg, dlopen of libnvidia-encode, python imports, PATH lookups);
anything that cannot be determined is reported as ``null`` with a reason, never guessed.
"""
from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

Json = dict[str, Any]
DEFAULT_OUT = Path(__file__).resolve().parents[4] / "artifacts" / "perf" / "gpu_probe.json"


def _run(cmd: list[str], timeout: float = 15.0) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, "not found"
    except Exception as e:  # noqa: BLE001
        return 1, f"{type(e).__name__}: {e}"


def nvidia_smi() -> Json:
    if not shutil.which("nvidia-smi"):
        return {"available": False, "reason": "nvidia-smi not on PATH"}
    q = "index,name,uuid,pci.bus_id,driver_version,memory.total,memory.used,utilization.gpu,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency,compute_cap"
    rc, out = _run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"])
    if rc != 0:     # older drivers lack some query fields
        q = "index,name,uuid,pci.bus_id,driver_version,memory.total,memory.used,utilization.gpu"
        rc, out = _run(["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"])
    gpus = []
    if rc == 0:
        keys = q.split(",")
        for line in out.strip().splitlines():
            vals = [v.strip() for v in line.split(",")]
            gpus.append(dict(zip(keys, vals)))
    _, head = _run(["nvidia-smi"])
    cuda = re.search(r"CUDA Version:\s*([\d.]+)", head)
    _, enc = _run(["nvidia-smi", "-q", "-d", "ENCODER_STATS"])
    sessions = [int(m) for m in re.findall(r"Active Sessions\s*:\s*(\d+)", enc)]
    return {"available": rc == 0, "gpu_count": len(gpus), "gpus": gpus, "cuda_version_driver": cuda.group(1) if cuda else None,
            "encoder_active_sessions_per_gpu": sessions, "raw_query": q}


def ffmpeg_encoders() -> Json:
    ff = shutil.which("ffmpeg")
    if not ff:
        return {"available": False, "reason": "ffmpeg not on PATH"}
    _, ver = _run([ff, "-hide_banner", "-version"])
    rc, out = _run([ff, "-hide_banner", "-encoders"])
    names = re.findall(r"^\s*V\S*\s+(\S+)", out, flags=re.M)
    hw = [n for n in names if any(k in n for k in ("nvenc", "qsv", "vaapi", "amf", "v4l2m2m", "videotoolbox"))]
    sw = [n for n in names if n in ("libx264", "libvpx", "libvpx-vp9", "libaom-av1", "libsvtav1", "libx265")]
    return {"available": rc == 0, "path": ff, "version": ver.splitlines()[0] if ver else None, "hardware_video_encoders": hw, "software_video_encoders": sw,
            "nvenc_encoders": [n for n in names if "nvenc" in n], "ffmpeg_built_with_nvenc": any("nvenc" in n for n in names),
            "cuda_hwaccel_listed": "cuda" in _run([ff, "-hide_banner", "-hwaccels"])[1]}


def nvenc_api() -> Json:
    """dlopen libnvidia-encode and ask the driver for the NVENC API version it supports (no session is created)."""
    res: Json = {"library": None, "loadable": False, "max_supported_api_version": None}
    for name in ("libnvidia-encode.so.1", "libnvidia-encode.so"):
        try:
            lib = ctypes.CDLL(name)
        except OSError as e:
            res["error"] = str(e)
            continue
        res["library"], res["loadable"] = name, True
        try:
            v = ctypes.c_uint32(0)
            rc = lib.NvEncodeAPIGetMaxSupportedVersion(ctypes.byref(v))
            if rc == 0:
                res["max_supported_api_version"] = f"{v.value >> 4}.{v.value & 0xF}"
            else:
                res["error"] = f"NvEncodeAPIGetMaxSupportedVersion returned {rc}"
        except Exception as e:  # noqa: BLE001
            res["error"] = f"{type(e).__name__}: {e}"
        break
    return res


def webrtc_prereqs() -> Json:
    mods = {m: bool(importlib.util.find_spec(m)) for m in ("aiortc", "av", "aioice", "cv2", "playwright", "pyvirtualdisplay")}
    bins = {b: shutil.which(b) for b in ("turnserver", "coturn", "gst-launch-1.0", "chromium", "chromium-browser", "google-chrome", "vulkaninfo", "eglinfo", "Xvfb", "xvfb-run")}
    ports_note = "UDP 3478 (TURN) + ephemeral UDP relay range must be reachable from clients; not probed from outside this host"
    return {"python_modules": mods, "binaries": {k: v for k, v in bins.items()},
            "dri_devices": sorted(os.listdir("/dev/dri")) if os.path.isdir("/dev/dri") else [],
            "nvidia_device_nodes": sorted(p for p in os.listdir("/dev") if p.startswith("nvidia")),
            "display_env": {"DISPLAY": os.environ.get("DISPLAY"), "WAYLAND_DISPLAY": os.environ.get("WAYLAND_DISPLAY")},
            "tls_note": "WebRTC needs a secure origin (https/localhost) + TURN credentials issued server-side; none configured by this probe",
            "network_note": ports_note}


def gates(report: Json) -> list[Json]:
    nv, ff, api, rtc = report["nvidia_smi"], report["ffmpeg"], report["nvenc_api"], report["webrtc"]
    g = [
        {"gate": "GPU present", "pass": bool(nv.get("available") and nv.get("gpu_count")), "detail": f"{nv.get('gpu_count')} GPU(s)"},
        {"gate": "NVENC API in driver", "pass": bool(api.get("max_supported_api_version")), "detail": api.get("max_supported_api_version") or api.get("error")},
        {"gate": "usable encoder binding (ffmpeg nvenc / PyAV)", "pass": bool(ff.get("ffmpeg_built_with_nvenc") or rtc["python_modules"].get("av")),
         "detail": "ffmpeg has no *_nvenc encoder and PyAV is not installed" if not (ff.get("ffmpeg_built_with_nvenc") or rtc["python_modules"].get("av")) else "ok"},
        {"gate": "headless GPU renderer (browser/EGL/Vulkan on the NVIDIA GPU)", "pass": False,
         "detail": "not verified: no remote renderer exists yet and none was started by this probe"},
        {"gate": "WebRTC stack (aiortc/GStreamer)", "pass": bool(rtc["python_modules"].get("aiortc") or rtc["binaries"].get("gst-launch-1.0")),
         "detail": "no aiortc and no GStreamer found" if not (rtc["python_modules"].get("aiortc") or rtc["binaries"].get("gst-launch-1.0")) else "ok"},
        {"gate": "TURN relay", "pass": bool(rtc["binaries"].get("turnserver") or rtc["binaries"].get("coturn")), "detail": "no coturn/turnserver binary found"},
        {"gate": "local renderer fixed first (V7 section 0 hard gate)", "pass": False, "detail": "local LOD streaming + perf audit not yet signed off"},
        {"gate": "measured remote latency better than local", "pass": False, "detail": "never measured: no remote path implemented"},
    ]
    return g


def probe() -> Json:
    rep: Json = {"schema": "lk.gpu_probe.v1", "generated_at_unix": int(time.time()), "host": platform.node(), "platform": platform.platform(), "python": sys.version.split()[0]}
    rep["nvidia_smi"] = nvidia_smi()
    rep["ffmpeg"] = ffmpeg_encoders()
    rep["nvenc_api"] = nvenc_api()
    rep["webrtc"] = webrtc_prereqs()
    rep["gates"] = gates(rep)
    failed = [g for g in rep["gates"] if not g["pass"]]
    rep["remote_streaming"] = {
        "enabled": False, "implemented": False,
        "status": "remote streaming gated: " + "; ".join(f"{g['gate']} ({g['detail']})" for g in failed) if failed else "remote streaming gated: all probes passed but remote streaming stays opt-in and unimplemented",
        "policy": "never auto-enabled; local LOD renderer is the default; one physics worker only",
    }
    return rep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args(argv)
    rep = probe()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out}\n{rep['remote_streaming']['status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
