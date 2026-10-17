"""HTTP hardening: security headers, request-size cap, token-bucket rate limits, idempotency-key cache."""
from __future__ import annotations

import json
import time
import uuid
from collections import OrderedDict
from typing import Any, Awaitable, Callable

API_PREFIX = "/api/v1"

_API_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
    (b"cache-control", b"no-store"),
    (b"referrer-policy", b"no-referrer"),
    (b"permissions-policy", b"geolocation=(), camera=(), microphone=()"),
]
_BASE_HEADERS = [(b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY")]


class _TooLarge(Exception):
    pass


class SecurityMiddleware:
    """Pure-ASGI: adds security headers to every HTTP response and enforces a body size cap."""

    def __init__(self, app: Any, max_body_bytes: int) -> None:
        self.app = app
        self.max_body = max_body_bytes

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = _API_HEADERS if scope["path"].startswith(API_PREFIX) else _BASE_HEADERS
        started = False

        async def send_wrapped(msg: dict) -> None:
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
                have = {k.lower() for k, _ in msg.get("headers", [])}
                msg = {**msg, "headers": list(msg.get("headers", [])) + [h for h in headers if h[0] not in have]}
            await send(msg)

        async def too_large() -> None:
            body = b'{"error":{"code":"too_large","message":"request body too large"},"detail":"request body too large"}'
            await send_wrapped({"type": "http.response.start", "status": 413,
                                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send_wrapped({"type": "http.response.body", "body": body})

        declared = dict(scope.get("headers", [])).get(b"content-length")
        if declared and declared.isdigit() and int(declared) > self.max_body:
            return await too_large()
        total = 0

        async def receive_capped() -> dict:
            nonlocal total
            msg = await receive()
            if msg["type"] == "http.request":
                total += len(msg.get("body", b""))
                if total > self.max_body:
                    raise _TooLarge()
            return msg

        try:
            await self.app(scope, receive_capped, send_wrapped)
        except _TooLarge:
            if not started:
                await too_large()


class TokenBuckets:
    """Per-(bucket, principal) token bucket. ``allow`` returns (ok, retry_after_s)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._b: dict[tuple[str, str], tuple[float, float]] = {}

    def allow(self, bucket: str, who: str, rate: float, burst: int) -> tuple[bool, float]:
        now = self._clock()
        tokens, last = self._b.get((bucket, who), (float(burst), now))
        tokens = min(float(burst), tokens + (now - last) * rate)
        if tokens >= 1.0:
            self._b[(bucket, who)] = (tokens - 1.0, now)
            return True, 0.0
        self._b[(bucket, who)] = (tokens, now)
        return False, (1.0 - tokens) / rate if rate > 0 else 1.0


class IdempotencyCache:
    """Maps a client idempotency key to the server-minted command id (UUIDv4) so retries are not re-applied."""

    def __init__(self, ttl_s: float = 600.0, cap: int = 4096) -> None:
        self._ttl, self._cap = ttl_s, cap
        self._d: "OrderedDict[tuple, tuple[str, float]]" = OrderedDict()

    def command_id(self, *key: str) -> str:
        now = time.monotonic()
        k = tuple(key)
        hit = self._d.get(k)
        if hit and hit[1] > now:
            return hit[0]
        cid = str(uuid.uuid4())
        self._d[k] = (cid, now + self._ttl)
        self._d.move_to_end(k)
        while len(self._d) > self._cap:
            self._d.popitem(last=False)
        return cid


_CODE_FOR_STATUS = {400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "read_only",
                    413: "too_large", 422: "invalid", 429: "rate_limited", 501: "unsupported", 502: "internal",
                    503: "unavailable"}


def json_error(msg: str, code: str = "invalid", **extra: Any) -> dict[str, Any]:
    """Wire error body: ``{error: {code, message}, detail}`` - the shape HttpRunsApi parses (runs/api.ts).

    ``detail`` repeats the message for FastAPI-style consumers. Never carries stack traces or request input.
    """
    return {"error": {"code": code, "message": msg, **extra}, "detail": msg}


def code_for_status(status: int) -> str:
    return _CODE_FOR_STATUS.get(status, "internal" if status >= 500 else "invalid")
