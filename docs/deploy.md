# Deployment: frontend on Vercel, backend on our server behind a Cloudflare tunnel

```
browser ──https──> Vercel (static SPA, apps/web)          your-app.vercel.app (Vercel login required)
   │
   └──https/wss──> *.trycloudflare.com ──QUIC──> cloudflared ──> 127.0.0.1:8787  FastAPI + engine ──> Neon Postgres
```

## Run / operate (on the server)
- `scripts/supervise.sh start|stop|status|url` keeps the API and the tunnel alive (restart loops). Cron (`crontab -l`, tagged `# loopkeeper`) starts it at reboot and re-checks every 2 min; a 6-hourly `vercel whoami` keeps the Vercel CLI login refreshed.
- Logs: `.state/api.out`, `.state/tunnel.log`. Current tunnel URL: `scripts/supervise.sh url` (also `.state/tunnel_url`).
- Config: root `.env` (gitignored). Auth is OFF by the owner's decision (`API_AUTH_DISABLED=true`): anyone who has the tunnel URL can call the API, including commands, robot control and run forking. CORS only restricts browsers, not direct callers. Set `API_AUTH_DISABLED=false` and restart the API to turn it back on (the web app's token dialog reappears on any 401).

## Connect the web app to the backend
Quick tunnels get a **new URL on every start**, so the URL is set at runtime, not at build time:
open `https://your-app.vercel.app/?api=<tunnel url>` once (only `*.trycloudflare.com` and localhost are accepted), (no token needed while auth is off). The URL is kept in that browser only. `?api=reset` forgets the URL. After a tunnel restart, open the link with the new URL.
A named tunnel on your own domain gives a stable hostname (needs a Cloudflare zone + `cloudflared tunnel login`).

## Vercel
Project `loopkeeper` (team Chetas Parekh's projects) is linked to GitHub `chetas1208/loopkeeper`, root directory `apps/web`, config in `apps/web/vercel.json`
(pnpm workspace install, SPA rewrite, CSP/HSTS headers). Every push to `main` deploys to production.
Deploy access: the CLI login refreshes itself, but a long-lived token is sturdier — create one at https://vercel.com/account/tokens and run `scripts/save-vercel-token.sh`.

## Tunnel tuning (high frequency)
QUIC transport (UDP; falls back to HTTP/2 with `TUNNEL_PROTOCOL=http2`), uvicorn WebSocket with no per-message deflate, 15 s keepalive pings, proxy headers trusted from loopback only.
Measured through the tunnel: REST `/world` p50 55 ms / p95 95 ms; stream carries `world.diff` ~2 Hz, `robot.pose` ~10 Hz while robots move. Quick tunnels pin 1 edge connection and have no SLA.
Limits of the free quick tunnel: random URL per start, no uptime guarantee, ~200 concurrent requests; the host's UDP receive buffer is small (416 kiB; raising it needs root `sysctl net.core.rmem_max`).
