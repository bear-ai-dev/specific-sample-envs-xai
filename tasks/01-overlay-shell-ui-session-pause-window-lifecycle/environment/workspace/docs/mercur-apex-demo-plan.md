# Tui Restaurant Arena: 11-Day APEX-Style Demo Plan

## The decision

Build one **frozen restaurant-management task** that a human or a model can
operate through the same manager interface, then grade its final state. Use the
consumer Arena to collect consented human decision traces around that same
task. Do not attempt a broad restaurant game, multi-agent leaderboard, or
training claim in eleven days.

This is an APEX-shaped prototype, not an APEX benchmark yet. Mercor's core
benchmarks use professionally authored tasks, expert rubrics, repeated runs,
and materially longer work. Our credible fellowship contribution is a method
for a hard-to-format economic capability—stateful business management—not a
claim that a five-minute restaurant shift measures real restaurant work.

## What we are optimizing for

By demo day, one UI path and one local command should produce:

```text
task card + frozen initial snapshot
-> human or model manager trajectory
-> final snapshot + deterministic grade
-> consented human trace, when a person played
-> small comparison report
-> replayable evidence bundle
```

The demo claim is: **Tui captures how people manage and correct AI-operated
business work, then turns reviewed examples into repeatable, stateful
evaluation cases with objective outcome grading.**

It is not: “we train models from traces,” “humans are better than models,” or
“an AI can run a real business.” Those remain hypotheses.

## The APEX / Archipelago shape to copy

Archipelago separates a task's environment, agent runner, snapshots, and
grader. Restaurant E-Sim should follow that structure:

| Component | Demo artifact | Owner |
| --- | --- | --- |
| Task specification | One-page objective, constraints, tools, budget, handover | `retro-backend` |
| Environment snapshot | Versioned state, incidents, deterministic reset | `retro-backend` |
| Agent interface | Small validated manager tool contract | `retro-backend` |
| Runner | Fixed model/config/budget run writing JSONL | `retro-backend` |
| Evaluator | Safety gate plus final-state outcome checks | `retro-backend` |
| Human trace | Consented manager actions, corrections, outcome, optional rating | `tui-gamepigeon` |

Do **not** Dockerize Archipelago, implement an MCP gateway, or claim its
trajectory/value verifiers during this demo. Preserve compatible artifacts—task,
snapshots, tool transcript, grade—so an adapter is possible after the loop
works.

## The primary task

One model is the **operations manager**. It directs a small simulated staff;
it is not four independent model workers taking turns. This measures business
prioritization, delegation, recovery, and reporting under shared state.

The fixed dinner rush has two orders, an allergy constraint, limited inventory,
and a failing oven. The manager can inspect, prioritize, delegate, communicate,
and advance time; it cannot directly edit cash, inventory, orders, or outcomes.
The episode ends at a fixed horizon with a short operational handover.

The evaluator checks safety first, then completion, wait, waste, cash, recovery,
and factual handover accuracy. A polished handover cannot compensate for an
unsafe run.

The current four-role runner is useful infrastructure, but it is not this
benchmark: it evaluates four role models, not one manager. Keep it
experimental; do not present it as the primary APEX-style result.

## The human-trace angle

A useful trace connects decision to context and outcome:

```text
same task snapshot -> manager action or correction -> resulting state -> grade
-> optional human rationale / trust rating
```

Run a matched early baseline before calling traces expert demonstrations. A
human manager and a model manager must receive the same case, information,
manager tools, time budget, and scoring. Report objective outcomes separately
from preference ratings. A small sample is exploratory, not a result about
humans versus AI.

For the demo, one fully consented human run and one or more model runs make the
loop visible. They do not support a superiority or model-improvement claim. A
reviewed trace can suggest a future task or rubric; it must never alter a
held-out case.

## First gate: remove the false shared-world claim

Today the repositories do not describe the same world:

- `tui-gamepigeon` runs `restaurant-arena/v2` with chef, server, and inspector.
- `retro-backend` freezes `restaurant-arena/v1` with chef, server, host, and
  expediter.

The current UI and evaluator cannot honestly replay the same episode or compare
a human with a model. Make one implementation authoritative for the demo case.
The least risky choice is the already-resettable Python `RestaurantSim`; the
Tui UI becomes a manager-facing view of its snapshot and emits the same manager
actions. If that bridge cannot be completed by Day 3, demo two explicitly
separate things—consumer trace capture and frozen E-Sim—without claiming a live
trace becomes the E-Sim case.

## What to stop building

- A four-model-worker benchmark, role rotation, and per-role leaderboard.
- Generic messaging, approvals, and priorities; retain one consequential
  manager instruction/correction.
