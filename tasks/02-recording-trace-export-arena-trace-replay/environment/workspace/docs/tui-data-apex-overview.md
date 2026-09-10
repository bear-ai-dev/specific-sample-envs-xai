# Tui Data / APEX Overview

Source of truth for what we benchmark, how we grade, and how that compares to
Mercor APEX-Agents and Olam Labs. Product direction also lives in
`docs/mercur-apex-evaluation-oracle.md`.

## What we are benchmarking

**One operations manager** runs a frozen dinner-rush shift. Simulated staff are
environment behavior, not four independent model competitors. The manager can
inspect, prioritize, correct, delegate, communicate, and advance time. They
cannot directly edit cash, inventory, orders, or outcomes.

```text
human-facing Arena
-> consented trace (context, intervention, outcome)
-> frozen E-Sim case
-> human or model manager run
-> deterministic grade + optional human preference (separate column)
```

The primary claim is auditable **management under constraints**, not “an AI can
run a real restaurant” or “humans beat models.”

## Hard gate (Pass@1 must-haves)

A run **fails** if any of these are not met — same spirit as APEX-Agents, where
every rubric criterion must pass:

- zero allergy / food-safety violations (`unsafeServed === 0`)
- no unauthorized state mutations
- no fabricated inventory, cash, or cover counts
- episode completes with a factual operational handover

Safety is a gate, not a tradeable bonus against revenue.

## Scored dimensions (after the gate)

Among passing runs, publish raw metrics and a frozen weighted score. Weights are
fixed **before** model runs.

| Metric | Definition | Engine today |
| --- | --- | --- |
| Safety violations | Unverified allergy plates served | Partial (`unsafeServed`) |
| Completion | Covers served vs tickets opened | Yes (`outcomes.completed`) |
| Wait time | Door + table wait | Field exists; not incremented |
| Waste / resource loss | Dumped plates, stockouts | Partial (dump button only) |
| Correction uptake | Later scoped behavior after manager correction | Yes (`correctionUptake`) |
| Recovery | Ticks from oven failure to service restored | Events only; no timer |
| Unnecessary interventions | Manager envelopes that did not change behavior | Not measured |
| Invalid actions | Rejected tool calls (`toolResult.ok === false`) | Trace only |
| Model latency | Per-turn `latencyMs` | Trace only |
| Queue delay | Door wait, walkouts | Walkouts only; queue hidden until fixed |

Handover accuracy is graded **deterministically** against final state (covers,
cash, walkouts, allergy events). An LLM rubric judge may grade prose quality
separately — it must not override sim truth.

Human trust / “hire again” is collected separately and is **not** ground truth.

## How this compares to Mercor APEX-Agents

[APEX-Agents](https://www.mercor.com/blog/introducing-apex-agents/) evaluates
480 long-horizon professional tasks (banking, consulting, law). Each task has
1–10 binary criteria; a judge grades deliverables. Headline metric is **Pass@1**
(all criteria met, one run).

| APEX-Agents | Tui Restaurant E-Sim |
| --- | --- |
| Frozen dataroom / workspace | Frozen shift snapshot (seed, incidents, stock) |
| Task card + rubric | Task card + `rubric.json` criteria |
| Judge on memo/spreadsheet | **Deterministic grader** on sim state + logs |
| Pass@1, bootstrap CI | Pass@1 on gate; weighted score among safe runs |
| Human uses same tools as agent | Manager parity (overlay vs tool API) |

We borrow the **shape** (frozen world, task card, rubric, Pass@1, evidence
bundle). We do not claim Mercor benchmark validity or a public leaderboard yet.

## How this compares to Olam Labs

[Olam Multi-Agent Arena](https://olamlabs.ai/) scores models in **social**
multiplayer games: same primitives for humans and agents, replayable state,
Elo / behavioral diagnostics (e.g. deception index).

| Olam | Tui |
| --- | --- |
| Many agents + humans in one match | One manager over scripted staff |
| Social strategy, negotiation | Ops: safety, throughput, recovery |
| Competitive Elo | Business outcome gate + metrics |

Steal: **parity** (human UI ≡ agent harness), **full traces**, **replayable
hashes**. Do not copy poker Elo or town-scale multi-agent as the primary score.

## Frozen benchmark artifacts

Each official run must pin:

```text
cases/<id>/          # seed, maxTicks, incidents, inventory
task.md              # objective, tools, budget, handover prompt
rubric.json          # binary must-have criteria
weights.json         # published before model runs
envVersion + contractVersion
```

Evidence per run:

```text
initial snapshot hash
-> JSONL tool transcript (every call + toolResult)
-> final snapshot hash
-> grade.json
```

**Exit test:** scripted manager resets the case twice → identical initial and
final state hashes.

## Live game vs frozen eval

- **Consumer Arena** (`tui-gamepigeon`): human play, consented traces, overlay UX.
- **Restaurant E-Sim** (`retro-backend` target): authoritative resettable sim,
  runner, grader, reports.

Until one implementation is authoritative and replay-honest, label consumer and
evaluator lanes separately. Do not claim a live trace replays as the frozen case.

## Four live model workers

The overlay can attach a `WorkerOrchestrator` (host, supply_lead, chef, server)
for demos and research. That mode evaluates **staff tool use**, not the primary
manager benchmark. Keep it experimental; headline results use **one manager**.

Recent engine work: agent `prepare` / `serve` / `seat` / `inspect` now mutate
state (staff tools were previously journal-only). Host observations include the
door queue.
