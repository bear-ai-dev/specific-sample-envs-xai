# Issue 275 verification evidence

## Baseline

- `tui-gamepigeon`: `ec68031` before this change; branch `codex/issue-275-arena-baseline`.
- `retro-backend`: merged grader baseline `15e661a` (PR #74), fast-forwarded locally without touching its unrelated working files.

## Real played shift

`played-shift.json` and `played-shift.jsonl` came from the Dinner Rush browser overlay. The shift recorded a player priority change through the expediter, a typed host message, allergy verification, oven repair, the warming-shelf decision, and terminal results.

The end screen reported 10/10 safe plates, 0 walkouts, 2 waste, and $175 takings. `played-shift.png` shows that outcome and the available export controls.

Both exports passed the v3 JSON Schema and replayed from input zero to the recorded terminal state:

```text
30 inputs, tick 24, completed
sha256:c12b185188b3b1854f062ef341ccd01c3ba5895c69314294dc666b022d3b7c8b
```

## Decision and limitation

Arena now exports `restaurant-arena-trace/v3`: it truthfully declares the live v1 role roster (`chef`, `server`, `host`, `expediter`) and includes the ordered inputs and complete simulation checkpoint hashes required for native replay.

The backend accepts the v1 starting state but its merged PR #74 grader consumes a separate `restaurant-arena-trajectory/v1` format. The real v3 trace is not that trajectory (11 expected validation errors). For this deadline, native Arena replay and the frozen E-Sim benchmark are separate artifacts. No cross-engine parity claim is made.

## Commands

```bash
bun scripts/replay-arena-trace.ts docs/evidence/issue-275/played-shift.json
bun scripts/replay-arena-trace.ts docs/evidence/issue-275/played-shift.jsonl
uv run --project ../retro-backend --frozen python scripts/validate-arena-trace.py docs/evidence/issue-275/played-shift.json --backend ../retro-backend
```
