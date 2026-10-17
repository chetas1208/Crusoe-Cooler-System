/**
 * Execution routes (backend.md §9 Execution rows, §11) served from the TS simulator. MOCK.
 * The run ledger, recorder, replay, fork and scenario validation live in @loopkeeper/core/runs/engine; this file is only HTTP.
 */
import type http from 'node:http';
import { RunRegistry } from '@loopkeeper/core/runs/engine';
import { ApiError } from '@loopkeeper/core/runs';
import type { Engine, EngineOptions } from '@loopkeeper/core/engine';
import type { CommandRequest } from '@loopkeeper/core/contracts';

const MAX_BODY = 256 * 1024;

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > MAX_BODY) {
        reject(new ApiError('invalid', 'Request body too large.', 413));
        req.destroy();
      }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });

const num = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function createRunsRouter(engine: Engine, options: EngineOptions) {
  const registry = new RunRegistry({ baseline: { engine, options }, backend: 'mock' });
  const parse = async (req: http.IncomingMessage): Promise<unknown> => {
    const raw = await readBody(req);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new ApiError('invalid', 'Body is not valid JSON.', 422);
    }
  };

  /** returns true when the request was handled */
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
    const base = '/api/v1';
    if (!p.startsWith(`${base}/runs`) && p !== `${base}/scenarios/validate` && p !== `${base}/models/status`) return false;
    try {
      const rest = p.slice(base.length);
      if (rest === '/models/status') {
        send(res, 200, registry.modelStatus());
        return true;
      }
      if (rest === '/scenarios/validate' && req.method === 'POST') {
        const body = (await parse(req)) as { spec?: unknown; text?: unknown };
        send(res, 200, registry.validate({ spec: body.spec, text: typeof body.text === 'string' ? body.text : undefined }));
        return true;
      }
      if (rest === '/runs' && req.method === 'GET') {
        send(res, 200, registry.list());
        return true;
      }
      if (rest === '/runs' && req.method === 'POST') {
        send(res, 201, registry.createScenarioRun(await parse(req)));
        return true;
      }
      const m = rest.match(/^\/runs\/([^/]+)(?:\/(world|checkpoints|replay|fork|commands|state))?$/);
      if (!m) return false;
      const id = decodeURIComponent(m[1]);
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        send(res, 200, registry.get(id));
        return true;
      }
      if (sub === 'world' && req.method === 'GET') {
        send(res, 200, registry.world(id));
        return true;
      }
      if (sub === 'checkpoints' && req.method === 'GET') {
        send(res, 200, registry.checkpoints(id, num(url.searchParams.get('to_tick'))));
        return true;
      }
      if (sub === 'replay' && req.method === 'GET') {
        send(res, 200, registry.replay(id, { start_tick: num(url.searchParams.get('start_tick')), end_tick: num(url.searchParams.get('end_tick')), stride: num(url.searchParams.get('stride')), events: url.searchParams.get('events') !== '0' }));
        return true;
      }
      if (sub === 'fork' && req.method === 'POST') {
        send(res, 201, await registry.fork(id, (await parse(req)) as never));
        return true;
      }
      if (sub === 'commands' && req.method === 'POST') {
        send(res, 200, registry.command(id, (await parse(req)) as CommandRequest));
        return true;
      }
      if (sub === 'state' && req.method === 'POST') {
        const s = ((await parse(req)) as { state?: string }).state;
        if (s !== 'running' && s !== 'paused' && s !== 'stopped') throw new ApiError('invalid', 'state must be running, paused or stopped.', 422);
        send(res, 200, registry.setState(id, s));
        return true;
      }
      return false;
    } catch (err) {
      if (err instanceof ApiError) send(res, err.status || 400, { error: { code: err.code, message: err.message, detail: err.detail } });
      else send(res, 500, { error: { code: 'invalid', message: String(err) } });
      return true;
    }
  };
}
