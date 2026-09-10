# Tui Restaurant Arena and Restaurant E-Sim

This is the source of truth for the current product and evaluation direction.

## The one-minute version

Tui is a human-facing restaurant-management environment. A person can watch
AI staff, intervene, and decide what behavior they trust. With consent, Tui
captures the decision context, the intervention, later behavior, and outcome.

Restaurant E-Sim is the separate frozen evaluation layer. It resets a
versioned business-management task, gives a human or model the same manager
interface, records the tool trajectory, and grades final-state consequences.

```text
human-facing Arena
-> consented trace with context, decision, and outcome
-> review and task/rubric design
-> frozen E-Sim case
-> repeated human/model runs
-> deterministic grade and comparison
```

A trace does not automatically train a model or establish business truth. It is
evidence for preference, disagreement, failure analysis, and future task
design.

## The demo contract

The demo builds one complete vertical slice:

- One frozen dinner-rush case, task card, and manager tool contract.
- One authoritative, resettable environment.
- One human or model manager trajectory with a final snapshot and grade.
- One consented human trace where a person plays.
- A small human/model comparison with objective outcome metrics and human
  preference reported separately.

The primary evaluation unit is one **operations manager** directing simulated
staff. It is not a team of four independent model workers. A multi-agent staff
mode is a later research variant, only after the primary manager task has
repeatable grades.

## The first task

The fixed dinner-rush case includes:

- two orders, including one allergy-sensitive order;
- limited inventory and a scheduled oven failure;
- a fixed horizon and a short final operational handover;
- manager actions to inspect, prioritize, delegate, communicate, and advance
  time;
- a safety gate plus deterministic checks for completion, wait, waste, cash,
  recovery, and factual handover accuracy.

The manager can never directly mutate cash, inventory, orders, or outcomes.
The simulator validates all actions. Safety is a pass/fail constraint, not a
bonus that can be exchanged for revenue.

## Human and model parity

A human-manager comparison is meaningful only if both sides receive the same:

- frozen initial state and scenario version;
- manager-visible information;
- manager action primitives;
- time or turn budget;
- outcome evaluator.

The interfaces may differ—Tui UI for a person and tools for a model—but the
information and authority must be equivalent. Human preference signals such as
trust, enjoyment, and “hire again” are valuable labels, but not business ground
truth.

The human-better hypothesis is deliberately unproven. A small demo sample can
show the measurement loop; it cannot establish that humans outperform models.
If models win a metric, the human trace remains useful as preference,
disagreement, and scenario-discovery data.

## The APEX / Archipelago boundary

Restaurant E-Sim should borrow the architecture of an APEX-style benchmark:

```text
task specification + frozen initial snapshot
+ validated environment tools + agent runner
+ final snapshot + task-specific evaluator
= auditable model result
```

The first deliverable is compatible in *shape* with Archipelago: a task card,
snapshots, tool transcript, runner output, and grade report. Do not block the
demo on Docker packaging, an MCP gateway, or a direct Archipelago integration.
Those are adapter work after the core loop is verified.

This is an APEX-inspired prototype, not a claim of APEX benchmark validity.
Mercor's core work relies on professionally authored tasks, calibrated rubrics,
repeated runs, and longer economically valuable workflows. The restaurant
setting is a controlled proxy for management decisions, not evidence that a
model can operate a real business.

## Repository boundary and current bridge risk

- `tui-gamepigeon` owns the consumer UI, consent flow, player-facing traces,
  and human interaction.
- `retro-backend` owns frozen cases, the simulator, runner, model adapters,
  evaluator, and reports.

At present, the two implementations differ:

- Tui has a `restaurant-arena/v2` world with chef, server, and inspector.
- Retro has a `restaurant-arena/v1` world with chef, server, host, and
  expediter.

They cannot yet support the claim that a live Arena trace replays as the same
frozen E-Sim case. The first implementation decision is therefore to make the
resettable `retro-backend` `RestaurantSim` authoritative for the demo case
and render its manager-facing snapshot in Tui. If that bridge is not complete,
consumer traces and E-Sim results must be explicitly shown as separate lanes.

## Evidence and reporting

Every model result should retain:

- task, environment, and contract versions;
- initial and final snapshot hashes;
- every tool call and simulator result;
- model/config, turn budget, latency, cost, and termination;
- raw outcome dimensions and a grade breakdown;
- factual handover checks separate from operational outcome.

The demo report should compare safety, completion, wait, waste, cash, recovery,
handover accuracy, cost, and latency. It should show human preference in a
separate column and disclose sample size.

## What is out of scope now

- Training or fine-tuning from traces.
- Claims that humans are better than models.
- Four-model-worker competition, role rotation, and a leaderboard.
- Large task libraries, multiple providers, or real restaurant operations.
- A polished replay product, complex behavioral matrix, Docker/MCP packaging,
  or direct Archipelago integration.

## Longer-term research direction

After the one-case loop works, add expert-authored management task families
with held-out variants, repeated runs, calibrated rubric checks, and a reviewed
trace-to-case process. Then evaluate whether human interventions identify
failure modes, improve task coverage, or create useful alignment tests.

The distinctive contribution is not a restaurant simulator alone. It is the
auditable bridge from a human business decision and its consequence to a
versioned, frozen counterfactual evaluation task.
