# Tui releases CDN

Public, unauthenticated download endpoint for the packaged overlay binary,
served from `https://releases.runretroarcade.com`. `Trolleroof/tui-gamepigeon`
is a private GitHub repo, so GitHub Releases can't serve binaries to a fresh
`npm install` — there's no session yet, and most users don't have `gh`
authenticated against this repo. This Worker exists so the download step
doesn't require any auth at all, on purpose: gating it behind Cloudflare
Access (or any login) would recreate the exact problem it's meant to fix. The
`cloudflare/auth-worker` account/session Worker stays fully separate from this
one.

Routes:

- `GET /manifest.json` — latest `{ version, tag, assets: { <asset>: { sha256, size } } }`
- `GET /:tag/manifest.json` — the same, pinned to a specific `overlay-v<version>` tag
- `GET /:tag/:asset` — a single binary, streamed straight from R2

Every route is read-only and only ever resolves R2 keys matching
`overlay-v<semver>/gamepigeon-overlay-<platform>-<arch>[.exe]` or
`overlay-v<semver>/manifest.json` — see the `TAG_PATTERN`/`ASSET_PATTERN`
checks in `src/index.ts`. There is no way to read an arbitrary bucket key.

## Publishing (CI)

`.github/workflows/overlay.yml`'s `release` job computes a sha256 + size for
every staged binary, writes `manifest.json`, and pushes both the per-tag copy
and the root pointer to R2 via `wrangler r2 object put`. That step needs two
repo secrets:

- `CLOUDFLARE_ACCOUNT_ID` — `23485d44b867d402372d7d6dd1db75dd` (the
  `runretroarcade.com` account)
- `CLOUDFLARE_API_TOKEN` — scoped to that account, with `Workers R2 Storage:Edit`

It skips gracefully (with a `$GITHUB_STEP_SUMMARY` note) if either secret is
missing, so an unconfigured fork's release still completes.

## Local setup

```bash
cd cloudflare/releases-worker
npm install
npm run cf-typegen
npm run typecheck
npm run dev
```

## Deploy

```bash
CLOUDFLARE_ACCOUNT_ID=23485d44b867d402372d7d6dd1db75dd npx wrangler deploy
```

`wrangler.toml`'s `routes` entry (`custom_domain = true`) attaches
`releases.runretroarcade.com` automatically on deploy — no manual DNS or zone
ID needed, since the account already owns that zone.
