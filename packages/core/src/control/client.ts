/**
 * Typed client for the manual-control endpoints (backend.md §9/§10). Transport-agnostic: the HTTP
 * implementation talks to the real backend (or apps/mock-api); the embedded transport supplies an
 * in-process implementation that calls the same server-side ControlService.
 *
 * Network failures REJECT with ControlNetworkError (the session treats that as a lost link);
 * protocol refusals RESOLVE with `{accepted: false, code, reason}` so callers can show the real reason.
 */
import { authFetch } from '../client/auth';
import type {
  ControlRefusal,
  DriveIntent,
  DriveResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  LeaseRequest,
  LeaseResponse,
  ReleaseRequest,
  ReleaseResponse,
} from '../contracts.control';

export class ControlNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlNetworkError';
  }
}

export interface CallOptions {
  /** let the request outlive the page (pagehide / tab close) */
  keepalive?: boolean;
  timeoutMs?: number;
}

export interface ControlApi {
  /** shown next to the control state, e.g. "MOCK · in-browser simulator" */
  readonly label: string;
  /** false for the mock simulators */
  readonly live: boolean;
  lease(robotId: string, req: LeaseRequest, o?: CallOptions): Promise<LeaseResponse>;
  heartbeat(robotId: string, req: HeartbeatRequest, o?: CallOptions): Promise<HeartbeatResponse>;
  drive(robotId: string, intent: DriveIntent, o?: CallOptions): Promise<DriveResponse>;
  release(robotId: string, req: ReleaseRequest, o?: CallOptions): Promise<ReleaseResponse>;
}

export class HttpControlApi implements ControlApi {
  private base: string;
  constructor(
    baseUrl: string,
    private runId = 'current',
    readonly label = 'Live backend',
    readonly live = true,
  ) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async post<T>(robotId: string, path: string, body: unknown, o?: CallOptions): Promise<T | ControlRefusal> {
    const url = `${this.base}/api/v1/runs/${encodeURIComponent(this.runId)}/robots/${encodeURIComponent(robotId)}/${path}`;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), o?.timeoutMs ?? 2500) : null;
    try {
      const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        keepalive: o?.keepalive,
        signal: ctl?.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ControlNetworkError(`${path} → ${res.status} (unreadable response)`);
      }
      if (json && typeof json === 'object' && 'accepted' in json) return json as T | ControlRefusal;
      throw new ControlNetworkError(`${path} → ${res.status}`);
    } catch (err) {
      if (err instanceof ControlNetworkError) throw err;
      throw new ControlNetworkError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  lease(robotId: string, req: LeaseRequest, o?: CallOptions) {
    return this.post<LeaseResponse>(robotId, 'control/lease', req, o) as Promise<LeaseResponse>;
  }
  heartbeat(robotId: string, req: HeartbeatRequest, o?: CallOptions) {
    return this.post<HeartbeatResponse>(robotId, 'control/heartbeat', req, o) as Promise<HeartbeatResponse>;
  }
  drive(robotId: string, intent: DriveIntent, o?: CallOptions) {
    return this.post<DriveResponse>(robotId, 'drive', intent, o) as Promise<DriveResponse>;
  }
  release(robotId: string, req: ReleaseRequest, o?: CallOptions) {
    return this.post<ReleaseResponse>(robotId, 'control/release', req, o) as Promise<ReleaseResponse>;
  }
}
