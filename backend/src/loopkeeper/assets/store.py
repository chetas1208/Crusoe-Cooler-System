"""In-memory content-addressed asset store + per-layout compiled-manifest cache (LRU on layouts).

Keyed by ``topology_digest`` (covers layout_hash + everything the compiler reads) and ``MANIFEST_VERSION``; old layouts
stay resolvable by ``rev`` while they are in the LRU, and any layout can be recompiled from its recorded topology
(``/runs/{id}/render-manifest``), so old runs keep the assets of the layout they were created with.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Optional

import gzip

from .compiler import MANIFEST_VERSION, CompiledFacility, compile_facility, topology_digest
from .partition import Partition, build_partition

Json = dict[str, Any]


class AssetService:
    def __init__(self, max_layouts: int = 8) -> None:
        self.max_layouts = max_layouts
        self._lock = threading.RLock()
        self._compiled: "OrderedDict[str, CompiledFacility]" = OrderedDict()   # digest -> compiled
        self._blob_owner: dict[str, set[str]] = {}                              # sha -> digests holding it
        self._memo: dict[tuple[int, str], str] = {}                             # (id(topo), version) -> digest
        self._parts: "OrderedDict[str, Partition]" = OrderedDict()
        self._manifest_gz: dict[str, bytes] = {}
        self.compile_count = 0

    # -- keys ----------------------------------------------------------
    @staticmethod
    def quick_key(topo: Json) -> str:
        f = topo.get("facility", {})
        return f"{f.get('topology_version')}|{f.get('topology_hash')}|{MANIFEST_VERSION}"

    def digest_of(self, topo: Json) -> str:
        k = (id(topo), self.quick_key(topo))
        with self._lock:
            d = self._memo.get(k)
            if d is None:
                if len(self._memo) > 64:
                    self._memo.clear()
                d = self._memo[k] = topology_digest(topo)
            return d

    # -- compile -------------------------------------------------------
    def compiled_for(self, topo: Json) -> CompiledFacility:
        d = self.digest_of(topo)
        with self._lock:
            c = self._compiled.get(d)
            if c is not None:
                self._compiled.move_to_end(d)
                return c
        c = compile_facility(topo)                      # outside the lock would race duplicates; compile is ~1 s, serialize it
        with self._lock:
            if c.topology_digest in self._compiled:
                return self._compiled[c.topology_digest]
            self.compile_count += 1
            self._compiled[c.topology_digest] = c
            self._manifest_gz[c.manifest_id] = gzip.compress(c.manifest_bytes, 9, mtime=0)
            for sha in c.blobs:
                self._blob_owner.setdefault(sha, set()).add(c.topology_digest)
            while len(self._compiled) > self.max_layouts:
                old_d, old = self._compiled.popitem(last=False)
                self._manifest_gz.pop(old.manifest_id, None)
                for sha in old.blobs:
                    owners = self._blob_owner.get(sha, set())
                    owners.discard(old_d)
                    if not owners:
                        self._blob_owner.pop(sha, None)
            return c

    def partition_for(self, topo: Json) -> Partition:
        """Partition only (cheap, no tile compile) - used by stream interest management."""
        d = self.digest_of(topo)
        with self._lock:
            if d in self._compiled:
                return self._compiled[d].partition
            p = self._parts.get(d)
            if p is None:
                p = self._parts[d] = build_partition(topo)
                while len(self._parts) > 8:
                    self._parts.popitem(last=False)
            return p

    # -- lookups -------------------------------------------------------
    def find_rev(self, rev: str) -> Optional[CompiledFacility]:
        with self._lock:
            for c in reversed(self._compiled.values()):
                m = c.manifest
                if rev in (m["topology_version"], m["layout_hash"], c.manifest_id, m["cache_key"], c.topology_digest):
                    return c
        return None

    def blob(self, sha: str) -> Optional[tuple[bytes, Optional[bytes], str]]:
        with self._lock:
            owners = self._blob_owner.get(sha)
            if not owners:
                return None
            for d in owners:
                c = self._compiled.get(d)
                if c and sha in c.blobs:
                    return c.blobs[sha]
        return None

    def manifest_gzip(self, manifest_id: str) -> Optional[bytes]:
        return self._manifest_gz.get(manifest_id)
