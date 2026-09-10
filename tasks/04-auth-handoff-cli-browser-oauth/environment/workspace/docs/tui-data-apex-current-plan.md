# Current plan — restaurant controller benchmark

This replaces the old overview as the working plan. The old file stays for
reference.

## Goal

- By September 10, show a real preliminary benchmark and a playable demo.
- One controller model manages the whole restaurant through a fixed crew of
  model workers.
- Workers are the crew and environment, not a worker leaderboard.
- A human can play the same manager role with the same useful information and
  controls.
- The existing game is the starting point. It already has meaningful choices,
  costs, consequences, tutorial flow, traces, replay, worker orchestration, and
  a manager budget.

## What the game must show

- A clear goal and one current decision.
- Obvious clickable or drag controls.
- Understandable costs and consequences.
- Actual worker responses, including failures or delays when they happen.
- A simple debrief with cash, service, wait, walkouts, waste, safety, recovery,
  and the final handover.

## Evidence and grading

- Record factual snapshots, manager actions, worker events, outcomes, model and
  crew settings, scenario and seed, tool budget, clock policy, and versions.
- Package that evidence for the actual Archipelago rubric-model grader, with a
  controller handover. The final score must come from Archipelago, not a
  standalone deterministic score pretending to be Archipelago.
- Required criteria are safety, a useful service minimum, resource and waste
  limits, recovery from disruption, consequential delegation and monitoring,
  and a factual handover.
- Report all-criteria pass/fail and Pass@1 over repeated runs. Also report the
  percentage of equal-weight criteria met and raw metrics.
- Safety failure stays visible even if the partial percentage is high.
- Choose thresholds from a development baseline, then freeze them before the
  final runs. Do not invent thresholds after seeing results.
- Do not claim learning when the game forces compliance or synthesizes a
  reaction. Label scripted, enforced, fallback, and live model behavior.

## Work order

### Monday, September 7 — today

- Freeze the short task and rubric.
- Bring over and verify the existing worker-state changes from
  `design/game-look-polish`.
- Smoke-test the controller path and actual Archipelago evidence/grading path.
- Simplify the existing frontend and write down the remaining gaps.

### Tuesday, September 8

- Finish the controller loop and missing counters.
- Run a real controller shift with the fixed crew.
- Produce the first judged report and repeat it enough to expose obvious
  failures.

### Wednesday, September 9 — only half a day for playtest

- Let the user play the demo.
- Fix only confusing or blocking issues.
- Freeze the task, rubric, scenario, model, crew, budgets, and clock.
- Do two complete rehearsals and keep one recorded backup.

### Thursday, September 10

- Present the playable demo, evidence, Archipelago report, and limits.

## Honest boundaries

- The benchmark is preliminary, not a broad model ranking.
- Human traces are consented evidence for improving cases, not proof of optimal
  play.
- The native TypeScript game is the pilot authority; do not claim parity with
  the backend or replay honesty until it is proven.
- Existing backend runner and deterministic grader knowledge can be reused, but
  they do not already prove a controller benchmark.
- No live controller or Archipelago run is verified yet.
