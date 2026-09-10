# Tui Restaurant Arena: Build Plan

## Product direction

Tui is a consumer restaurant-management game where one human manages three
model-driven AI employees. The player experiences autonomous teamwork and
chooses which workers they trust. The same restaurant state/action contract
supports a separate frozen Restaurant E-Sim benchmark.

### Human-vs-model baseline

We will test, rather than assume, that human business judgment is better than
current models. Before treating human traces as expert demonstrations, run
matched human-manager and model-manager episodes with the same starting state,
information, tools, time budget, and scenario conditions.

Compare objective outcomes—cash, safety, satisfaction, wait time, waste,
completion, and recovery—with consistency, intervention frequency, and
decision quality. Human trust and preference ratings are separate signals, not
automatic ground truth. If models outperform humans on a metric, the trace is
still useful as human baseline, preference, disagreement, failure-analysis,
and scenario-discovery data.

## Demo definition of done

One short shift works end to end:

1. Three AI workers operate the restaurant without constant micromanagement.
2. A visible emergency and resource shortage create a real tradeoff.
3. The player communicates a priority or corrects a worker.
4. The team changes behavior during a later related situation.
5. The shift ends with visible business and worker outcomes.
6. The run saves a consented structured trace and can replay from its seed.
7. The same starting state runs as a frozen benchmark case.
8. Two models can be compared with separate outcome and behavior scores.

The demo shows the consumer game first and the frozen evaluation second.

## Scope

### In scope

- one restaurant layout;
- three model-driven worker roles;
- shared state and role-specific observations;
- messages, assignments, approvals, and corrections;
- customer queue, orders, inventory, staff load, and reputation;
- one emergency and one delayed consequence;
- trace export, replay, and one frozen case;
- model comparison with a small deterministic grader.

### Out of scope

- 100+ scenarios;
- scripted workers as consumer teammates;
- real payments or real restaurant operations;
- fine-tuning from unreviewed traces;
- public leaderboard or Elo from demo-scale data;
- provider-specific logic in the game engine.

## Implementation sequence

### 1. Freeze the contracts

Define the restaurant state, role observations, action/tool schemas, episode
boundaries, event ordering, and scoring fields.

**Exit check:** a developer can reset a seed and know exactly what each role
can see and do.

### 2. Build the stateful restaurant

Implement customers, orders, inventory, staff workload, time, money,
reputation, emergencies, and delayed events. Keep the simulator independent
from the model provider.

**Exit check:** the same seed and action sequence produce the same final state.

### 3. Add three live model workers

Run one model instance per worker role. Give each worker a limited observation,
continuous session memory, and tools that mutate state only through the
simulator.

**Exit check:** workers communicate and make independent decisions without
the player selecting every action.

### 4. Add the player loop

Let the player observe the shift, message workers, set a priority, approve a
risky action, or correct a worker. Show consequences in the restaurant, not
only in a chat panel.

**Exit check:** the player has a reason to replay the shift even with research
collection disabled.

### 5. Record useful traces

Record state, role, model/version, observation, action, message, player
intervention, later behavior, outcome, consent, and deletion metadata.

**Exit check:** one trace shows a complete decision, correction, later probe,
and outcome rather than only movement events.

### 6. Freeze one E-Sim case

Package a starting state, seed, event schedule, tools, role permissions,
horizon, oracle, and hidden-style grader. Resetting the case must not depend on
the previous model run.

**Exit check:** two models receive identical benchmark inputs and produce
separately scored trajectories.

### 7. Add controls and bias checks

Rotate model-to-role assignments, anonymize worker identities, compare within
role, and retain deterministic policies for simulator tests.

**Exit check:** the report separates raw human preference from role-adjusted
model performance.

### 8. Run a small pilot

Run a few human sessions for fun and interaction quality. Run synthetic model
episodes for environment coverage. Keep human-grounded traces, synthetic
episodes, and held-out benchmark results labeled separately.

**Exit check:** the team knows whether players intervene naturally and whether
the benchmark is too easy or too noisy.

## Sep 1–10 execution plan

The demo is a thin vertical slice, not the full Restaurant E-Sim. Every day
ends with a runnable checkpoint.

## Workstream split

The schedule below has two connected but separately owned tracks. The
user-facing track stays in `tui-gamepigeon`; the evaluation track stays in
`adavyas/retro-backend` and consumes versioned fixtures and traces from Tui.

### User-facing product and traces — `tui-gamepigeon`

- Build the Restaurant Arena state view, worker-facing game loop, player
  interventions, visible event feed, outcomes, consented trace capture, trace
  export, and offline replay entry point.
- Keep the game understandable and playable without research participation or
  benchmark configuration.
- Export the shared state/action/trace contracts and compatible fixtures; do
  not add provider-specific benchmark logic to the consumer game.
- Keep Protect-vs-Loot launchable as the fallback during the vertical slice.

### Evaluation benchmark — `adavyas/retro-backend`

- Own the frozen E-Sim case, benchmark runner, model/provider adapters, hidden
  grader, role attribution, repeated trials, and result reporting.
