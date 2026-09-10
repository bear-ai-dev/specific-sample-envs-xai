# tui-gamepigeon

Play Tui's lightweight consumer games in an HTML overlay while your agents work. The current arcade also provides the foundation for the Restaurant Arena: a human-facing multi-agent game whose state, actions, and consented interaction traces can later feed a separate frozen evaluation environment.

## Play

Build the overlay once, then launch the arcade menu or a specific game:

```bash
bun install
bun run build:overlay   # web bundle + native Tauri shell (needs Rust)
bun start               # overlay menu
bun start restaurant-arena  # jump straight into Restaurant Arena
# or after `bun run build`: gamepigeon / gamepigeon restaurant-arena
```

In the overlay: arrow keys or WASD to move, `Enter` to select, `r` to restart, `Esc` or `q` to hide. Drag the top bar to move the window; use the expand control to resize it.

## Install: local vs. global

There are two ways to run the Tui overlay. **Local** runs it straight from this
checkout for development. **Global** installs it once so the plain `claude` command
opens Tui in every project.

Local development needs [Bun](https://bun.sh) (`>=1.3`), macOS 11+, Windows 10+, Ubuntu 22.04+,
or a current Fedora release, and Rust only when building the overlay binary from source.
Published npm and harness installs bootstrap Bun on first launch when it is missing.

### Local (from this checkout)

Build the overlay and wire the harness adapters to this working copy:

```bash
bun install
bun run build:overlay      # overlay web bundle + native Tauri shell (needs Rust)
bun run install:adapters   # installs Codex / Claude / OpenCode adapters -> this checkout
```

Restart your harness. The generated adapters live at `~/.codex/skills/arcade`,
`~/.claude/skills/arcade`, and `~/.config/opencode/commands/arcade.md`; all execute
`scripts/overlay.ts` from this checkout.

For local harness development, one command builds the current checkout, replaces any
stale overlay, and points at the debug Tauri binary instead of the packaged release:

```bash
bun run claude:dev        # Claude Code — loads this checkout via --plugin-dir .
bun run codex:dev         # Codex — workspace plugin + $arcade adapter from this checkout
bun run antigravity:dev   # Antigravity — .agents/plugins/ workspace plugin + agy
```

Claude appears as `/tui-gamepigeon:arcade`. Codex uses the `$arcade` skill (or `/arcade` picker).
Antigravity picks up `.agents/plugins/tui-gamepigeon/` from the repo root. All three set
`GAMEPIGEON_SKIP_UPDATE_CHECK=1` so local dev is not fighting the release auto-updater.

To open the overlay directly without a harness:

```bash
bun run start            # menu
bun run start restaurant-arena # a specific game
bun run preview:overlay  # browser preview at 520×740 (no Tauri)
bun run dev:overlay      # rebuild web bundle + debug shell, then show
```

#### Browser preview

Agents (and humans) can iterate on overlay layout without a Rust build:

```bash
bun run preview:overlay
# → http://127.0.0.1:4173/ (opens your browser)
bun run preview:overlay -- --game=restaurant-arena
```

The preview frames the real overlay UI at the production sizes (**520×740** compact, **720×780** expanded). Titlebar **↗ / ↙** toggles the frame; Hide and Shutdown are no-ops in the browser. Open a game from the menu, or pass `--game=<id>` / use `?game=<id>` (optional `&variation=classic`).

### Global (installed once, works everywhere)

For Codex (or another supported harness), the one-command install is:

```bash
npx -y bun x @tui-games/tui@latest install --codex
```

Replace `--codex` with `--claude`, `--opencode`, `--hermes`, `--openclaw`, or
`--antigravity`, or `--all`. For Antigravity, run it from the project directory;
it writes that project's `.agents/plugins/tui-gamepigeon` plugin. This uses npm to
fetch Bun for the command, then writes the harness adapter.
Restart the harness when it finishes.

Install the plugin from the GitHub marketplace so the normal `claude` command runs
the lifecycle hooks in every project:

```bash
claude plugin marketplace add Trolleroof/tui-gamepigeon
claude plugin install tui-gamepigeon@tui-gamepigeon --scope user
```

Optionally enable Claude's marketplace refresh under `/plugin` → **Marketplaces** →
**tui-gamepigeon**, and point the status line at the Tui update shim once:

```json
"statusLine": {
  "type": "command",
  "command": "bun ~/.gamepigeon/status-line.ts"
}
```

The packaged plugin exposes `/tui-gamepigeon:arcade` and `/tui-gamepigeon:arcade-update`;
the standalone adapter provides Claude's shorter `/arcade`.

## Optional account

Tui requires an account. On first launch the plugin prompts for an email and password to create an account or sign in. Later launches reuse the private local session.

```bash
gamepigeon auth signup
gamepigeon auth login
gamepigeon auth status
gamepigeon auth logout
```

Production defaults to `https://auth.runretroarcade.com` and `https://api.runretroarcade.com`. Override them for local development with `GAMEPIGEON_AUTH_URL` and `GAMEPIGEON_BACKEND_URL`. The Better Auth bearer returned by sign-in is stored in `auth.json` and atomically mirrored to `backend.conf`, both with user-only permissions. That same bearer authenticates `/v1/me`, trace uploads, and completed-game results. If that validation or an upload fails, Tui marks the account chip **Sync paused** while keeping gameplay data queued locally. Logout clears both credentials without deleting local games or traces.

## Coding harness adapters

The bundled adapters give Codex CLI, Claude Code, and OpenCode the same Tui launcher. Tui opens a centered, borderless HTML overlay above the active desktop. It uses the operating system's installed webview through a small Tauri shell, not Chrome or Electron.

Requirements:

- Bun
- macOS 11+, Windows 10+, Ubuntu 22.04+, or a current Fedora release
- A packaged overlay binary, or Rust when building it from source

The overlay is a single-instance helper with no Dock icon on macOS and no taskbar or console entry on Windows or Linux. Hiding it keeps the game state alive; invoking Tui again restores and centers the existing window. It works from regular terminals and does not require tmux, a browser, a local server, or an extra setup command after plugin installation.

Linux uses the system WebKitGTK runtime. Install the build dependencies before building from source:

```bash
# Ubuntu
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install c-development
```

Install the dependencies and all three harness adapters from this checkout:

```bash
bun install
bun run build:overlay
bun run install:adapters
```

Restart the harness after installation. In Claude Code, submitting any prompt opens or restores Tui while Claude works. In Codex, invoke `$arcade` directly, or type `/arcade` to filter the picker and select **Tui**. Claude Code and OpenCode receive a bare `/arcade` command. The packaged Claude plugin uses its required namespace: `/tui-gamepigeon:arcade`. Codex does not register custom top-level slash commands; its `/arcade` interaction is picker discovery for the `$arcade` skill, like other Codex skills.

For local harness development, one command builds the current checkout, replaces any stale overlay, and loads this repo instead of an installed copy:

```bash
bun run claude:dev        # Claude Code
bun run codex:dev         # Codex CLI
bun run antigravity:dev   # Antigravity (agy)
```

`SessionStart` snaps a still-running overlay back to the menu (without popping the window open) so a new session never resumes mid-game, `UserPromptSubmit` shows the overlay, `Stop` pauses it with an `Enter` shortcut back to the coding prompt, and `SessionEnd` shuts down the helper.

Antigravity has none of those four events — it fires `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`, and drops any other key without an error. `scripts/antigravity-hook.ts` maps the same lifecycle onto `PreInvocation` + `Stop`; see [docs/harness-antigravity.md](docs/harness-antigravity.md).

To enable the hooks for the normal `claude` command, install the GitHub marketplace once:

```bash
claude plugin marketplace add Trolleroof/tui-gamepigeon
claude plugin install tui-gamepigeon@tui-gamepigeon --scope user
```

Claude Code does not silently install plugin updates. Tui uses a WOZ-style detect-and-nudge flow instead (see **Auto-updates** below).

The generated adapters live at `~/.codex/skills/arcade`, `~/.claude/skills/arcade`, and `~/.config/opencode/commands/arcade.md`; all execute `scripts/overlay.ts` from this checkout. The installer refuses to replace an unrelated command with the same name. Press `Esc` or `q` to hide the game, drag its top bar to move it, and use the expand button to resize it.

## Auto-updates

Tui updates in three layers. Claude Code cannot silently install a new plugin package for you — the user still confirms the upgrade — but detection and overlay binaries are automatic.

1. **Detect + nudge (plugin scripts/hooks)**  
   On Claude Code, a `SessionStart` hook runs `scripts/plugin-update.ts --check` on every new session. It compares the installed plugin version against the latest **published** release from `https://releases.runretroarcade.com/manifest.json` — the same public CDN the binaries come from. That manifest is written by the release job alongside the binaries, so it only ever names a version that is actually downloadable. It deliberately does not read `overlay-release.json` from GitHub: this repo is private, so `raw.githubusercontent.com` 404s for anyone without repo access, which silently disabled the nudge for every end user. `gh` remains a fallback for developers working in the private repo. When the published version is **strictly newer**, it writes `~/.gamepigeon/update-available.json`; when you are already current (or ahead, mid-release), it **clears any stale flag** and exits quietly. The first prompt of the session runs `--nudge`, which **re-checks that flag against the installed version** — offline, from the marketplace install record or `package.json` — and injects a reminder to run `/tui-gamepigeon:arcade-update` only if the flagged release really is newer; otherwise it clears the stale flag and says nothing. If no version can be resolved at all, the flag is trusted rather than dropped, so a real update is never swallowed. `~/.gamepigeon/status-line.ts` is refreshed on every check, but it prints nothing without a valid flag. Local directory marketplaces and `bun run claude:dev` (`GAMEPIGEON_SKIP_UPDATE_CHECK=1`) skip the check.

   Antigravity gets the same detect + nudge flow, but through the events it actually has: `scripts/antigravity-hook.ts` runs the check once per session and injects the nudge as a `PreInvocation` `ephemeralMessage` on turn boundaries. It points at the same shared flag file and compares `package.json`'s version at the installed checkout instead of a marketplace install record (Antigravity has no equivalent). The nudge tells the user to re-run `npx -y bun x @tui-games/tui@latest install --antigravity`. See [docs/harness-antigravity.md](docs/harness-antigravity.md).

   Copied adapters (Codex, OpenCode, Hermes, and OpenClaw) carry the check in their Tui command. The generated command sets `GAMEPIGEON_HARNESS=<harness>`; `scripts/overlay.ts` prints any existing `Update available: <from> -> <to>` nudge and starts `plugin-update.ts --check --harness <harness>` in the background for the next launch to pick up. This gives hookless harnesses the same "detect this time, nudge next time" cadence without delaying the overlay.

2. **Manual plugin upgrade**  
   Claude Code: run `/tui-gamepigeon:arcade-update` (or the equivalent `claude plugin marketplace update tui-gamepigeon` + `claude plugin update tui-gamepigeon@tui-gamepigeon`), then `/reload-plugins` or restart Claude Code so the new scripts load — the skill clears the update flag on success. Every copied adapter updates with one command: `npx -y bun x @tui-games/tui@latest install --<harness>`, where `<harness>` is `codex`, `opencode`, `hermes`, `openclaw`, or `antigravity`. Restart the harness afterward.

   **In-overlay Update button.** The same flag drives a banner inside the overlay window. What the banner offers depends on how Tui was installed, which the launcher records in `~/.gamepigeon/install-context.json` (`harness`, `launcherRoot`, `updateMethod`, plus the exact `updateCommand` to run) on every launch:

   | `updateMethod` | Update button runs |
   |---|---|
   | `claude-marketplace` (a path recorded in `installed_plugins.json`) | `scripts/run-plugin-update.ts` → `claude plugin update` |
   | `copied-adapter` (Codex, Antigravity, OpenCode, Hermes, OpenClaw, and Claude's npx install) | `bun x @tui-games/tui@latest install --<harness>` |
   | `npm-global` | `npm i -g @tui-games/tui@latest` |
   | `dev` (a git checkout) or `unknown` | nothing — the banner shows the command with a **Copy** button instead |

   `bun` leads the runnable commands because the launcher guarantees one on disk, while `npx` may be missing from the PATH the overlay inherited. On success the flag is cleared and the *newly installed* launcher is relaunched (an adapter reinstall rewrites `install-context.json` as it goes, so the reopened window is the new build). On failure the banner shows the error plus the command to run by hand, so the button is never a dead end.

3. **Overlay binary download**  
   Overlay UI changes ship as new binaries. Pushing anything under `overlay/`, `tauri/`, `scripts/overlay*`, or the shared game code triggers the `Overlay` workflow, which builds and tests macOS, Windows, Ubuntu, and Fedora binaries. Publishing is a separate, deliberate step: the workflow cuts a release only when `package.json`'s version names one that does not exist yet (see [Releasing](#releasing)). When it does, it publishes the binaries as `overlay-v<version>` GitHub release assets *and* to `https://releases.runretroarcade.com` (a public, unauthenticated Cloudflare Worker + R2 bucket — see `cloudflare/releases-worker`), and commits `overlay-release.json` pointing at the tag. This repo is private, so GitHub Releases alone can't serve a fresh `npm install` with no GitHub credentials; the Cloudflare CDN is what actually reaches end users. On the next session, `scripts/overlay.ts` compares that manifest against `~/.gamepigeon/bin/current`, fetches `<tag>/manifest.json` from the CDN for the expected sha256, downloads the matching binary, verifies its checksum, quits any overlay still running the old build, and launches the fresh one. Download failures fall back to the previously installed binary, so offline sessions keep working.

Manual release check:

1. Bump and publish a release; wait for `overlay-v<version>`, npm `@tui-games/tui@<version>`, and the matching `overlay-release.json` commit.
2. From an older Claude install, start a session, confirm the nudge, run `/tui-gamepigeon:arcade-update`, reload, and confirm the nudge clears.
3. From an older copied adapter, invoke Tui twice, confirm the second invocation reports the published version, run `npx -y bun x @tui-games/tui@latest install --<harness>`, restart, and confirm the nudge clears.
4. Launch Tui once more and confirm `~/.gamepigeon/bin/current` matches the published version; this verifies the refreshed launcher still downloads the overlay binary.

One-time status line setup (optional, but closest to the WOZ experience):

```json
"statusLine": {
  "type": "command",
  "command": "bun ~/.gamepigeon/status-line.ts"
}
```

Add that under `~/.claude/settings.json`. The shim is rewritten on each session check and does not hardcode a plugin cache path, so it stays valid across upgrades.

The repository also includes native plugin manifests for marketplace distribution. Local dev commands build the checkout and load it directly:

```bash
bun run claude:dev        # Claude Code — --plugin-dir .
bun run codex:dev         # Codex — workspace plugin + adapter
bun run antigravity:dev   # Antigravity — .agents/plugins/ at repo root
```

Claude namespaces plugin-provided skills, so the packaged forms appear as `/tui-gamepigeon:arcade` and `/tui-gamepigeon:arcade-update`. The standalone adapter provides Claude's shorter `/arcade` form.

Codex CLI and OpenCode invoke the overlay through their Tui adapter. Claude Code and Antigravity additionally expose lifecycle hooks, which is why prompt-start and response-stop behavior is automatic there.

To bypass a harness and open the overlay directly:

```bash
bun run start
bun run start restaurant-arena
```

## Launch games

| Game | Status | Controls |
|---|---|---|
| Protect vs. Loot | ✅ playable | arrows/wasd move, c to correct, s to approve scouting |

## Interaction traces

The recording layer under `src/recording/` durably journals episodes under `~/.tui-gamepigeon/recordings/` and splits them into immutable upload chunks. Every schema-v2 event includes `event_id`, `user_id`, `chunk_id`, and `game_id`.

- Policy-visible events preserve input impulses, timing, score/reward changes, and episode completion.
- Privileged engine checkpoints and realized random effects support deterministic replay without leaking hidden state into policy input.
- Local writes continue when upload is disabled or temporarily unavailable; pending chunks retry on later sessions.
- Completed games also enter a separate durable score outbox. Quits, restarts, and client shutdowns never submit a score.
- `~/.tui-gamepigeon/recordings/` is the complete, local source for BC datasets. Syncing a chunk stores and queues it in the cloud; it does not make it retrievable through the API. Completed episodes are now also written to R2 as Parquet, but that corpus is partial and not yet indexed. See [Where synced traces land](#where-synced-traces-land).

## Local score history

Every naturally completed overlay game appends one JSON object to
`~/.tui-gamepigeon/scores/history.jsonl`, even without a network connection.
The directory is user-only (`0700`) and the JSONL file is `0600`. Quits,
restarts, and shutdowns do not create entries.

Each schema-v1 row contains `game_id`, `game_type`, `variation_id`, `score`,
`success`, `completed_at` (the game-end timestamp), `duration_ms`, and
`platform`, plus the resulting `personal_best` and `high_score_updated`.
Personal bests are calculated per `game_type`; duplicate `game_id` writes are
idempotent.

The history is device-only today. A future remote score feature belongs in the
sync backend, not the auth Worker D1; it should merge records by `game_id` and
keep local logging independent of account and network availability.

Set the opaque per-user bearer token issued by Retro Backend. Requests default
to the sync backend at `https://api.runretroarcade.com`; set
`GAMEPIGEON_BACKEND_URL` only when targeting local or staging infrastructure:

```bash
export GAMEPIGEON_BACKEND_TOKEN=retro_...
# optional override:
# export GAMEPIGEON_BACKEND_URL=http://127.0.0.1:8787
```

The HTML overlay journals each seeded action sequence in local storage, rebuilds replay-safe schema-v2 engine-state traces at episode end, and hands immutable chunks plus completed-game results to Tauri. Tauri validates and durably queues them before any network call, then resolves the canonical `/v1/me` user and drains both outboxes in the background. Chunks live under `~/.tui-gamepigeon/recordings/overlay-pending/` until `/v1/game-event-chunks` accepts them; results live under `~/.tui-gamepigeon/recordings/results/overlay-pending/` until `/v1/game-results` accepts them. Interrupted and offline sessions recover on the next launch, while cloud-acknowledged payloads move to the matching `overlay-completed/` directory. A payload the backend refuses outright — a non-retryable HTTP status, or an acknowledgment that does not match what was sent — moves to the matching `overlay-failed/` directory with a reason logged to stderr and a sync error raised, so one rejected chunk never blocks the rest of the queue. Sign-in and backend-URL failures are not rejections: those keep the payload queued for the next launch. Nothing deletes those files; pass them to the exporter with `--input` if you want them back.

Export policy-visible human demonstrations into leakage-safe BC splits:

```bash
# installed package
gamepigeon export --output ./bc-dataset
# from a checkout
bun run export:bc -- --output ./bc-dataset
```

The exporter reads terminal and overlay chunks by default — including the unsynced `overlay-pending/` backlog, since a chunk is self-contained JSON whether or not it has been uploaded — joins each human control to its referenced observation and outcome across chunk boundaries, drops environment actions and no-op controls, and writes `train.jsonl`, `validation.jsonl`, `test.jsonl`, and `manifest.json`. Splits are deterministic by `game_id`, keeping every episode in only one split. Use repeatable `--input <file-or-directory>` arguments for backend downloads or `--include-noops` when those actions are intentionally part of the policy.

Before recording, the client finishes local recovery and resolves the token's canonical user through `GET /v1/me`. It uploads only trace chunks and results owned by that user; pending data from another local account is left untouched. If configured identity lookup fails, gameplay starts without recording that episode and retries identity on later games and drains. `GAMEPIGEON_INGEST_URL` and `GAMEPIGEON_INGEST_API_KEY` are deprecated compatibility aliases retained through `0.x` and scheduled for removal in `1.0`. They do not opt into the default backend: a legacy key set without `GAMEPIGEON_INGEST_URL` leaves sync disabled rather than uploading to `https://api.runretroarcade.com`.

This repository owns the client-side producer and versioned wire contracts. The ingestion service, score database, queue consumers, and object-storage archive live in the backend repository. The v1 and v2 request fixtures under `contracts/` can be reused by that backend's contract tests.

### Where synced traces land

Syncing stores a chunk in the cloud; it does not make it retrievable through the
API. `~/.tui-gamepigeon/recordings/` remains the source of truth for BC datasets
— it is complete, local, and never expires — but it is no longer the only
source: episode Parquet now lands in R2 as well. The backend repo's
[`docs/trace-storage.md`](https://github.com/adavyas/retro-backend/blob/main/docs/trace-storage.md)
is authoritative for the cloud side; the summary below is deliberately thin so it
does not drift from it again.

- **Cloudflare D1 holds no move-level data.** The `retro-backend` database is `users`, `auth_sessions`, `revoked_tokens`, and `high_scores` only. Nothing in it stores events, controls, or observations.
- **Accepted chunks go to R2.** `POST /v1/game-event-chunks` writes the exact request bytes to the `retro-gameplay-raw` bucket at `raw/user=<user_id>/game=<game_id>/chunk=<chunk_id>.json`, then publishes a small pointer to the `retro-gameplay-events` queue. The consumer re-reads and revalidates the object and writes a date-partitioned `validated/` or `rejected/` copy; messages that exhaust their retries are archived under `dlq/`. The `"accepted": true, "queued": true` acknowledgment means stored and queued, not indexed.
- **Episode Parquet is deployed.** Episode assembly and the Parquet writer ([adavyas/retro-backend#29](https://github.com/adavyas/retro-backend/issues/29), [#30](https://github.com/adavyas/retro-backend/issues/30)) shipped on 2026-08-03/04. Completed episodes land at `episodes/parquet/v1/{game_type}/{YYYY}/{MM}/{DD}/{game_id}.parquet` with a `{game_id}.manifest.json` sidecar carrying the row count and `parquet_sha256`. Schema: [`docs/parquet-v1.md`](https://github.com/adavyas/retro-backend/blob/main/docs/parquet-v1.md); assembly rules: [`docs/episode-assembly.md`](https://github.com/adavyas/retro-backend/blob/main/docs/episode-assembly.md).
- **There is still no cloud read path over HTTP.** The backend exposes no route that lists, queries, downloads, or exports traces. Reaching the Parquet means Cloudflare credentials, not an API token.
- **The D1 episode index is not in production yet.** `episodes` is the intended discovery surface — `wrangler` has no `r2 object list` (only `get`/`put`/`delete`), so enumerating objects otherwise requires the Cloudflare REST API or S3 credentials. Migration `0003_episodes_index.sql` is committed but unapplied: as of 2026-08-05 the production database reports only `0001_core.sql` and `0002_auth_sessions.sql`, because the deploy was done by hand and skipped `make migrate-remote`. Parquet exists in R2 but nothing indexes it, and `scripts/download-r2-dataset.py` reads that index, so it cannot run against production until the migration is applied.
- **Retention: what is committed is not what is live.** The backend's `cloudflare/r2-lifecycle.json` expires `raw/` at 90 days and `validated/`, `rejected/`, and `dlq/` at 7 days, leaving `episodes/parquet/v1/` with no expiry. The policy actually applied to the bucket today is still the older single rule — transition everything to Infrequent Access at 30 days, expire nothing — so nothing has been deleted yet. Do not read that as a guarantee: the next successful `make apply-r2-lifecycle` starts the deletion clocks, after which an episode never converted to Parquet is unrecoverable 90 days after its raw chunks land. Check the live policy before relying on either version: `npx wrangler r2 bucket lifecycle list retro-gameplay-raw`.
- **Coverage is partial.** As of 2026-08-05 production holds 30 episode Parquet objects against 196 distinct game IDs under `raw/`; the other 167 predate the writer and there is no backfill job.

Treat cloud sync as a durable archive plus a growing, incomplete Parquet corpus,
and keep exporting BC datasets from the local recordings directory — that path
covers every episode and needs no Cloudflare access.

## Analytics

Basic product analytics (DAU / feature usage) via PostHog are separate from interaction traces, which are for policy training rather than usage metrics.

```bash
export POSTHOG_API_KEY=phc_...
# optional, defaults to https://us.i.posthog.com
export POSTHOG_HOST=https://us.i.posthog.com
```

Without `POSTHOG_API_KEY` set, analytics calls are no-ops — gameplay is never affected. Events currently captured: `app.opened`, `account.signed_up`, `account.signed_in`, `game.started`, `game.ended`. Signed-in events use the account's pseudonymous user ID; guest events use an anonymous per-install ID stored at `~/.tui-gamepigeon/device_id`.

The PostHog SDK batches events with its defaults, uses the CloudEvent ID as `$insert_id` for retry deduplication, and flushes during graceful shutdown.

Product events use a CloudEvents 1.0 envelope with `specversion`, `id`, `source`, `type`, `time`, `datacontenttype`, optional `subject`, and typed `data`. Client events default to source `/tui-gamepigeon/client`; plugin, website, and backend producers use their own source. Event IDs reuse the recording layer's `evt_` identifier format.

| Funnel | Event types | Allowed data |
| --- | --- | --- |
| Awareness | `site.visited` | `referrer_host`, `campaign` |
| Acquisition | `account.signed_up`, `account.signed_in` | `method` |
| Activation | `game.started`, `game.ended` | `game_type`, `variation_id`, outcome, score, success |
| Retention | `app.opened`, gameplay events | `app_version`, platform, gameplay data |
| Revenue | `payment.succeeded` | `plan`, `currency`, `amount_minor` |
| Referral | `referral.created`, `referral.redeemed` | channel |
| Plugin lifecycle | `plugin.launched`, `plugin.reattached`, `agent.task_completed` | harness |

The website owns `site.visited`; invite and payment services own their corresponding events. Until those producers exist, the names above reserve the shared contract without fabricating client events. Analytics must never include terminal frames, trajectories, prompts, repository contents, credentials, email addresses, or raw provider payloads.

The live [Tui AARRR client dashboard](https://us.posthog.com/project/434929/dashboard/1866662) covers the client-owned acquisition, activation, and retention signals. See [`docs/analytics.md`](docs/analytics.md) for event ownership, saved insights, and the CLI verification runbook.

## Architecture

- `src/index.ts` — thin CLI: `gamepigeon` opens the overlay; `gamepigeon auth` handles accounts.
- `src/core/game.ts` — gym-style `Game` interface every title implements (`reset(seed)` / `step(action)` / `state()`), shared by the overlay and recorder.
- `src/core/rng.ts` — seedable PRNG (mulberry32) for reproducible episodes.
- `src/games/*/` — pure game engines (unit-tested); HTML rendering lives in `overlay/renderers.ts`.
- `src/recording/` — causal events, durable chunks, recovery, and upload transport.
- `src/results/` — completed-game result outbox, recovery, and score delivery.
- `src/sync/` — authoritative backend identity and the single-flight upload coordinator.
- `src/analytics/posthog.ts` — PostHog Node client wrapper for product analytics.
- `scripts/overlay.ts` — launcher, release download, and harness hook entry point.
- `overlay/` — bundled HTML/CSS/TypeScript frontend and deterministic local game session.
- `tauri/` — single-instance native shell with hidden Dock/taskbar presence.

## Development

```bash
bun run test
bun run test:adapters
bun run test:launcher
bun run typecheck
bun run build              # emits dist/, exposes the `gamepigeon` bin
bun run build:overlay:web  # overlay bundle only
bun run preview:overlay    # browser preview (520×740 / 720×780 frame)
bun run dev:overlay        # debug Tauri shell + show overlay
```

Bun runs the TypeScript source directly in development and builds a Bun-targeted executable for distribution.

## Releasing

Releases are gated on the version, not on commits. Pushing to `main` builds and tests the overlay but publishes nothing; a release appears only when `package.json`'s version names one that has no release yet. This keeps routine pushes from minting a release each time.

To cut one, bump the version and push:

```bash
bun run version:bump          # 0.2.1 -> 0.2.2
bun run version:bump minor    # 0.2.1 -> 0.3.0
bun run version:bump major    # 0.2.1 -> 1.0.0
bun run version:bump 1.4.0    # explicit
bun run version:bump --no-commit
```

The version lives in four manifests — `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.claude-plugin/marketplace.json` — and the script rewrites all of them together. Bump by hand and they drift, which is why `scripts/version-bump.test.ts` asserts they agree.

The script commits but never pushes; publishing stays an explicit action. Push `main`, then tag:

```bash
git push origin main
git tag overlay-v<version> && git push origin overlay-v<version>
```

That tag triggers the Overlay workflow: it builds macOS, Windows, Ubuntu, and Fedora binaries, creates the GitHub release `overlay-v<version>`, uploads assets to `https://releases.runretroarcade.com`, commits `overlay-release.json` on `main`, and publishes **`@tui-games/tui@<version>`** to npm when `NPM_TOKEN` is configured (skips gracefully if the version already exists or the secret is missing). Installed plugins and npm installs both use the CDN manifest to download the native overlay on the next launch.

### npm install (launcher only)

The CLI opens the same HTML overlay and games as the Claude marketplace plugin. If Bun 1.3+
is missing, the Node launcher installs it once using Bun's official installer; otherwise it
reuses Bun from `BUN_INSTALL`, `~/.bun/bin`, or `PATH`. The native shell is downloaded on
first run from the public release CDN (`https://releases.runretroarcade.com`).

```bash
npm i -g @tui-games/tui
gamepigeon              # arcade menu
gamepigeon restaurant-arena # jump into a game
gamepigeon auth status
```

Or install harness adapters in one step:

```bash
npx -y bun x @tui-games/tui@latest install --codex   # optional explicit Bun bootstrap
```

Harness hooks and auto-open on prompt still come from the [GitHub marketplace plugin](#coding-harness-adapters); npm is an alternate way to install the launcher without cloning the repo.

Maintainers: add an npm automation token as the repository secret **`NPM_TOKEN`** (write publish). Rotate it in npm account settings if compromised; never commit tokens.

Adding a new file that carries the version means adding it to `VERSION_FILES` in `scripts/version-bump.ts`, or it silently stops being bumped.
