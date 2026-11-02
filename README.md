This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Server configuration

All provider credentials are read from server-only environment variables by
`lib/server/config.ts`. None of them are ever bundled into client code, returned
in an API response, or accepted from a request body or query string.

| Variable | Purpose |
| --- | --- |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy session verification (the only access requirement). |
| `INFERENCE_PROVIDER`, `INFERENCE_FALLBACK_PROVIDER` | Which inference transport serves tokens (`vast` or `openrouter`). |
| `OPENROUTER_ENABLED`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | OpenRouter inference transport. |
| `VAST_INFERENCE_BASE_URL`, `VAST_INFERENCE_API_KEY` | vast.ai GPU instance inference transport (vLLM / OpenAI-compatible). |
| `VAST_API_KEY`, `VAST_API_BASE_URL` | Vast.ai GPU marketplace offers for `/api/gpu/offers`. |
| `DATABASE_URL` (or `PGHOST`…) | Postgres connection. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Rate limiting and short-lived cache. |

### Inference providers

Every caller depends on the `InferenceProvider` interface in
`lib/server/inference.ts`, never on a concrete provider. `lib/server/provider.ts`
chooses the implementation from configuration and composes an optional fallback:

- `INFERENCE_PROVIDER=vast` selects `VastAIProvider` (`lib/server/vast-inference.ts`).
- Any other value, including the default, selects `OpenRouterProvider`.
- `INFERENCE_FALLBACK_PROVIDER` names the other provider. The fallback is used when
  the primary reports itself unhealthy, or when a stream fails with a retryable
  error **before any content was delivered**. A stream that already rendered tokens
  is never replayed from a different provider.
- A provider with no credentials configured is never selected, so the product keeps
  serving through whichever transport actually works.

Both providers implement the same normalized contract: `stream()` yields
`delta` / `complete` / `error` chunks, `health()` returns
`{ healthy, status, latencyMs, modelIds }`, and failures collapse into the shared
taxonomy (`authentication`, `rate_limited`, `timeout`, `upstream`,
`unsupported_model`, `cancelled`, `invalid_request`) so the Playground, the API
gateway, and the compute ledger never see an upstream status code or error body.

### vast.ai inference transport

`VastAIProvider` talks to a rented vast.ai GPU instance running vLLM (or any
OpenAI-compatible server). Unlike the marketplace integration in
`lib/server/vast.ts` — which holds `VAST_API_KEY` — the instance is protected by
its own service key, so inference never needs marketplace authority.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAST_INFERENCE_BASE_URL` | none | Instance root, e.g. `http://<ip>:<port>/v1`. Unset means the provider reports itself unavailable. |
| `VAST_INFERENCE_API_KEY` | none | The instance's `--api-key`; sent only as a bearer header. |
| `VAST_INFERENCE_TIMEOUT_MS` | `120000` | Whole-request deadline. |
| `VAST_INFERENCE_IDLE_TIMEOUT_MS` | `45000` | A stream that produces no bytes for this long is aborted as `timeout`. |
| `VAST_INFERENCE_HEALTH_TIMEOUT_MS` | `8000` | `/v1/models` probe deadline. |
| `VAST_INFERENCE_TOKENS_PER_SECOND` | `40` | Estimated decode throughput, used to price GPU-hour economics. |
| `VAST_INFERENCE_PROMPT_USD_PER_TOKEN` | `0.00000015` | Default prompt price when the model carries none. |
| `VAST_INFERENCE_COMPLETION_USD_PER_TOKEN` | `0.0000005` | Default completion price when the model carries none. |

Behaviour worth knowing:

- **Cancellation:** the Playground Stop button aborts the request, which tears down
  the upstream HTTP connection so the GPU stops generating. The provider then emits
  a `cancelled` terminal event, and the partial answer is persisted with
  `partial = true` rather than being discarded.
- **Idle stalls:** a server that holds the connection open without sending bytes is
  aborted and reported as `timeout`.
- **Malformed SSE frames** are skipped and logged with the operation key; they never
  crash a working stream.
- **Missing usage** falls back to a token estimate that is flagged
  `uncertain: true`, which marks the inference for reconciliation in the ledger.
- **Empty completions** settle with zero usage and zero provider cost.

### Vast.ai credential boundary

`VAST_API_KEY` is used exclusively inside `lib/server/vast.ts`. That module
attaches it as the documented `Authorization: Bearer <key>` header on outbound
requests to `https://console.vast.ai/api/v0/bundles/` — never as an `api_key`
query parameter, never in a response body, and never in a log line. Users never
supply or see a Vast.ai key; the existing Privy session authorizes each request
from the browser. If the key is missing, revoked, or rejected, the offers
endpoint returns a single sanitized `503` (`GPU offers are temporarily
unavailable`) with no upstream detail, which the GPU page renders verbatim.

The project's environment settings are seeded with
`VAST_API_KEY=REPLACE_WITH_YOUR_VAST_API_KEY` so the variable is visible there.
Replace that value with the account API key from console.vast.ai → Account →
API Keys, then redeploy. Until then the placeholder is treated exactly like a
missing key (`kind: "unconfigured"`) and is never sent to Vast.ai.
`VAST_API_BASE_URL` is optional and defaults to `https://console.vast.ai/api/v0`.

### GPU rentals

Users rent machines from `/gpu`. Machines are paid from the platform's Vast.ai
credit and charged to the user's compute balance at the provider price times
`GPU_MARKUP_MULTIPLIER`. Users only ever see the workspace price
(`lib/server/gpu-rentals.ts`, `lib/server/gpu-templates.ts`).

- **Billing:** time is prepaid in blocks from the compute balance. Each block is
  a `compute_reservations` hold on channel `gpu`. The next block is reserved 10
  minutes before the current one ends. If the balance can't cover it, the machine
  is destroyed when the paid block ends. Stopping early charges per started
  minute and returns the rest. A machine that never starts within 30 minutes is
  destroyed and refunded.
- **No scheduler needed:** each machine runs a small lease script that calls
  `POST /api/gpu/instances/{id}/heartbeat` every minute, and each call advances
  that rental's billing. If the app can't be reached, the script stops the
  machine five minutes after its prepaid time ends. GPU requests also sweep
  stale rentals, and a daily Vercel cron (`/api/gpu/sweep`, authorized by
  `CRON_SECRET`) catches anything left.
- **Setups:** only curated images run: a PyTorch JupyterLab notebook and a vLLM
  OpenAI-compatible model server with a per-machine API key. Pointing
  `VAST_INFERENCE_BASE_URL` at that server's `http://<ip>:<port>/v1` makes it the
  product's inference provider.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GPU_MARKUP_MULTIPLIER` | `1.15` | User price = provider price × this. |
| `GPU_BILLING_BLOCK_MINUTES` | `60` | Length of each prepaid block (minimum 10). |
| `GPU_MAX_HOURLY_USD` | `5` | Highest workspace price per hour a user can launch. |
| `GPU_MAX_ACTIVE_RENTALS` | `2` | Machines one user can run at once. |
| `GPU_DISK_GB` | `40` | Disk for each machine. |
| `APP_BASE_URL` | Vercel production URL | Public origin machines send heartbeats to. |
| `CRON_SECRET` | none | Authorizes the daily `/api/gpu/sweep` cron. |

Integration tests for the billing engine run against a disposable Postgres:
`TEST_DATABASE_URL=postgres://… npx vitest run tests/integration/gpu-rentals.test.ts`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
