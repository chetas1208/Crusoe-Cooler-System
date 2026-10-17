import type {
  AgentTask,
  CommandAck,
  CommandRequest,
  ReplayPage,
  StreamEvent,
  TelemetrySeries,
  Topology,
  WorldSnapshot,
} from '../contracts';
import type { ControlApi } from '../control/client';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface TransportInfo {
  kind: 'embedded' | 'live';
  /** human label shown in the status popover, e.g. "In-browser simulator" */
  label: string;
  url?: string;
}

export interface StreamHandlers {
  onEvent(e: StreamEvent): void;
  onConnection(state: ConnectionState): void;
  /** called when the stream detects a sequence gap and needs a fresh snapshot */
  onGap?(): void;
}

/**
 * Everything the UI needs from a backend. Two implementations ship:
 *  - LiveTransport   → REST + WebSocket per backend.md §9 (what the real backend speaks)
 *  - EmbeddedTransport → runs the mock engine in-process (web standalone mode)
 */
export interface Transport {
  readonly info: TransportInfo;
  /** manual-control endpoints (lease / heartbeat / drive / release); absent on backends without them */
  readonly control?: ControlApi;
  fetchTopology(): Promise<Topology>;
  fetchSnapshot(): Promise<WorldSnapshot>;
  fetchTrace(incidentId: string): Promise<AgentTask[]>;
  fetchTelemetry(assetId: string, metric: string, windowS?: number): Promise<TelemetrySeries | null>;
  fetchReplay(fromSeq: number, limit?: number): Promise<ReplayPage>;
  sendCommand(req: CommandRequest): Promise<CommandAck>;
  /** Start streaming. Returns an unsubscribe/close function. */
  connect(sinceSeq: number, handlers: StreamHandlers): () => void;
}