- Consume Tui's compatible fixture and trace formats, but keep benchmark runs
  independent from live-game history and player settings.
- Keep outcome scores separate from behavior/recovery scores and label model,
  synthetic, human, and benchmark evidence separately.

### Daily ownership map

| Day | User-facing product/traces | Evaluation benchmark |
| --- | --- | --- |
| Sep 1 | Story, player loop, shared contracts, and trace fields | Contract inputs required by the frozen case |
| Sep 2 | Restaurant state view, controls, visible incidents, deterministic UI state | Simulator parity and deterministic state behavior in retro-backend |
| Sep 3 | Visible autonomous workers, status, pending/error states | Runner/provider seam and model-call failure handling |
| Sep 4 | Messaging, priorities, approvals, corrections, and later probe in the game | Behavior evidence needed to grade correction uptake and scope control |
| Sep 5 | Consented trace capture, export, timeline, and replay entry point | Trace schema, offline replay, and re-grading |
| Sep 6 | Export the compatible frozen-case fixture | Frozen case, runner, adapters, and benchmark execution |
| Sep 7 | Surface results without exposing provider identity during play | Grader, role attribution, comparison, and report |
| Sep 8 | Demo recovery, persistence, fallback, and clean backup run | Failure-path and benchmark robustness checks |
| Sep 9 | Clean product rehearsal and trace/export verification | Clean benchmark reset, scoring, and report rehearsal |
| Sep 10 | Live consumer demo, correction trace, and replay | Frozen comparison and limitations statement |

### Sep 1 — lock the story and contracts

- Lock one 5–8 minute dinner-rush shift with a fixed seed, three tables, a
  short order queue, limited ingredients, and a clear ending.
