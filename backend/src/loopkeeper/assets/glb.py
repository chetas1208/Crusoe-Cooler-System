"""Minimal deterministic GLB (glTF 2.0 binary) writer.

No timestamps, no random ids, fixed key order, 4-byte aligned views: the same input always yields the same bytes,
so ``sha256(bytes)`` is a stable content address.  Extensions used (all optional-for-render except where noted):
``EXT_mesh_gpu_instancing`` (LOD0 instanced boxes) and custom ``_FEATURE_ID`` / ``_S_M`` attributes.
"""
from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125
_CT = {np.dtype("float32"): FLOAT, np.dtype("uint8"): UBYTE, np.dtype("uint16"): USHORT, np.dtype("uint32"): UINT}
_TYPE = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

# material name -> (rgba, metallic, roughness, doubleSided)
MATERIALS: dict[str, tuple[tuple[float, float, float, float], float, float, bool]] = {
    "lk.floor": ((0.50, 0.52, 0.55, 1.0), 0.0, 0.95, False),
    "lk.wall": ((0.72, 0.74, 0.77, 1.0), 0.0, 0.9, False),
    "lk.column": ((0.62, 0.64, 0.68, 1.0), 0.1, 0.8, False),
    "lk.corridor": ((0.95, 0.80, 0.20, 1.0), 0.0, 0.9, False),
    "lk.rack": ((0.16, 0.18, 0.22, 1.0), 0.4, 0.55, False),
    "lk.rack.detail": ((0.30, 0.34, 0.40, 1.0), 0.6, 0.4, False),
    "lk.equipment": ((0.78, 0.80, 0.84, 1.0), 0.5, 0.45, False),
    "lk.dock": ((0.20, 0.65, 0.40, 1.0), 0.0, 0.8, False),
    "lk.pipe.tcs.supply": ((0.18, 0.46, 0.86, 1.0), 0.6, 0.35, False),
    "lk.pipe.tcs.return": ((0.88, 0.42, 0.16, 1.0), 0.6, 0.35, False),
    "lk.pipe.fws.supply": ((0.10, 0.62, 0.70, 1.0), 0.6, 0.35, False),
    "lk.pipe.fws.return": ((0.70, 0.30, 0.45, 1.0), 0.6, 0.35, False),
    "lk.pipe.bore": ((0.55, 0.57, 0.60, 1.0), 0.8, 0.5, True),
    "lk.valve": ((0.85, 0.15, 0.15, 1.0), 0.5, 0.4, False),
    "lk.sensor": ((0.95, 0.85, 0.25, 1.0), 0.2, 0.5, False),
    "lk.support": ((0.35, 0.36, 0.38, 1.0), 0.7, 0.6, False),
    "lk.fitting": ((0.60, 0.62, 0.66, 1.0), 0.8, 0.4, False),
}


