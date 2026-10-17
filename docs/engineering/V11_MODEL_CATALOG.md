# V11 model catalog, capabilities and gateway (Agent C)

Source of truth: `artifacts/v11/model_catalog.json` (GET /models, catalog date **2026-10-17T18:20:01Z**, host api.inference.crusoecloud.com) and `artifacts/v11/capability_probe.json`
(real requests, `cd backend && set -a && . ../.env && set +a && uv run python -m loopkeeper.inference.probe`; total probe spend <= $0.0022).
The catalog lists 13 models; the app uses two. Pricing is the catalog's `pricing.prompt/completion`; the API does not state a unit, we treat it as USD per 1M tokens, so all costs are **estimates**.

| model | context | price in/out | tools | json_object | json_schema | structured_outputs | seed | latency (thinking off, 120 tok) | latency (thinking on) |
|---|---|---|---|---|---|---|---|---|---|
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262144 | $0.05 / $0.2 | True | True | True | True | True | 0.31 s | 0.49 s |
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` | 262144 | $0.3 / $2.4 | True | True | True | True | True | 0.39 s | 0.74 s |

Measured behaviour: `chat_template_kwargs={"enable_thinking": false}` works on both tiers (no reasoning field, 0.3-0.4 s); with thinking on the reply carries a reasoning field and takes ~2x longer. Earlier manual runs (V11 checklist G0) saw Super with thinking on return empty `content` at small `max_tokens` and a whitespace loop at 1200 tokens; this probe's tiny prompt did not reproduce that, so the gateway keeps both guards: token floor 2048 when thinking is enabled, and explicit `empty_output` / `degenerate_output` errors (never silently accepted, never retried as success). Seed determinism held for two calls at temperature 0.9.

## Roles and env (config.py)
| role | default model | env (aliases) | used for |
|---|---|---|---|
| reasoner | Super-120B-A12B | `CRUSOE_MODEL_REASONER` (`MODEL_NAME_DEEP`) | replan, reconcile, intervention, escalate, ScenarioProposalV1, dod_draft/dod_replan |
| specialist | Nano-30B-A3B | `CRUSOE_MODEL_SPECIALIST` (`MODEL_NAME`) | classification / perception / summaries |
| reviewer | = reasoner | `CRUSOE_MODEL_REVIEWER` | verify, dod_review (SEN-05; isolated context and its own budget line) |
Other env: `CRUSOE_API_KEY`, `CRUSOE_BASE_URL` (`MODEL_BASE_URL`; https only, localhost http allowed, no redirects), `CRUSOE_MAX_REQUESTS_PER_MIN` (60), `CRUSOE_TIMEOUT_S` (60), `CRUSOE_MAX_CONCURRENCY_HIGH` (2) / `CRUSOE_MAX_CONCURRENCY` (4), `CRUSOE_QUEUE_MAX` (64), `CRUSOE_RETRIES` (3), `CRUSOE_RUN_CALL_BUDGET` (400), `CRUSOE_SPEND_CEILING_USD` (2.00 per run), `CRUSOE_INCIDENT_SPEND_CEILING_USD` (0.50), `MODEL_SEED` (7), `MODEL_THINKING*`.

## Gateway behaviour (inference/gateway.py; tests/test_v11_gateway.py, 31 tests)
* Startup `start()`: catalog discovery (context, supported_parameters, pricing), cached on disk with its date; `run_metadata()` returns models, catalog date, prices, limits for the run record. Request parameters are sent only if the catalog lists them (`seed`, `chat_template_kwargs`, `response_format`); `json_schema` constrained decoding is used only when the probe measured it working.
* Per call: frozen/idempotent lookup (no network) -> call-budget / run-spend / incident-spend / circuit gates -> bounded queue (refuse when full) -> sliding-window rate limiter (counts retries) -> concurrency slot (<=2 for reasoner/reviewer, <=4 specialist) -> HTTP.
* Retries on 408/425/429/5xx/timeouts with exponential backoff + full jitter, `Retry-After` honoured (seconds or date, capped at 60 s); 4xx other than those are not retried and do not trip the breaker. Per-model circuit breaker (5 consecutive failed calls -> open, 30 s cooldown, one half-open probe).
* Structured calls: <= 1 repair call, then `GatewayError('invalid_output')` which callers turn into a labelled deterministic fallback.
* Audit: one `model_calls` row per call (call_id, provider, model, role, kind, schema_version, run/task/incident ids, idempotency key, prompt hash, output hash, latency, attempts, status, tokens, est. cost + price-basis date, error class, source network|frozen, repair flag). No prompts, no reasoning text, no secrets, no provider error bodies. Sinks: in-memory, JSONL, `PgSink` (migration `0008_model_calls.sql`). Frozen outputs (`output_text`, assistant content only) make replay/restart/duplicate delivery return the stored result; `replay=True` never calls the provider (`replay_miss` instead).
* Limits of this work: the gateway is not yet wired into `DecisionService` by default (Agent A owns that wiring; it is a drop-in `ModelClient`); `PgSink` is untested against a live Neon database (no DB test was run); costs use the unit assumption above.