- A polished replay timeline; retain raw JSONL, snapshots, and a readable
  summary.
- A large scenario library, multi-provider matrix, public leaderboard,
  fine-tuning, personalization, or real-world business claims.
- A complex behavioral failure matrix; retain the safety gate and a small
  published score breakdown.
- Docker/MCP/Archipelago integration before task, runner, and evaluator work
  locally end to end.

## Concrete 11-day sequence

Each checkpoint must be runnable locally. Do not advance because a document or
schema exists; advance only when the named command or UI path works.

### Days 1–2 — freeze the measurement contract

- Write the one-page task card and one JSON case: objective, manager-visible
  information, tools, horizon, safety rule, handover, and grading fields.
- Choose `RestaurantSim` as the authoritative demo state. Define the smallest
  manager action layer; staff behavior is deterministic environment behavior,
  not hidden model assistance.
- Write the explicit `v2` versus `v1` bridge decision. Either map the Tui view
  to the E-Sim snapshot or state that the demo lanes are separate.

**Exit:** a deterministic scripted manager resets the case twice and produces
identical initial and final state hashes.

### Days 3–4 — make the evaluator real

- Implement the one-manager runner and JSONL evidence: task/version, initial
  snapshot hash, every tool call/result, final snapshot hash, cost, latency,
  and termination.
- Implement `grade.json`: hard safety pass/fail, completion, wait, waste, cash,
  recovery, and factual handover checks. Publish weights before model runs and
  report raw dimensions too.
- Add one end-to-end local command using a deterministic reference manager.
  This is the no-provider test path.

**Exit:** `case -> runner -> JSONL -> grade` works in one command with no UI or
network call.

### Days 5–6 — connect the human experience narrowly

- Render the authoritative case snapshot in Tui, or label consumer and
  evaluator scenes as separate if the bridge gate failed.
- Give the human the same manager-level information and action primitives as
  the model. Keep one typed safety/priority correction and its visible effect.
- Capture a consented trace with task version, manager action, resulting state
  hash, outcome, and optional rationale/rating. Export raw JSON.

**Exit:** a human completes the same task and produces gradeable evidence, or
the UI clearly says it is an exploratory consumer trace rather than a
benchmark run.

### Days 7–8 — run the only comparison that matters

- Run at least one human and one model on the identical frozen task with fixed
  model/config/turn budget; disclose the sample size.
- Run a small repeated model sample if budget permits. Otherwise show one
  trajectory and call it a demonstration, not a benchmark ranking.
- Produce a simple table: safety, completion, wait, waste, cash, recovery,
  factual handover, cost, latency, and separately collected human preference.

**Exit:** every displayed result links to a task version, run artifact, and
grade. No score depends on model self-report.

### Days 9–10 — make the demo legible and robust

- Build one results screen or static report with task card, trace summary, and
  model/human comparison. Raw evidence remains available.
- Record one backup run. Rehearse live case, export, grade, and report on the
  actual demo machine.
- Stop feature work; fix only blockers on the single end-to-end path.

**Exit:** two rehearsals complete from reset to grade without manual data edits.

### Day 11 — tell the honest story

1. Show a person or model managing a constrained shift.
2. Show trace as context, action, and outcome—not magical training data.
3. Reset the identical task and show a frozen model run plus deterministic grade.
4. Compare objective business proxies with human preference separately.
5. Close with expert-authored management task families, repeated runs, and
   reviewed traces informing future case design.

## Demo acceptance checklist

- [ ] One versioned task card and frozen case exist.
- [ ] One authoritative environment resets reproducibly.
- [ ] Human and model use equivalent manager information/actions, or the demo
  labels them as separate lanes.
- [ ] A no-provider end-to-end deterministic test passes.
- [ ] Model runs create JSONL, final snapshot, and grade.
- [ ] A human trace is consented, exportable, and clearly labeled.
- [ ] Safety is a gate; preference is not ground truth.
- [ ] Results disclose model/config, task version, sample size, and limits.

## What is actually distinctive

Restaurant simulators already exist. The contribution is the bridge between a
usable human-facing environment and a frozen evaluator: capture a human
managerial intervention with outcome, review it, turn it into a versioned
counterfactual task, and evaluate models against deterministic business
consequences. If the bridge gate is not met, call it the next technical
milestone rather than claiming it is finished.

That is a credible Mercor fellowship wedge: a concrete way to evaluate
management work that mixes tools, delayed consequences, business tradeoffs, and
human judgment—economically valuable capabilities that resist standard task
formats.
