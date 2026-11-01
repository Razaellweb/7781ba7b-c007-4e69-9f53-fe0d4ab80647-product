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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
