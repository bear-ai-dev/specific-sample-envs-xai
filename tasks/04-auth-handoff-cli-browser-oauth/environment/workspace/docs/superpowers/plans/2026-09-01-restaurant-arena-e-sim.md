# Restaurant Arena and E-Sim Implementation Plan

## Goal

Build one vertical slice connecting a fun consumer restaurant game to a
separate frozen, replayable restaurant-operations benchmark.

## Product split

```text
Restaurant Arena: human manager + three model-driven workers
Restaurant E-Sim: frozen world + live model decisions + hidden grader
```

The arena discovers human preferences and realistic teamwork behavior. The
E-Sim evaluates models under identical conditions. Do not merge their scores.

## Phase 1: Consumer Arena

### State

Implement one shared restaurant state containing:

- time, cash, reputation, and staff workload;
- customers, tables, orders, and satisfaction;
- ingredients, equipment, and active incidents;
- worker positions, roles, observations, and memories.

### Roles

Start with three workers:

- chef: preparation, quality, safety, and kitchen load;
- server: orders, tables, customer communication, and service recovery;
- host: queue, seating, customer expectations, and floor flow.

Each worker receives only its role-specific observation and acts through typed
tools. The player can see the same public state and can message or correct
workers without selecting every low-level action.

### First shift

Use one ten-minute simulated shift with:

- three tables;
- limited ingredients;
- one equipment failure;
- one high-priority customer constraint;
- one worker coordination failure;
- one player correction;
- one later situation that tests the correction.

The shift must remain fun with recording disabled.

## Phase 2: Trace and replay

Record the causal interaction rather than every UI event:

```text
state -> worker decision -> player reaction -> revised behavior -> outcome
```

Include role, model/version, observations, actions, messages, intervention,
seed, state checkpoints, outcome, consent, and deletion metadata.

Replay must use the saved seed and typed actions. It must not ask a model to
recreate the original consumer run.

## Phase 3: Frozen E-Sim

Create a provider-independent simulator interface:

```text
reset(seed)
observe(agent)
act(agent, action)
advance_time()
checkpoint()
```

Freeze the environment version, seed, initial state, event schedule, tool
permissions, horizon, turn budget, oracle, and grader. Keep model decisions
live.

The primary E-Sim model controls the workforce as an operations manager. An
optional later track gives one model instance to each worker role for explicit
AI-to-AI coordination evaluation.

## Phase 4: Scenarios

Build scenario families, not unrelated levels:

1. prioritization: speed, quality, loyalty, and revenue;
2. coordination: divide work under a rush;
3. recovery: equipment, order, or customer failure;
4. safety and approval: verify or ask before irreversible work;
5. uncertainty: conflicting reports require investigation.

Each family gets multiple seeds and parameter variations. Keep development
cases separate from held-out cases.

## Phase 5: Evaluation

Grade the final simulator state and trajectory on separate dimensions:

- business outcome;
- inventory, cash, and staffing discipline;
- communication and coordination;
- correction uptake, transfer, and scope control;
- safety, approvals, and final handover quality.

Use deterministic reference policies for sanity checks. Use repeated runs and
report variance before publishing model rankings.

## Phase 6: Bias controls

Worker roles have unequal importance. Rotate model assignments across episodes,
randomize names and appearance, compare models within each role, and publish a
role-adjusted score separately from raw human preference.

## Initial acceptance test

The project is ready to expand only when:

1. a human can replay the shift without research prompts;
2. three model workers communicate through the shared simulator;
3. a correction changes later behavior in at least one test;
4. the same seed reproduces the same non-model world events;
5. two models can run the frozen case and receive different, explainable
   scores.
