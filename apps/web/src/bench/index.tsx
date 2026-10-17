import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { attachRenderer, startSampling, stopSampling, summarize } from './probe';
import { installWsCounter } from './net';
import { runBenchmark, SCENARIOS, type RunOptions } from './run';

/** `?bench` in the URL turns the harness on. Without it none of this code runs and nothing is drawn. */
export const benchEnabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bench');

declare global {
  interface Window {
    __lkBench?: { run: typeof runBenchmark; scenarios: string[]; last: unknown; ready: boolean; sample: { start: () => void; stop: () => ReturnType<typeof summarize> } };
  }
}

export function installBench() {
  if (!benchEnabled) return;
  installWsCounter();
  window.__lkBench = { run: runBenchmark, scenarios: SCENARIOS, last: null, ready: false, sample: { start: startSampling, stop: () => summarize(stopSampling()) } };
}

/** mounted inside <Canvas>: hands the WebGL renderer to the probe */
export function BenchProbe() {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    attachRenderer(gl as THREE.WebGLRenderer);
    if (window.__lkBench) window.__lkBench.ready = true;
  }, [gl]);
  return null;
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Minimal runner for people: Run -> wait -> JSON downloads. No live FPS readout by design. */
export function BenchPanel() {
  const [msg, setMsg] = useState('idle');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<unknown>(null);
  const run = async (presets: RunOptions['presets']) => {
    setBusy(true);
    try {
      const r = await runBenchmark({ presets, label: 'manual', onProgress: setMsg });
      setReport(r);
      if (window.__lkBench) window.__lkBench.last = r;
      download(`loopkeeper-bench-${Date.now()}.json`, r);
      setMsg('done: JSON downloaded');
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 9999, font: '12px/1.4 var(--mono, monospace)', background: 'rgba(10,12,16,.92)', color: '#cfd6e0', border: '1px solid #2b3340', borderRadius: 8, padding: 10, maxWidth: 300 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Benchmark harness</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => run(['high'])}>Run (High)</button>
        <button disabled={busy} onClick={() => run(['high', 'balanced', 'performance'])}>Run all presets</button>
        <button disabled={!report} onClick={() => report && download(`loopkeeper-bench-${Date.now()}.json`, report)}>Save JSON</button>
      </div>
      <div style={{ marginTop: 6, opacity: 0.8 }}>{msg}</div>
      <div style={{ marginTop: 4, opacity: 0.6 }}>Keep this tab focused and visible while it runs.</div>
    </div>
  );
}