class GlbBuilder:
    def __init__(self) -> None:
        self.bin = bytearray()
        self.views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.nodes: list[dict] = []
        self.materials: list[dict] = []
        self._mat_index: dict[str, int] = {}
        self.extensions_used: list[str] = []
        self.asset_extras: dict[str, Any] = {}

    # -- buffers -------------------------------------------------------
    def accessor(self, arr: np.ndarray, *, target: int | None = None, minmax: bool = False) -> int:
        arr = np.ascontiguousarray(arr)
        ncomp = 1 if arr.ndim == 1 else arr.shape[1]
        raw = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        while len(self.bin) % 4:
            self.bin.append(0)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(raw)}
        if target:
            view["target"] = target
        self.bin += raw
        self.views.append(view)
        acc: dict[str, Any] = {"bufferView": len(self.views) - 1, "componentType": _CT[arr.dtype], "count": int(arr.shape[0]),
                               "type": _TYPE[ncomp]}
        if minmax and arr.shape[0]:
            mn, mx = arr.min(axis=0), arr.max(axis=0)
            acc["min"] = [round(float(v), 6) for v in np.atleast_1d(mn)]
            acc["max"] = [round(float(v), 6) for v in np.atleast_1d(mx)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def material(self, name: str) -> int:
        if name not in self._mat_index:
            rgba, met, rough, dbl = MATERIALS[name]
            self.materials.append({"name": name, "doubleSided": dbl, "pbrMetallicRoughness": {
                "baseColorFactor": list(rgba), "metallicFactor": met, "roughnessFactor": rough}})
            self._mat_index[name] = len(self.materials) - 1
        return self._mat_index[name]

    def mesh_primitive(self, material: str, pos: np.ndarray, idx: np.ndarray, *, nrm: np.ndarray | None = None,
                       feat: np.ndarray | None = None, s_m: np.ndarray | None = None, mode: int = 4) -> dict:
        attrs: dict[str, int] = {"POSITION": self.accessor(pos.astype(np.float32), target=ARRAY_BUFFER, minmax=True)}
        if nrm is not None:
            attrs["NORMAL"] = self.accessor(nrm.astype(np.float32), target=ARRAY_BUFFER)
        if feat is not None:
            attrs["_FEATURE_ID"] = self.accessor(feat.astype(np.uint16), target=ARRAY_BUFFER)
        if s_m is not None:
            attrs["_S_M"] = self.accessor(s_m.astype(np.float32), target=ARRAY_BUFFER)
        ity = np.uint16 if pos.shape[0] <= 65535 else np.uint32
        return {"attributes": attrs, "indices": self.accessor(idx.astype(ity).reshape(-1), target=ELEMENT_ARRAY_BUFFER),
                "material": self.material(material), "mode": mode}

    def add_mesh_node(self, name: str, primitives: list[dict], extras: dict | None = None, extensions: dict | None = None) -> int:
        self.meshes.append({"name": name, "primitives": primitives})
        node: dict[str, Any] = {"name": name, "mesh": len(self.meshes) - 1}
        if extras:
            node["extras"] = extras
        if extensions:
            node["extensions"] = extensions
        self.nodes.append(node)
        return len(self.nodes) - 1

    def use_extension(self, name: str) -> None:
        if name not in self.extensions_used:
            self.extensions_used.append(name)

    # -- output --------------------------------------------------------
    def to_bytes(self) -> bytes:
        doc: dict[str, Any] = {"asset": {"version": "2.0", "generator": "loopkeeper.assets", "extras": self.asset_extras}}
        if self.extensions_used:
            doc["extensionsUsed"] = self.extensions_used
        doc["scene"] = 0
        doc["scenes"] = [{"nodes": list(range(len(self.nodes)))}]
        doc["nodes"] = self.nodes
        doc["meshes"] = self.meshes
        doc["materials"] = self.materials
        doc["accessors"] = self.accessors
        doc["bufferViews"] = self.views
        while len(self.bin) % 4:
            self.bin.append(0)
        doc["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(doc, separators=(",", ":"), ensure_ascii=True).encode()
        js += b" " * (-len(js) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        return (struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<I4s", len(js), b"JSON") + js
                + struct.pack("<I4s", len(self.bin), b"BIN\x00") + bytes(self.bin))


def parse_glb(data: bytes) -> tuple[dict, bytes]:
    """Inverse of ``to_bytes`` (used by tests and the format doc's reference reader)."""
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError("not a GLB 2.0 container")
    jl, jt = struct.unpack_from("<I4s", data, 12)
    doc = json.loads(data[20:20 + jl])
    off = 20 + jl
    bl, bt = struct.unpack_from("<I4s", data, off)
    return doc, data[off + 8: off + 8 + bl]


def read_accessor(doc: dict, binary: bytes, index: int) -> np.ndarray:
    a = doc["accessors"][index]
    v = doc["bufferViews"][a["bufferView"]]
    dt = {FLOAT: np.float32, UBYTE: np.uint8, USHORT: np.uint16, UINT: np.uint32}[a["componentType"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    arr = np.frombuffer(binary, dtype=dt, count=a["count"] * n, offset=v["byteOffset"])
    return arr.reshape(a["count"], n) if n > 1 else arr
