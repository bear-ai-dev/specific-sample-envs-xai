# Issue 281: external play access and receipt of contributed sessions

## Result

**Route published and three blockers closed. Not yet proven.** No person
outside the team has run it, so the founder check is **not tried** and every
distribution count is zero. This packet is the preparation, not the proof.

Two things this work established that the issue's plan assumed were already
true:

1. **The published route cannot serve a live-worker session.** The live crew
   reads `GAMEPIGEON_MODEL_API_KEY` from the environment of the machine running
   the overlay ([tauri/src/main.rs](../../tauri/src/main.rs), `worker_model_credentials`).
   There is no backend proxy. So a hybrid session on someone else's machine
   would mean handing them the shared NIM key, which work item 1 forbids. An
   external tester plays the **deterministic crew**; the live-worker session
   stays a founder-machine session until a proxy exists. This is stated plainly
   in the install page rather than left for a tester to discover.
2. **The arena export had no per-session identifier at all.** `episodeId` is
   seed-derived (`dinner-rush-218220`), so it names the *scenario*, not the
   run. Two people playing the same seed exported the same id, and the
   downloaded file overwrote the previous one. Acceptance box 2 — "one session
   is retrievable and duplicate receipts do not inflate counts" — was
   unreachable, not merely unverified.

## What changed

### A held-back shift no longer reads as a broken one

The shared model account admits 20 request starts per rolling minute (#289).
While a request waits for its slot, or while the provider is returning 429,
the crew produces nothing — and the overlay rendered that as
`Fallback · … · error`, the same as a crew that actually failed. A tester
seeing that reasonably concludes the game is broken and stops.

The transport is the only thing that knows which it is, so it now reports:
`admit_worker_request` dispatches `gamepigeon:worker-budget` before it sleeps,
and the 429 branch dispatches a throttle alongside the error string. The HUD
gains a `waiting` tone distinct from `error`:

| Banner | Meaning |
| --- | --- |
| `Waiting for the shared model account — Ns` | Queued for our share of the account. |
| `Shared model account is rate limited — retrying in Ns` | Provider returned 429; every worker is held back. |
| `Fallback · …` | A live turn actually failed. |

A worker error raised while the account is holding requests back no longer
prints `Fallback` at all ([overlay/worker-budget.ts](../../overlay/worker-budget.ts),
`shouldReportFallback`).

### The session has an id, and it is on screen

`RestaurantArenaTraceV3` gains an optional `sessionId` carrying the overlay's
own `gameId`, and the debrief screen shows it so a tester on their own machine
can quote it back. The exported filename is keyed on it, so a second run of the
same scenario no longer overwrites the first.

Optional, not required: v3 exports written before this field remain valid. A
malformed one is rejected, because an id that looks matchable and is not is
worse than none.

**Duplicate receipts:** chunk ids are already derived deterministically from
the game id (`traceId` in [overlay/recording.ts](../../overlay/recording.ts)),
so a re-uploaded chunk carries the same `chunk_id`. The dedup key exists on
this side. Whether the backend uses it is retro-backend#84's half and is
**not verified here**.

### The route is written down

[install.md](install.md) is a standalone page — no clone, no Rust, no server.
It names the supported platforms, what the status line means, and what to do
when something fails.

**Intel Macs are unsupported.** `overlay-v0.3.3` ships no `macos-x64` asset, so
the download step fails with a missing-asset error. The page says so up front
rather than letting a tester hit it.

## What was checked

```sh
npx --yes bun@1.3.11 test ./src/
npx --yes bun@1.3.11 test overlay/
npx --yes bun@1.3.11 test packages/trace-export/src
npx --yes bun@1.3.11 x tsc --noEmit && npx --yes bun@1.3.11 x tsc --noEmit -p overlay/tsconfig.json
cargo check --manifest-path tauri/Cargo.toml
npx --yes bun@1.3.11 scripts/export-arena-trace.ts --check
```

Results: 257 src / 65 overlay / 2 trace-export passing, typecheck clean, cargo
check clean, fixture current at 17 events.

The new focused checks are
[overlay/worker-budget.test.ts](../../overlay/worker-budget.test.ts) (13 tests,
including that a queued or throttled shift is not reported as a fallback) and
the `identifying the session a trace came from (#281)` block in
[src/games/restaurant-arena/trace.test.ts](../../src/games/restaurant-arena/trace.test.ts)
(4 tests, including that two runs of one scenario stay distinguishable).

These prove the code does what it says. **They prove nothing about
distribution.** No live 429 was observed against the real account in this work;
the throttle path is covered by unit tests and by #289's Rust tests, not by a
witnessed rate limit.

## Acceptance

- [ ] A person outside the team completes the published route without terminal
      coaching. — **Not tried.** Needs a tester.
- [ ] One session is retrievable and duplicate receipts do not inflate counts.
      — **Half done.** The session is now identifiable and the local dedup key
      is stable; backend receipt behavior is unverified (retro-backend#84).
- [x] Waiting/failed-provider states are understandable and budgeted. — Budget
      from #289; the waiting state is now distinguishable from a failure.
- [ ] Distribution counts and observed friction are recorded honestly. —
      [ledger.md](ledger.md) exists and is honestly empty.

## Founder check

**Not tried.** It requires giving a person outside the team `install.md` and
watching them, which is a founder action.

When it happens: hand over only [install.md](install.md), observe setup,
waiting and completion without coaching, then read the session id off their
debrief screen and match it against the received export.

## Smallest next steps

1. Run the founder check with one external tester. Everything else is blocked
   behind what it reveals — including work item 5, which asks for the largest
   *observed* playability blocker.
2. Confirm with retro-backend#84 that receipts dedup on the stable chunk id,
   and that `sessionId` is read on ingest.
3. Decide whether a live-worker session on an external machine is in scope for
   the pilot. If it is, it needs a backend proxy; if it is not, say so in the
   demo narrative rather than implying testers played the hybrid crew.

## Note on the source-of-truth documents

The issue names `docs/tui-data-apex-overview.md` and
`docs/tui-data-apex-day-by-day-plan.md` as the source of truth. Neither exists
in this repository. Nothing here depends on them, but the close-out cannot cite
them until they do.
