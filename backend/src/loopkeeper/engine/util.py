"""Small shared helpers: canonical JSON, hashing, ids, validation."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
import zlib
from typing import Any

Json = dict[str, Any]

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$")


def canon(obj: Any) -> str:
    """Canonical JSON (sorted keys, no whitespace). Raises on NaN/Inf so hashes never silently differ."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False, default=_default)


def _default(o: Any) -> Any:
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    if isinstance(o, tuple):
        return list(o)
    if isinstance(o, bytes):
        return base64.b64encode(o).decode()
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


def sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def chash(obj: Any) -> str:
    return sha256_hex(canon(obj))


def clone(obj: Any) -> Any:
    return json.loads(json.dumps(obj, default=_default))


def b64(blob: bytes) -> str:
    return base64.b64encode(zlib.compress(blob, 3)).decode()


def unb64(s: str) -> bytes:
    return zlib.decompress(base64.b64decode(s))


def new_uuid() -> str:
    return str(uuid.uuid4())


def valid_id(x: Any) -> bool:
    return isinstance(x, str) and bool(ID_RE.match(x))


def clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def round_to(x: float, d: int = 2) -> float:
    f = 10 ** d
    return round(x * f) / f
