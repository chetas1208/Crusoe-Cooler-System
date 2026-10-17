import { bindInterestSender, noteInterestReply } from './interest';
import type {
  AgentTask,
  CommandAck,
  CommandRequest,
  IncidentTrace,
  ReplayPage,
  StreamEvent,
  TelemetrySeries,
  Topology,
  WorldSnapshot,
} from '../contracts';
import type { StreamHandlers, Transport, TransportInfo } from './transport';
import { authFetch, wsProtocols } from './auth';
import { HttpControlApi, type ControlApi } from '../control/client';

/**
 * REST + WebSocket transport that speaks backend.md §9.
 * Works unchanged in browsers and React Native (fetch + WebSocket are globals).
 */
export class LiveTransport implements Transport {
  readonly info: TransportInfo;
  readonly control: ControlApi;
  private base: string;

  constructor(
    baseUrl: string,
    private facilityId = 'lab_01',
    label = 'Live backend',
  ) {
    this.base = baseUrl.replace(/\/$/, '');
    this.info = { kind: 'live', label, url: this.base };
    this.control = new HttpControlApi(this.base, 'current', label);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await authFetch(`${this.base}/api/v1${path}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  fetchTopology() {
    return this.get<Topology>('/topology');
  }
  fetchSnapshot() {
    return this.get<WorldSnapshot>('/world');
  }
  async fetchTrace(incidentId: string): Promise<AgentTask[]> {
    const t = await this.get<IncidentTrace>(`/incidents/${encodeURIComponent(incidentId)}/trace`);
    return t.tasks;
  }
  async fetchTelemetry(assetId: string, metric: string, windowS = 600): Promise<TelemetrySeries | null> {
    try {
      return await this.get<TelemetrySeries>(`/telemetry?asset_id=${encodeURIComponent(assetId)}&metric=${encodeURIComponent(metric)}&window_s=${windowS}`);
    } catch {
      return null;
    }
  }
  fetchReplay(fromSeq: number, limit = 500) {
    return this.get<ReplayPage>(`/replay?from_seq=${fromSeq}&limit=${limit}`);
  }
  async sendCommand(req: CommandRequest): Promise<CommandAck> {
    const res = await authFetch(`${this.base}/api/v1/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await res.json()) as CommandAck;
  }

  connect(sinceSeq: number, h: StreamHandlers) {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let lastSeq = sinceSeq;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (closed) return;
      h.onConnection(retry === 0 ? 'connecting' : 'reconnecting');
      const wsBase = this.base.replace(/^http/, 'ws');
      try {
        ws = new WebSocket(`${wsBase}/api/v1/stream?facility_id=${this.facilityId}&since_seq=${lastSeq}`, wsProtocols());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        h.onConnection('live');
        const sock = ws;
        bindInterestSender((msg) => sock?.readyState === WebSocket.OPEN && sock.send(JSON.stringify(msg)));
      };
      ws.onmessage = (m) => {
        let ev: StreamEvent;
        try {
          ev = JSON.parse(String(m.data)) as StreamEvent;
        } catch {
          return;
        }
        const t = ev.type as string;
        // control messages of the interest protocol: they do not advance the event sequence
        if (t === 'stream.interest') {
          noteInterestReply((ev as unknown as { payload: object }).payload);
          return;
        }
        if (t === 'asset.manifest_changed') {
          if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lk-manifest-changed', { detail: (ev as unknown as { payload: unknown }).payload }));
          return;
        }
        // every event (heartbeats included) carries a seq; a jump means we missed something. Poses the server elided under
        // interest throttling are announced in `elided` and are not a gap.
        const elided = (ev as unknown as { elided?: number }).elided ?? 0;
        if (ev.type !== 'snapshot' && ev.seq > lastSeq + 1 + elided && lastSeq > 0) h.onGap?.();
        if (ev.type === 'snapshot') lastSeq = ev.seq || (ev.payload as WorldSnapshot).last_seq;
        else if (ev.seq > lastSeq) lastSeq = ev.seq;
        h.onEvent(ev);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        bindInterestSender(null);
        ws = null;
        if (!closed) schedule();
      };
    };

    const schedule = () => {
      if (closed) return;
      retry++;
      h.onConnection(retry > 3 ? 'offline' : 'reconnecting');
      const delay = Math.min(500 * 2 ** Math.min(retry, 4), 5000);
      timer = setTimeout(open, delay);
    };

    open();
    return () => {
      closed = true;
      bindInterestSender(null);
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }
}