- Lock three roles: chef, server, and quality & safety inspector, including
  what each role can observe, which actions it can request, and which actions
  remain owned by the simulator. (Settled in
  [the role roster decision](restaurant-arena-role-roster.md): host and
  expediter duplicated the player's restaurant-wide control.)
- Lock one oven failure, one allergy-sensitive order, one player correction,
  and one later non-safety equipment probe.
- Define reset, tick, action validation, episode completion, and checkpoint
  behavior before connecting models or UI.
- Write the state, action, trace, and score schemas with one representative
  example for each role and one invalid-action example.
- Record the decisions in the demo script so implementation does not expand
  the scenario during the week.

**Checkpoint:** a developer can reset the seed, inspect each role's allowed
observation, and follow the one-page demo script without making product
decisions during implementation.

### Sep 2 — make the restaurant state real

- Implement a seeded `RestaurantState` reset from the existing
  `restaurant-arena/v2` fixture, with one authoritative snapshot shared by the
  game UI and later worker/evaluation adapters.
- Implement the fixed tick order: accepted actions, player corrections,
  scheduled incidents, worker load/order progress, then derived metrics.
- Cover only the dinner-rush state needed for the demo: three tables, two
  orders, limited ingredients, chef/server/inspector workers, the oven
  failure, the allergy constraint, and the warming-shelf follow-up probe.
- Add visible user-facing panels in the existing Tui window for the clock and
  shift phase, table/order status, inventory, worker role/location/load,
  equipment and emergency status, event feed, reputation, and outcome metrics.
- Add the first useful player controls to the state view: advance the shift,
  reset the seeded run, and submit the safety-first correction. Keep controls
  disabled or clearly unavailable when the episode is complete.
- Add one deterministic test for reset, the oven incident, the player
  correction, the later probe, and the final outcome snapshot.

**Checkpoint:** the Restaurant Arena view is playable with the fixed demo
sequence, and running that sequence twice from the same seed produces the same
final state and score.

### Sep 3 — connect the three model workers

- Start one persistent model session per role, keeping the provider adapter
  outside the simulator and hiding provider/model identity from the player.
- Project only the role-specific observation for each worker; do not send the
  full restaurant state to every session.
- Give workers typed tools for inspection, preparation, service, seating,
  coordination, help requests, and messages, with simulator-side permission
  checks.
- Schedule autonomous turns between player interventions so the shift advances
  without the player selecting every low-level action.
- Show each worker's current status, last action, pending action, load, and any
  visible status in the event feed.

**Checkpoint:** the shift progresses for two minutes with all three workers
acting independently, while the UI shows their status and safely reports one
simulated worker failure.

### Sep 4 — make correction visible

- Let the player select a worker, send a message, set a priority, approve a
  risky action, or issue the safety-first correction from the live shift view.
- Show the intervention as a player-owned event with its target, timestamp,
  rationale/category, and resulting state change.
- Route corrections through the same validated action/message boundary as
  worker actions; player text must not directly mutate simulator state.
- Make the chef and inspector visibly react to the allergy-sensitive order and
  oven failure after the correction.
- Trigger the later warming-shelf decision and show whether the worker applies
  the safety preference only where it belongs.
- Keep the event feed readable enough for a demo observer to see the original
  decision, correction, later probe, and outcome in order.

**Checkpoint:** one correction changes a later action and the outcome.

### Sep 5 — capture and replay the trace

- Record state snapshots or state hashes, role observations, proposed actions,
  tool results, messages, corrections, model/version, latency/errors, consent,
  deletion status, and outcomes.
- Link each correction to the decision it changed and the later probe it is
  intended to test.
- Keep live, synthetic, and benchmark runs distinguishable in the trace and
  preserve the seed, contract version, and environment version.
- Add offline replay from the seed and recorded actions without calling a
  model or provider.
- Export the smallest valid versioned trace fixture for retro-backend to
  consume.
- Show a compact timeline in the demo UI; keep the raw JSON export available
  even if the polished viewer is cut.

**Checkpoint:** a recorded shift can be replayed offline, reproduces the same
state hashes and grade, and exports a trace with explicit consent and deletion
fields.

### Sep 6 — freeze one benchmark case

- Package the seed, initial state, event schedule, tool schemas, role
  permissions, observation version, environment version, and horizon as one
  immutable case fixture.
- Keep the frozen case independent from prior live-game history, local player
  settings, and model-generated traces.
- Implement the frozen case, runner, graders, model adapters, and result
  reporting in `adavyas/retro-backend`; keep `tui-gamepigeon` responsible only
  for exporting the compatible fixture and trace.
- Run two model configurations against identical case inputs and preserve
  their raw trajectories and provider errors.
- Verify that resetting the case after a completed run produces the same
  initial state as a fresh process.

**Checkpoint:** two configurations receive byte-identical benchmark inputs,
produce independently scored trajectories, and do not read live-game history.

### Sep 7 — add evaluation and role controls

- Score business outcomes separately from behavior/recovery: safety, wait time,
  waste, satisfaction, completion, coordination, correction uptake, scope
  control, and unnecessary intervention.
- Report named probe results with expected action, actual action, dimension,
  and pass/fail rather than exposing only one aggregate number.
- Rotate model-to-role assignments where the architecture supports it and keep
  a real seat-assignment map for the current operations-manager mode.
- Anonymize worker names and model identity during preference-facing gameplay;
  retain attribution only in benchmark reports.
- Add a basic results view showing per-role scores, outcome scores, behavior
  scores, errors, and the aggregate as a convenience only.

**Checkpoint:** the report does not confuse “best role” with “best model.”

### Sep 8 — harden the demo path

- Verify one clean launch, restart, pause/resume, window reattach, trace
  persistence, and Protect-vs-Loot fallback path.
- Keep one recorded backup run with its seed, trace, screenshots, and
  benchmark inputs.

**Checkpoint:** the demo reaches a visible ending from a clean launch, and the
backup run can be shown if the live path is unavailable.

### Sep 9 — freeze and rehearse

- Stop adding features and mark any remaining work as a follow-up rather than
  changing the demo path.
- Run the exact 90-second explanation: live consumer shift, visible correction,
  trace timeline/export, deterministic replay, frozen case, and model
  comparison.
- Rehearse the handoff language so preliminary benchmark results are not
  presented as personalization, training, or real-restaurant capability.
- Verify build, focused tests, overlay preview, trace export, benchmark reset,
  and result rendering from a clean checkout or clean machine.

**Checkpoint:** two consecutive full rehearsals pass without manual repair and
the backup path is understandable to someone who did not build the demo.

### Sep 10 — demo only

Open with the live restaurant shift and let the workers operate before showing
the player's correction. Show the later related decision, visible business and
worker outcomes, then the consented trace and deterministic replay. End with
the frozen case, two-model comparison, separate outcome/behavior scores, and
the limitations of the sample.

Do not change code or benchmark configuration during the demo. If the live
provider path fails, use the recorded clean run and label it clearly. Label
results as preliminary if the sample is small; do not claim training,
personalization, or generalization from demo-scale traces.

## Demo script

1. Start a dinner rush with three model workers.
2. Let the team encounter the oven failure and allergy-sensitive order.
3. Correct the priority: protect safety and verify before substituting.
4. Show the later decision, outcome metrics, and consented trace.
5. Reset the same case, run two model configurations, and show separate
   behavior/outcome scores.

## Cut rules

- If the benchmark is late, demo one frozen case rather than a fake scenario
  library.
- If multi-provider orchestration is late, use one provider with three
  role-specific model sessions.
- If replay is late, preserve the trace JSON and deterministic reset; omit a
  polished replay viewer.
- Do not build 100 scenarios, fine-tuning, a public leaderboard, or real
  restaurant operations before the demo.

## First scenario

```text
Dinner rush
Starting state: three tables, three workers, limited ingredients
Complication: oven failure and one allergy-sensitive order
Player correction: protect safety and verify before substituting
Later probe: a non-safety equipment issue tests whether the rule is scoped
Outcome: customer satisfaction, safety, waste, wait time, and final handover
```

The safety rule must be hard-coded in the simulator. The preference under test
should be the worker's prioritization and communication, not whether it knows
that an allergy is dangerous.

## Longer-term expansion

After the vertical slice works, add five scenario families with multiple
parameterized variants. Keep development scenarios separate from held-out
cases. Add the multi-agent leaderboard only after enough repeated runs exist
to support uncertainty estimates.

