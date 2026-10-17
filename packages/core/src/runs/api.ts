import type { Topology } from '../contracts';
import type { CommandAck, CommandRequest, WorldSnapshot } from '../contracts';
import { authFetch } from '../client/auth';
import { ApiError } from './errors';
import type { RunRegistry } from './registry';
import type { CheckpointList, ForkRequest, ForkResult, ModelStatus, ReplayWindow, RunSummary, ScenarioValidateRequest, ScenarioValidation } from './types';

export interface ReplayQuery {
  start_tick?: number;
  end_tick?: number;
  stride?: number;
  events?: boolean;
}

/** What the Execution tab needs from a backend (backend.md §9 Execution rows + §11). */
export interface RunsApi {
  readonly kind: 'embedded' | 'http';
  readonly label: string;
  /** true while the TS simulator (not the real backend) serves this */
  readonly mock: boolean;
  listRuns(): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunSummary>;
  world(id: string): Promise<WorldSnapshot>;
  checkpoints(id: string, toTick?: number): Promise<CheckpointList>;
  replay(id: string, q?: ReplayQuery): Promise<ReplayWindow>;
  fork(id: string, req: ForkRequest): Promise<ForkResult>;
  createRun(spec: unknown): Promise<RunSummary>;
  validateScenario(req: ScenarioValidateRequest): Promise<ScenarioValidation>;
  modelStatus(): Promise<ModelStatus>;
  command(id: string, req: CommandRequest): Promise<CommandAck>;
  setRunState(id: string, state: 'running' | 'paused' | 'stopped'): Promise<RunSummary>;
  /** the topology version this run was recorded with (absent on backends that keep one topology) */
  topology?(id: string): Promise<Topology>;
}

/** In-page implementation over RunRegistry. Results are shared references (read-only by convention) to avoid cloning large windows. */
export class EmbeddedRunsApi implements RunsApi {
  readonly kind = 'embedded' as const;
  readonly label = 'In-browser simulator (MOCK)';
  readonly mock = true;
  constructor(readonly registry: RunRegistry) {}
  private wrap<T>(f: () => T): Promise<T> {
    try {
      return Promise.resolve(f());
    } catch (e) {
      return Promise.reject(e);
    }
  }
  listRuns() {
    return this.wrap(() => this.registry.list());
  }
  getRun(id: string) {
    return this.wrap(() => this.registry.get(id));
  }
  world(id: string) {
    return this.wrap(() => this.registry.world(id));
  }
  checkpoints(id: string, to?: number) {
    return this.wrap(() => this.registry.checkpoints(id, to));
  }
  replay(id: string, q?: ReplayQuery) {
    return this.wrap(() => this.registry.replay(id, q));
  }
  fork(id: string, req: ForkRequest) {
    return this.registry.fork(id, req);
  }
  createRun(spec: unknown) {
    return this.wrap(() => this.registry.createScenarioRun(spec));
  }
  validateScenario(req: ScenarioValidateRequest) {
    return this.wrap(() => this.registry.validate(req));
  }
  modelStatus() {
    return this.wrap(() => this.registry.modelStatus());
  }
  command(id: string, req: CommandRequest) {
    return this.wrap(() => this.registry.command(id, req));
  }
  setRunState(id: string, state: 'running' | 'paused' | 'stopped') {
    return this.wrap(() => this.registry.setState(id, state));
  }
}

/** REST implementation for apps/mock-api and the real backend. */
export class HttpRunsApi implements RunsApi {
  readonly kind = 'http' as const;
  private base: string;
  constructor(
    baseUrl: string,
    readonly mock: boolean,
    readonly label = mock ? 'Mock API (MOCK)' : 'Live backend',
  ) {
    this.base = baseUrl.replace(/\/$/, '') + '/api/v1';
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await authFetch(this.base + path, { method, headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError('not_found', `Cannot reach ${this.base}. Check that the backend is running.`, 0);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const p = (json as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
      throw new ApiError((p?.code as ApiError['code']) ?? (res.status === 404 ? 'not_found' : 'invalid'), p?.message ?? `${method} ${path} → ${res.status}`, res.status, p?.detail);
    }
    return json as T;
  }
  private static arr<T>(x: unknown, what: string): T[] {
    if (!Array.isArray(x)) throw new ApiError('invalid', `Backend returned an unexpected ${what} shape.`, 502);
    return x as T[];
  }
  async listRuns() {
    return HttpRunsApi.arr<RunSummary>(await this.req('GET', '/runs'), 'run list');
  }
  getRun(id: string) {
    return this.req<RunSummary>('GET', `/runs/${encodeURIComponent(id)}`);
  }
  topology(id: string) {
    return this.req<Topology>('GET', `/runs/${encodeURIComponent(id)}/topology`);
  }
  world(id: string) {
    return this.req<WorldSnapshot>('GET', `/runs/${encodeURIComponent(id)}/world`);
  }
  checkpoints(id: string, to?: number) {
    return this.req<CheckpointList>('GET', `/runs/${encodeURIComponent(id)}/checkpoints${to === undefined ? '' : `?to_tick=${Math.floor(to)}`}`);
  }
  replay(id: string, q: ReplayQuery = {}) {
    const p = new URLSearchParams();
    if (q.start_tick !== undefined) p.set('start_tick', String(Math.floor(q.start_tick)));
    if (q.end_tick !== undefined) p.set('end_tick', String(Math.floor(q.end_tick)));
    if (q.stride) p.set('stride', String(Math.floor(q.stride)));
    if (q.events === false) p.set('events', '0');
    return this.req<ReplayWindow>('GET', `/runs/${encodeURIComponent(id)}/replay?${p}`);
  }
  fork(id: string, req: ForkRequest) {
    return this.req<ForkResult>('POST', `/runs/${encodeURIComponent(id)}/fork`, req);
  }
  createRun(spec: unknown) {
    return this.req<RunSummary>('POST', '/runs', spec);
  }
  validateScenario(req: ScenarioValidateRequest) {
    return this.req<ScenarioValidation>('POST', '/scenarios/validate', req);
  }
  modelStatus() {
    return this.req<ModelStatus>('GET', '/models/status');
  }
  command(id: string, req: CommandRequest) {
    return this.req<CommandAck>('POST', `/runs/${encodeURIComponent(id)}/commands`, req);
  }
  setRunState(id: string, state: 'running' | 'paused' | 'stopped') {
    return this.req<RunSummary>('POST', `/runs/${encodeURIComponent(id)}/state`, { state });
  }
}
