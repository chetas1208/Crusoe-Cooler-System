"""Versioned snapshot `state` container (agent AA).

`world_snapshots.state` is bytea. Readers used to call `zlib.decompress(state)` directly (engine/core.py restore, api/runs_storage.py fork). This
module is the single decode point: `decode_state(blob)` accepts BOTH the legacy raw zlib stream (starts with 0x78) and the versioned container
`b"LKS" + version byte + payload`. The decoded bytes are the canonical JSON document, so `content_hash` (sha256 of those bytes) is unchanged by any codec.

Writers keep zlib level 3 (codec "zlib", the legacy bytes, readable by every old reader) until `LOOPKEEPER_SNAPSHOT_CODEC=lzma` is set, which must only
happen after every reader calls `decode_state`. Measured on a real in-process engine state document (200 ticks, 18 robots):
  canonical doc 44 kB: zlib3 24.7 kB (today), zlib9 24.2 kB, lzma 22.9 kB (-7 %: the plant blob inside is base64(zlib) and does not compress twice);
  plant EXPANDED (stored as JSON instead of base64(zlib)): 92.7 kB raw -> zlib3 23.7, zlib9 21.3 (-14 %), lzma6 16.5 kB (-33 %, 32 ms CPU).
So the real win needs the engine to put the plant in the state document uncompressed (owners: engine/core.py `state_doc`, agent K / S for restore) and then
this codec to be flipped to lzma. Nothing here changes bytes written today."""
from __future__ import annotations

import lzma
import os
import zlib

MAGIC = b"LKS"
V_LZMA = 2


def encode_state(canon: bytes, codec: str | None = None) -> bytes:
    codec = codec or os.environ.get("LOOPKEEPER_SNAPSHOT_CODEC", "zlib")
    if codec == "lzma":
        return MAGIC + bytes([V_LZMA]) + lzma.compress(canon, preset=6)
    return zlib.compress(canon, 3)                                   # legacy bytes: old readers keep working


def decode_state(blob: bytes | memoryview) -> bytes:
    b = bytes(blob)
    if b[:3] == MAGIC:
        if b[3] == V_LZMA:
            return lzma.decompress(b[4:])
        raise ValueError(f"unknown snapshot state version {b[3]}")
    return zlib.decompress(b)
