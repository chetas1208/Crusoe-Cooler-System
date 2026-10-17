"""Resource locks (shared/exclusive) reserved at mission creation and released at mission end, plus the set of
isolated edges (locked out for INPIPE) which persists until the valve is physically re-opened."""
from __future__ import annotations


class ResourceLocks:
    def __init__(self) -> None:
        self.excl: dict[str, str] = {}
        self.shared: dict[str, set] = {}
        self.isolated_edges: dict[str, str] = {}  # edge_id -> owner mission

    def conflicts(self, key: str, owner: str, exclusive: bool) -> str | None:
        e = self.excl.get(key)
        if e and e != owner:
            return e
        if exclusive:
            others = self.shared.get(key, set()) - {owner}
            if others:
                return sorted(others)[0]
        return None

    def try_acquire(self, keys: list, owner: str) -> tuple[bool, str | None]:
        """keys: [(key, exclusive)]. All-or-nothing."""
        for key, ex in keys:
            c = self.conflicts(key, owner, ex)
            if c:
                return False, f"{key} held by {c}"
        for key, ex in keys:
            if ex:
                self.excl[key] = owner
            else:
                self.shared.setdefault(key, set()).add(owner)
        return True, None

    def release_owner(self, owner: str) -> None:
        for k in [k for k, v in self.excl.items() if v == owner]:
            del self.excl[k]
        for k in list(self.shared):
            self.shared[k].discard(owner)
            if not self.shared[k]:
                del self.shared[k]

    def holder_of(self, key: str) -> str | None:
        return self.excl.get(key)

    def blocked_edges(self) -> set:
        return set(self.isolated_edges)

    def to_state(self) -> dict:
        return {"excl": dict(self.excl), "shared": {k: sorted(v) for k, v in self.shared.items()},
                "isolated_edges": dict(self.isolated_edges)}

    def load_state(self, st: dict) -> None:
        self.excl = dict(st["excl"])
        self.shared = {k: set(v) for k, v in st["shared"].items()}
        self.isolated_edges = dict(st["isolated_edges"])
