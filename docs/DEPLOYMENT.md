# Vercel deployment

PayFlow deploys the React client and Express API as one Vercel project. The database remains in Supabase. This is a practice wallet with simulated funds.

## Build and routing

- Project root: repository root, not `client/` or `server/`.
- Runtime: Node.js 22.
- Install: `npm ci --prefix server && npm ci --prefix client`.
- Build: `npm run build`.
- Static output: `client/dist`.
- API entry: `api/index.js`, which exports the existing Express app without starting a local listener.
- `/api/*`, `/health`, and `/health/db` reach the same handler. The frontend sends requests to its own origin, so no separate API URL or CORS configuration is needed.
- Functions run in Sydney (`syd1`), near the existing Supabase database.

`vercel.json` contains these settings. Documentation-only commits skip automatic builds using the ignored-build command; changes to client, server, API, dependency, or deployment configuration files trigger builds.

## Server environment

Configure these in the Vercel project's environment settings:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL pooler connection string from the Supabase Connect panel. |
| `JWT_SECRET` | Random server-only signing secret. Use a different value from local development. |

Set both for the deployment environment before creating a deployment. Never use a `VITE_` prefix for secrets, put credentials in `vercel.json`, or commit a real `.env` file. Vercel provides the runtime port automatically.

The shared PostgreSQL pool is limited to three connections per Vercel instance. `@vercel/functions` attaches its idle-pool cleanup, and idle connections time out after five seconds. This limit is per instance, not a global database connection cap.

## Database readiness

The deployment requires `users`, `wallets`, `transactions`, `payment_requests`, and `auth_sessions`. Existing data is preserved. Migrations are a separate, deliberate step; deployments do not automatically run schema changes.

For a fresh database, configure `server/.env`, then run:

```powershell
cd server
node migrate.js
```

`/health` checks the API process. `/health/db` checks database connectivity and returns a generic `503` if unavailable. A paused Supabase project must be resumed before database-backed features can work.

## Local checks

```powershell
npm.cmd test
npm.cmd run build
npm.cmd --prefix client run test:render
```

These cover the API handler, session and wallet behavior with mocked database connections, client utilities, component markup, and the production frontend build. Real PostgreSQL tests are available separately through `npm.cmd --prefix server run test:integration`.

Preview deployments are separate from production. Use the deployment URL shown by Vercel; production promotion is a separate action. GitHub links should identify previews clearly.
