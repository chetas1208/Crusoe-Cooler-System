"""API settings, read from the environment (placeholders documented in backend/.env.example)."""
from __future__ import annotations

import os
from pathlib import Path
from dataclasses import dataclass, field

DEV_ORIGINS = (
    "http://localhost:5173",   # Vite dev server (apps/web)
    "http://127.0.0.1:5173",
    "http://localhost:4173",   # vite preview
    "http://localhost:8081",   # Expo web / Metro
    "http://localhost:19006",
    "http://localhost:3000",
)
# LAN / loopback / tunnel origins, honoured in dev (a phone, cloudflare tunnel, or remote client hitting dev).
DEV_ORIGIN_REGEX = (
    r"^https?://(.*\.trycloudflare\.com|.*\.vercel\.app|.*\.ngrok-free\.app|.*\.ngrok\.io|"
    r"localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$"
)


def load_dotenv_file() -> None:
    """Load backend/.env (gitignored) without overriding variables already set in the real environment."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover
        return
    here = Path(__file__).resolve()
    # cwd, then backend/.env (symlink to the repo-root .env), then the repo-root .env itself
    for p in (Path.cwd() / ".env", here.parents[3] / ".env", here.parents[4] / ".env"):
        if p.is_file():
            load_dotenv(p, override=False)
            return


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    env: str = "dev"                       # "dev" | "prod"
    host: str = "0.0.0.0"
    port: int = 8787                       # same default as apps/mock-api so VITE_API_URL stays http://localhost:8787
    cors_origins: tuple[str, ...] = DEV_ORIGINS
    cors_origin_regex: str | None = DEV_ORIGIN_REGEX
    auth_disabled: bool = False            # dev-only escape hatch so the stock frontends (no auth header) work
    api_auth_token: str = ""               # single shared bearer (API_AUTH_TOKEN) -> admin principal "api"
    api_tokens: str = ""                   # "token:principal:role[:run1|run2],..."  (see auth.py)
    enable_test_commands: bool = True      # `test.inject_fault`
    replay_page_max: int = 2000
    max_body_bytes: int = 65_536           # request body cap (all routes)
    ws_max_message_bytes: int = 4096       # inbound WS frame cap (clients only send auth/ping)
    ws_auth_timeout_s: float = 5.0
    command_rate_per_s: float = 20.0       # /commands token bucket, per principal
    command_burst: int = 40
    drive_rate_per_s: float = 25.0         # /drive (<=250 ms intents -> 4 Hz nominal, headroom for retries)
    drive_burst: int = 50
    ws_send_timeout_s: float = 10.0
    ws_catchup_page: int = 1000
    expose_docs: bool = True
    max_scenario_faults: int = 20
    max_scenario_duration_s: float = 86_400.0
    lease_ttl_default_s: float = 1.5       # request hint only; the engine decides and enforces
    extra: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv_file()
        env = os.environ.get("LOOPKEEPER_ENV", "dev").strip().lower()
        prod = env in {"prod", "production"}
        origins = os.environ.get("CORS_ALLOW_ORIGINS") or os.environ.get("LOOPKEEPER_CORS_ORIGINS")
        if origins is not None and origins.strip():
            cors = tuple(o.strip() for o in origins.split(",") if o.strip())
        else:
            cors = () if prod else DEV_ORIGINS
        return cls(
            env="prod" if prod else "dev",
            host=os.environ.get("API_HOST") or os.environ.get("LOOPKEEPER_API_HOST", "0.0.0.0"),
            port=_int("API_PORT", _int("LOOPKEEPER_API_PORT", 8787)),
            cors_origins=cors,
            cors_origin_regex=None if prod else DEV_ORIGIN_REGEX,
            auth_disabled=(not prod) and (_bool("LOOPKEEPER_AUTH_DISABLED", False) or _bool("API_AUTH_DISABLED", False)),
            api_tokens=os.environ.get("LOOPKEEPER_API_TOKENS", ""),
            api_auth_token=os.environ.get("API_AUTH_TOKEN", ""),
            enable_test_commands=_bool("LOOPKEEPER_ENABLE_TEST_COMMANDS", not prod),
            replay_page_max=_int("LOOPKEEPER_REPLAY_PAGE_MAX", 2000),
            max_body_bytes=_int("LOOPKEEPER_MAX_BODY_BYTES", 65_536),
            command_rate_per_s=float(os.environ.get("LOOPKEEPER_COMMAND_RATE_PER_S", 20)),
            drive_rate_per_s=float(os.environ.get("LOOPKEEPER_DRIVE_RATE_PER_S", 25)),
            expose_docs=_bool("LOOPKEEPER_EXPOSE_DOCS", not prod),
        )
