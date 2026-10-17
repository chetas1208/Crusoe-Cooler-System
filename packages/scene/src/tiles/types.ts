export interface ManifestLevel {
  lod: number;
  name: string;
  geometric_error_m: number;
}
export interface ManifestTile {
  tile_id: string;
  zone_id: string;
  lod: number;
  sha256: string;
  url: string;
  bytes: number;
  bytes_gzip: number;
  bounds_min_m: [number, number, number];
  bounds_max_m: [number, number, number];
  geometric_error_m: number;
  refine: 'base' | 'replace_group' | 'add' | string;
  triangles: number;
}
export interface ManifestZone {
  zone_id: string;
  kind: string;
  bounds_min_m: [number, number, number];
  bounds_max_m: [number, number, number];
  parent: string | null;
  neighbors: string[];
  lods: Record<string, string>;
  l0_group?: string;
  meta?: Record<string, unknown>;
}
export interface Manifest {
  manifest_id: string;
  manifest_version: string;
  topology_version: string;
  layout_hash: string;
  levels: ManifestLevel[];
  zones: ManifestZone[];
  tiles: ManifestTile[];
  features: { url: string; sha256: string; count: number };
  limits: { lod0_budget_bytes_gzip?: number; total_bytes_gzip?: number };
}

export interface TileStats {
  manifest_id: string | null;
  resident_tiles: number;
  resident_by_lod: Record<number, number>;
  encoded_bytes: number;
  decoded_gpu_bytes: number;
  triangles_resident: number;
  inflight: number;
  queued: number;
  fetched: number;
  fetched_bytes: number;
  aborted: number;
  evicted: number;
  decode_failures: number;
  cache_hits: number;
  state: 'idle' | 'loading-manifest' | 'ready' | 'failed';
  error: string | null;
}
