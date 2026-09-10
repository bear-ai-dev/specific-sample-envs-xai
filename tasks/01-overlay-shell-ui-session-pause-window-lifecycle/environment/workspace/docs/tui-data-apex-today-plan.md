# Today’s plan — Monday, September 7

This replaces the old day-by-day plan as the working plan. The old file stays
for reference.

## Finish today

- Freeze one small restaurant task and a short rubric.
- Test the existing worker-state changes from `design/game-look-polish`:
  `prepare`, `serve`, `seat`, and `inspect` must have visible effects.
- Run an early controller smoke test. The controller is one model managing the
  restaurant; the model workers are a fixed crew, not separate competitors.
- Run an early Archipelago evidence and grading smoke test. Do not replace the
  real Archipelago grader with a local lookalike.
- Make the existing game easier to understand:
  - show the goal clearly;
  - make the current clickable or drag action obvious;
  - show the cost and likely consequence;
  - show what the workers actually did;
  - make the end-of-shift result easy to read.
- Record the exact gaps left for tomorrow. Do not claim a live controller or
  Archipelago result until it has really run.

## Keep the scope small

- Reuse the tutorial, decisions, staff positions, rush priorities, money,
  waste, safety effects, traces, replay, and manager budget already in the game.
- Add a decision only when the rubric cannot otherwise be exercised.
- Do not build a new benchmark platform, broad leaderboard, training system, or
  full Python/TypeScript parity bridge.

## End of day check

We should have one frozen task, one clear rubric, worker effects verified, an
initial controller path, and a known status for the Archipelago adapter. The
native TypeScript game is the proposed pilot world until a different authority
is needed.
