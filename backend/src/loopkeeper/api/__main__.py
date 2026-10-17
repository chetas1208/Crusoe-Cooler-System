"""``python -m loopkeeper.api`` - run the API against the real engine (uvicorn)."""
from __future__ import annotations

import logging
import sys

import uvicorn

from .app import create_app
from .config import Settings
from .wiring import WiringError, build_real_stack


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    # Fail BEFORE touching storage if the port is taken: a second supervisor loop used to start a full engine (recover from Neon, write a
    # "shutdown" snapshot on exit) every ~45 s only to die on "address already in use" - 192 snapshots / ~100 MB of the 1 GB project in a few hours.
    import socket
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        probe.bind((settings.host, settings.port))
    except OSError as e:
        print(f"cannot start: {settings.host}:{settings.port} is already in use ({e.strerror}); not starting a second engine", file=sys.stderr)
        return 3
    finally:
        probe.close()
    try:
        engine, runtime = build_real_stack()
    except WiringError as e:
        print(f"cannot start: {e}\nThe API will not invent an engine. Use the test double only from tests/scripts.", file=sys.stderr)
        return 2
    if settings.auth_disabled:
        logging.getLogger("loopkeeper.api").warning("AUTH DISABLED (dev only): every caller is an admin")
    app = create_app(engine, agent_runtime=runtime, settings=settings)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level="info",
        # behind the Cloudflare tunnel (cloudflared connects from loopback): trust its forwarded headers only
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
        # low-latency streaming: no per-message compression, keep idle sockets alive through the edge
        ws_per_message_deflate=False,
        ws_ping_interval=15.0,
        ws_ping_timeout=20.0,
        timeout_keep_alive=75,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
