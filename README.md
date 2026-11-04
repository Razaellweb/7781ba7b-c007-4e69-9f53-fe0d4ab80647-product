# Openweight

Openweight is a workspace for open-weight AI models and on-demand GPUs.

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
| `OPENROUTER_ENABLED`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | Inference provider. |
| `VAST_API_KEY`, `VAST_API_BASE_URL` | Vast.ai GPU marketplace offers for `/api/gpu/offers`. |
| `DATABASE_URL` (or `PGHOST`…) | Postgres connection. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Rate limiting and short-lived cache. |

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
  OpenAI-compatible model server with a per-machine API key.

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