/** Counts WebSocket payload bytes (text + binary) for the benchmark. Installed once, before the transport connects. */
let msgs = 0;
let bytes = 0;
let installed = false;

export function installWsCounter() {
  if (installed || typeof WebSocket === 'undefined') return;
  installed = true;
  const Native = window.WebSocket;
  const P = new Proxy(Native, {
    construct(target, args: ConstructorParameters<typeof WebSocket>) {
      const ws = new target(...args);
      ws.addEventListener('message', (e: MessageEvent) => {
        msgs++;
        const d = e.data;
        bytes += typeof d === 'string' ? d.length /* JSON is ASCII: chars ~ bytes */ : d instanceof ArrayBuffer ? d.byteLength : (d as Blob).size ?? 0;
      });
      return ws;
    },
  });
  window.WebSocket = P;
}

export const resetWsStats = () => {
  msgs = 0;
  bytes = 0;
};
export const wsStats = (wallMs: number) => ({
  messages: msgs,
  bytes,
  bytes_per_s: wallMs > 0 ? Math.round((bytes / wallMs) * 1000) : 0,
  note: msgs === 0 ? 'no WebSocket traffic (embedded in-page simulator, or no stream during window)' : 'inbound payload bytes only (excludes frame headers/compression)',
});
