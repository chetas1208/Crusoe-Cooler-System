import type { AgentTask, CommandAck, CommandRequest, ReplayPage, TelemetrySeries, Topology, WorldSnapshot } from '../contracts';
import type { StreamHandlers, Transport, TransportInfo } from '../client/transport';
import type { ControlApi } from '../control/client';
import type { DriveIntent, HeartbeatRequest, LeaseRequest, ReleaseRequest } from '../contracts.control';
import { Engine, EngineRunner, type EngineOptions } from './engine';
import type { RunsApi } from '../runs/api';
import { EmbeddedRunsApi } from '../runs/api';
import { RunRegistry } from '../runs/registry';

/** In-process control endpoint: the same ControlService the mock-api serves over HTTP. Always labelled MOCK. */
export class EngineControlApi implements ControlApi {
  readonly label = 'MOCK · in-browser simulator';
  readonly live = false;
  constructor(private engine: Engine) {}
  async lease(id: string, req: LeaseRequest) {
    return this.engine.control.lease(id, structuredClone(req));
  }
  async heartbeat(id: string, req: HeartbeatRequest) {
    return this.engine.control.heartbeat(id, structuredClone(req));
  }
  async drive(id: string, i: DriveIntent) {
    return structuredClone(this.engine.control.drive(id, structuredClone(i)));
  }
  async release(id: string, req: ReleaseRequest) {
    return structuredClone(this.engine.control.release(id, structuredClone(req)));
  }
}

/**
 * Runs the mock engine inside the page (web standalone mode). It speaks the same
 * Transport interface as LiveTransport so the UI cannot tell the difference —
 * except the health payload honestly says `backend: "mock"`.
 */
export class EmbeddedTransport implements Transport {
  readonly info: TransportInfo = { kind: 'embedded', label: 'In-browser simulator' };
  readonly engine: Engine;
  readonly control: ControlApi;
  private runner: EngineRunner;
  /** run ledger + recorder for the Execution tab (MOCK: records the in-page simulator from tick 0) */
  readonly registry: RunRegistry;
  readonly runsApi: RunsApi;

  constructor(opts: EngineOptions = {}) {
    this.engine = new Engine(opts);
    this.registry = new RunRegistry({ baseline: { engine: this.engine, options: opts } });
    this.runsApi = new EmbeddedRunsApi(this.registry);
    this.runner = new EngineRunner(this.engine);
    this.control = new EngineControlApi(this.engine);
  }

  async fetchTopology(): Promise<Topology> {
    return JSON.parse(JSON.stringify(this.engine.topology));
  }
  async fetchSnapshot(): Promise<WorldSnapshot> {
    return this.engine.snapshot();
  }
  async fetchTrace(incidentId: string): Promise<AgentTask[]> {
    return JSON.parse(JSON.stringify(this.engine.orch.traceFor(incidentId)));
  }
  async fetchTelemetry(assetId: string, metric: string, windowS = 600): Promise<TelemetrySeries | null> {
    return this.engine.telemetry(assetId, metric, windowS);
  }
  async fetchReplay(fromSeq: number, limit = 500): Promise<ReplayPage> {
    return this.engine.replay(fromSeq, limit);
  }
  async sendCommand(req: CommandRequest): Promise<CommandAck> {
    return this.engine.command(req);
  }
  connect(_sinceSeq: number, h: StreamHandlers) {
    const off = this.engine.subscribe((e) => h.onEvent(e));
    this.runner.start();
    h.onConnection('live');
    return () => {
      off();
      this.runner.stop();
    };
  }
}
