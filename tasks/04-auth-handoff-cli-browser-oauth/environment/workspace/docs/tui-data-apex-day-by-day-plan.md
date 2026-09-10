# Tui Data / APEX Day-by-Day Plan

Execution plan for one frozen dinner-rush benchmark. Strategy detail in
`docs/tui-data-apex-overview.md`; legacy copy also in
`docs/mercur-apex-demo-plan.md`.

## North star (demo day)

```text
task card + frozen snapshot
-> human or model manager trajectory
-> final snapshot + grade.json
-> consented human trace (optional)
-> comparison report (objective metrics ≠ human preference)
```

One local command: `reset case → run → JSONL → grade` with no manual edits.

## What to stop building

- Four-model-worker **leaderboard** as the primary result
- Public model ranking before `grade.json` is honest
- Claiming live Arena traces replay as E-Sim without hash proof
- LLM-only grading of kitchen numbers (sim state is authoritative)

## Days 1–2 — freeze the measurement contract

- [ ] `cases/dinner-rush-v1/`: seed, maxTicks, oven tick, allergy ticket, stock
- [ ] `task.md`: objective, manager-visible info, tools, round budget, handover
- [ ] `rubric.json`: binary criteria (`safety_zero`, `cash_gte_*`, `walkouts_lte_*`, …)
- [ ] `weights.json`: published before any model run
- [ ] Pick authoritative sim (`RestaurantSim` in retro-backend, or bridged TS engine)
- [ ] Document v1 vs v2 bridge decision

**Exit:** scripted manager → identical state hashes on two resets.

## Days 3–4 — make the evaluator real

- [ ] Implement all ten metrics in grader (see overview table for gaps)
- [ ] `grade.json`: gate + raw dimensions + weighted score among passes
- [ ] Runner writes JSONL: task version, snapshot hashes, tool calls, latency, cost
- [ ] Deterministic reference manager (no provider) end-to-end command

**Exit:** `case → runner → JSONL → grade` with no UI or network.

## Days 5–6 — wire metrics into the playable game

- [ ] Surface gate + key metrics in end-of-shift debrief (not just cash)
- [ ] Per-plate verify tracking (not night-wide safety flag)
- [ ] Increment `waitTime`, waste, recovery timers in engine
- [ ] Count invalid actions and unnecessary interventions
- [ ] Human manager parity: same tools and budget as model runner

**Exit:** playing the shift produces the same numbers the grader would compute.

## Days 7–8 — human vs model comparison

- [ ] One human + one model on identical frozen task; disclose n
- [ ] Optional: small repeat sample for Pass@1 CI
- [ ] Report table: safety, completion, wait, waste, cash, recovery, latency,
  handover accuracy, human preference (separate column)

**Exit:** every score links to task version, run artifact, and grade file.

## Days 9–10 — demo legibility

- [ ] Static report or results screen (APEX-style: task + pass/fail criteria)
- [ ] Backup recorded run; rehearse on demo machine
- [ ] Feature freeze except blockers on eval path

**Exit:** two full rehearsals reset → grade without hand-editing data.

## Day 11 — honest story

1. Person or model manages a constrained shift (Arena).
2. Trace = context → action → outcome (not training data by default).
3. Reset identical task; show frozen run + deterministic grade.
4. Compare objective metrics vs human preference separately.
5. Roadmap: expert task families, held-out seeds, reviewed traces → new cases.

## Acceptance checklist

- [ ] Versioned task card + frozen case
- [ ] Reproducible reset (hash proof)
- [ ] Human/model manager parity or explicit separate lanes
- [ ] No-provider deterministic test passes
- [ ] Model runs produce JSONL + grade.json
- [ ] Consented human trace exportable and labeled
- [ ] Safety is gate; preference is not ground truth
- [ ] Results disclose model/config, task version, sample size, limits
