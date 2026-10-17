import type { RunsApi } from './api';
import { HASH_ALGO, hashString } from './hash';
import { buildTimeline } from './timeline';
import { RUNS_SCHEMA_VERSION } from './types';

export interface EvidenceFile {
  name: string;
  mime: 'application/json' | 'application/x-ndjson';
  content: string;
  records: number;
}

/**
 * Evidence bundle for one run: manifest.json, run.json (ledger, checkpoints, incident sequences), events.jsonl, and optionally frames.jsonl.
 * Everything is plain JSON/JSONL produced by JSON.stringify (strings escaped); free text from users appears only as JSON string values.
 */
export async function buildEvidence(api: RunsApi, runId: string, opts: { frames?: boolean; range?: [number, number] } = {}): Promise<EvidenceFile[]> {
  const run = await api.getRun(runId);
  const range = opts.range ?? [0, run.current_tick];
  const stride = opts.frames ? 1 : Math.max(1, Math.ceil((range[1] - range[0]) / 4 / 700));
  const w = await api.replay(runId, { start_tick: range[0], end_tick: range[1], stride, events: true });
  const tl = buildTimeline(w.frames, w.events, w.commands);
  const runJson = JSON.stringify({ run, window: { start_tick: w.start_tick, end_tick: w.end_tick, recorded_from_tick: w.recorded_from_tick, recorded_to_tick: w.recorded_to_tick }, checkpoints: w.checkpoints, commands: w.commands, gaps: w.gaps, incidents: tl.incidents }, null, 2);
  const eventsJsonl = w.events.map((e) => JSON.stringify(e)).join('\n') + (w.events.length ? '\n' : '');
  const files: EvidenceFile[] = [
    { name: `${runId}.run.json`, mime: 'application/json', content: runJson, records: 1 },
    { name: `${runId}.events.jsonl`, mime: 'application/x-ndjson', content: eventsJsonl, records: w.events.length },
  ];
  if (opts.frames) {
    files.push({ name: `${runId}.frames.jsonl`, mime: 'application/x-ndjson', content: w.frames.map((f) => JSON.stringify(f)).join('\n') + '\n', records: w.frames.length });
  }
  const manifest = {
    format: 'lk.evidence.v1',
    schema_version: RUNS_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    run_id: runId,
    parent_run_id: run.parent_run_id,
    fork_tick: run.fork_tick,
    backend: run.engine,
    mock: run.engine.backend === 'mock',
    hash_algo: HASH_ALGO,
    hash_note: HASH_ALGO.startsWith('fnv') ? 'Non-cryptographic hash used by the mock for divergence detection; not tamper-evident.' : undefined,
    tick_range: [w.start_tick, w.end_tick],
    sample_stride: stride,
    head_hash: run.head_hash,
    files: files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.content.length, records: f.records, hash: hashString(f.content) })),
    notes: [
      'Agent decisions in events.jsonl are the recorded outputs; replay never re-invokes an agent or model.',
      w.gaps.length ? `${w.gaps.length} gap or reduced-resolution range(s) are listed in run.json; nothing was interpolated.` : 'No gaps in the exported range.',
    ],
  };
  return [{ name: `${runId}.manifest.json`, mime: 'application/json', content: JSON.stringify(manifest, null, 2), records: 1 }, ...files];
}
