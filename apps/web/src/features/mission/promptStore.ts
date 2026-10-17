import { create } from 'zustand';

/**
 * Prompt-status chain for the Execution tab: received -> classified -> interpreted -> scenario_validated -> running.
 * Every timestamp is measured in this browser as the backend's request phase advances (from the V9 /scenario-requests API),
 * and every latency/error shown comes from that API or from a failed call. Nothing is estimated or animated.
 */
export type StepId = 'received' | 'classified' | 'interpreted' | 'scenario_validated' | 'running';
export const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'received', label: 'Received' },
  { id: 'classified', label: 'Classified' },
  { id: 'interpreted', label: 'Interpreted' },
  { id: 'scenario_validated', label: 'Scenario validated' },
  { id: 'running', label: 'Running' },
];

/** backend phase name -> the step it has just ENTERED (a phase is "in progress" work toward the next step) */
const PHASE_DONE: Record<string, StepId[]> = {
  RECEIVED: ['received'],
  CLASSIFYING: ['received'],
  INTERPRETING: ['received', 'classified'],
  VALIDATING: ['received', 'classified', 'interpreted'],
  CREATING_RUN: ['received', 'classified', 'interpreted', 'scenario_validated'],
  RUNNING: ['received', 'classified', 'interpreted', 'scenario_validated', 'running'],
  // CREATING_RUN = injecting into the live run (V11); the step only turns done at RUNNING
};
const PHASE_ACTIVE: Record<string, StepId | undefined> = { CLASSIFYING: 'classified', INTERPRETING: 'interpreted', VALIDATING: 'scenario_validated', CREATING_RUN: 'running' };

export interface StepState {
  id: StepId;
  state: 'pending' | 'active' | 'done' | 'failed';
  /** ms since submit when this step was first observed done (poll-granular: ~0.7 s) */
  atMs: number | null;
}

export interface PromptRequestState {
  requestId: string | null;
  prompt: string;
  startedAt: number | null;
  phase: string | null;
  status: string | null;
  runId: string | null;
  error: { at: StepId | 'submit'; message: string; code?: string } | null;
  steps: StepState[];
  /** server-reported latencies (ms), when the request has them */
  /** V11 live link: what was injected into the live run, what was refused, and the incidents it produced (empty until they open) */
  live: { runId: string | null; injections: Array<{ kind: string; target: string; accepted: boolean; reason?: string }>; rejected: Array<{ family: string; reason: string }>; unsupported: string[]; incidentIds: string[] } | null;
  latencies: { laya_ms?: number; crusoe_ms?: number; total_pipeline_ms?: number } | null;
  engine: { laya?: string; crusoe?: string } | null;
  begin(prompt: string): void;
  update(data: Record<string, unknown>): void;
  fail(at: StepId | 'submit', message: string): void;
  dismiss(): void;
}

const fresh = (): StepState[] => STEPS.map((s) => ({ id: s.id, state: 'pending', atMs: null }));

export const usePromptRequest = create<PromptRequestState>()((set, get) => ({
  requestId: null,
  prompt: '',
  startedAt: null,
  phase: null,
  status: null,
  runId: null,
  error: null,
  steps: fresh(),
  latencies: null,
  live: null,
  engine: null,
  begin: (prompt) => set({ requestId: null, prompt, startedAt: performance.now(), phase: 'RECEIVED', status: 'QUEUED', runId: null, error: null, steps: fresh().map((s) => (s.id === 'received' ? { ...s, state: 'active' as const } : s)), latencies: null, live: null, engine: null }),
  update: (data) => {
    const s = get();
    const phase = typeof data.phase === 'string' ? data.phase : s.phase;
    const status = typeof data.status === 'string' ? data.status : s.status;
    const now = performance.now() - (s.startedAt ?? performance.now());
    const done = new Set<StepId>(phase ? (PHASE_DONE[phase] ?? []) : []);
    const active = phase ? PHASE_ACTIVE[phase] : undefined;
    const failed = status === 'FAILED' || phase === 'FAILED' || status === 'REJECTED' || phase === 'REJECTED';
    const steps = s.steps.map((st) => {
      if (done.has(st.id)) return { ...st, state: 'done' as const, atMs: st.atMs ?? now };
      if (failed && st.state === 'active') return { ...st, state: 'failed' as const };
      if (st.id === active) return { ...st, state: failed ? ('failed' as const) : ('active' as const) };
      return st;
    });
    // a failed request with no active step blames the first step that is not done
    const failedSteps = failed && !steps.some((x) => x.state === 'failed') ? steps.map((x, i, a) => (i === a.findIndex((y) => y.state !== 'done') ? { ...x, state: 'failed' as const } : x)) : steps;
    const interp = data.interpretation as { latencies_ms?: PromptRequestState['latencies']; laya?: { engine?: string }; crusoe?: { model?: string } } | null | undefined;
    const lv = data.live as Record<string, unknown> | null | undefined;
    const live = lv && typeof lv === 'object' ? {
      runId: typeof lv.run_id === 'string' ? lv.run_id : null,
      injections: (Array.isArray(lv.injections) ? lv.injections : []).flatMap((i) => { const o = i as Record<string, unknown>; return o && typeof o.kind === 'string' ? [{ kind: o.kind, target: String(o.target ?? ''), accepted: o.accepted === true, reason: typeof o.reason === 'string' ? o.reason : undefined }] : []; }),
      rejected: (Array.isArray(lv.rejected) ? lv.rejected : []).flatMap((i) => { const o = i as Record<string, unknown>; return o ? [{ family: String(o.family ?? ''), reason: String(o.reason ?? '') }] : []; }),
      unsupported: (Array.isArray(lv.unsupported) ? lv.unsupported : []).map((x) => String(x)),
      incidentIds: (Array.isArray(lv.incident_ids) ? lv.incident_ids : []).map((x) => String(x)),
    } : s.live;
    set({
      live,
      requestId: typeof data.request_id === 'string' ? data.request_id : s.requestId,
      phase,
      status,
      runId: typeof data.run_id === 'string' ? data.run_id : s.runId,
      steps: failedSteps,
      latencies: interp?.latencies_ms && Object.keys(interp.latencies_ms).length ? interp.latencies_ms : s.latencies,
      engine: interp ? { laya: interp.laya?.engine, crusoe: interp.crusoe?.model } : s.engine,
      error: failed ? { at: (failedSteps.find((x) => x.state === 'failed')?.id ?? 'submit') as StepId | 'submit', message: String(data.error_message ?? (status === 'REJECTED' ? 'Request rejected' : 'Scenario pipeline failed')), code: typeof data.error_code === 'string' ? data.error_code : undefined } : s.error,
    });
  },
  fail: (at, message) => set((s) => ({ error: { at, message }, steps: s.steps.map((x) => (x.id === at || (at === 'submit' && x.id === 'received') ? { ...x, state: 'failed' as const } : x)) })),
  dismiss: () => set({ requestId: null, prompt: '', startedAt: null, phase: null, status: null, runId: null, error: null, steps: fresh(), latencies: null, live: null, engine: null }),
}));
