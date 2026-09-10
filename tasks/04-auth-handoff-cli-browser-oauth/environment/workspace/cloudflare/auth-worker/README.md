# Tui auth Worker

This Worker provides optional account authentication using Better Auth and D1.
Offline single-device gameplay does not require this Worker.

This Worker does not store interaction traces, completed-game results, local
scores, or PostHog analytics. Trace and result sync belongs to
[`adavyas/retro-backend`](https://github.com/adavyas/retro-backend); see
[`docs/live-account-sync.md`](../../docs/live-account-sync.md) for the full
data ownership map.

## Local setup

From the repository root:

```bash
cd cloudflare/auth-worker
npm install
npm run cf-typegen
npm test
npm run dev
```

Use Node.js `22.6.0` or newer. The smoke command runs its TypeScript entrypoint
with Node's `--experimental-strip-types` support and does not add a transpiler
dependency.

`npm run dev` runs `wrangler dev --env dev`. Wrangler keeps the development D1
database and Durable Object SQLite data in its local state directory. The
`env.dev` configuration uses:

- `BETTER_AUTH_URL=http://localhost:8787`
- `PUBLIC_GAME_URL=http://localhost:5173`

Create `cloudflare/auth-worker/.dev.vars` with development-only Better Auth and
migration secrets. Do not commit this file.

```dotenv
BETTER_AUTH_SECRET=replace-with-a-long-random-development-secret
MIGRATION_SECRET=replace-with-a-different-long-random-development-secret
```

With the local Worker running, initialize the Better Auth tables once:

```bash
curl -X POST \
  -H "Authorization: Bearer replace-with-a-different-long-random-development-secret" \
  http://localhost:8787/migrate
```

Point a local client at the Worker with
`GAMEPIGEON_AUTH_URL=http://localhost:8787` and
`GAMEPIGEON_LOGIN_URL=http://localhost:5173/login.html`.

## Cloudflare configuration

### D1

Create the production D1 database and place its ID in the top-level
`database_id` in `wrangler.toml`:

```bash
npx wrangler login
npx wrangler d1 create tui-gamepigeon-auth
```

The `DB` binding stores Better Auth data, initialized by calling
`POST /migrate` with the operator bearer secret after an approved deployment.

`wrangler.toml` still lists a retired `GameRoom` Durable Object migration
(`v1` create, `v2` delete) from a multiplayer feature that has since been
removed. Cloudflare requires migration history to stay append-only, so those
entries remain even though no code references `GameRoom` anymore.

The repository keeps `wrangler.toml`: Wrangler supports both TOML and JSONC,
and changing formats would not change the deployment. The top-level
configuration is production. `env.dev` is local-only and is named
`tui-gamepigeon-auth-dev` so it cannot be confused with production. There is no
`env.staging` until an operator provisions a separate staging Worker and D1
database; never point a future staging binding at the production database ID.

### Public URLs and origins

Set these non-secret variables in the relevant Wrangler environment:

- `BETTER_AUTH_URL`: absolute public Worker URL, with no trailing slash.
- `BETTER_AUTH_TRUSTED_ORIGINS`: comma-separated origins Better Auth may trust
  for cross-origin auth requests. Keep the CLI callback origin and Worker origin.
- `PUBLIC_GAME_URL`: absolute HTTPS URL for the app.

Example production values:

```toml
[vars]
BETTER_AUTH_URL = "https://auth.runretroarcade.com"
BETTER_AUTH_TRUSTED_ORIGINS = "http://127.0.0.1:3210,https://auth.runretroarcade.com,https://runretroarcade.com"
PUBLIC_GAME_URL = "https://runretroarcade.com"
```

### Secrets

`BETTER_AUTH_SECRET` and the separate operator-only `MIGRATION_SECRET` are
required. Store both as Wrangler secrets, never in `wrangler.toml` or source
control.

```bash
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
openssl rand -base64 32 | npx wrangler secret put MIGRATION_SECRET
```

Bearer session tokens are sent as `Authorization: Bearer <token>`.

## Staging gate

Run all three commands before requesting a staging deployment:

```bash
cd cloudflare/auth-worker
npm test
npm run typecheck
npm run deploy -- --dry-run
```

`npm test` runs the Worker Vitest suite. The deploy script explicitly selects
the top-level production configuration with `--env=""`; the extra `--dry-run`
prevents deployment. This repository does not define `env.staging`. Before an
actual staging deployment, an operator must define the intended staging
environment with separate resources and obtain deployment approval.

A production deployment requires separate explicit approval. The implementation
and local verification documented here do not deploy this Worker.

## Security notes

- Keep `MIGRATION_SECRET` operator-only; `POST /migrate` rejects missing or
  invalid bearer credentials without accessing D1.
- Never commit `.dev.vars`, bearer tokens, or Worker secrets.
- Configure exact production origins; do not use wildcard browser origins.
