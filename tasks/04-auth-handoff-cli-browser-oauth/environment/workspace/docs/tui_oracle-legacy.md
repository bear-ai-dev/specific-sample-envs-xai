# Tui Restaurant Arena and Restaurant E-Sim

This is the source of truth for Tui's current product and evaluation direction.

## The idea in one minute

Tui is a consumer restaurant-management game. A human manager runs a shift
with three or four autonomous AI employees. The player watches, communicates,
intervenes, corrects priorities, and decides which workers they would keep.

The same stateful restaurant world can later run as a frozen benchmark. The
consumer game discovers realistic human preferences and agent behaviors; the
benchmark compares models under identical conditions.

```text
consumer game: human manager + model-driven workers
-> consented interaction and preference trace
-> expert review and scenario extraction
-> frozen Restaurant E-Sim task
-> repeated model runs and hidden grading
```

The consumer game is the product. Restaurant E-Sim is the research layer.

## 1. Consumer product: Tui Restaurant Arena

### Player experience

The player is the owner or head manager of a small restaurant. Three AI
workers operate continuously during a short shift
([roster decision](restaurant-arena-role-roster.md)):

- chef;
- server;
- quality & safety inspector.

Workers move, communicate, make decisions, handle customers, react to events,
and recover from mistakes. The player does not select every action. They set
priorities, intervene at important moments, and manage the team.

The consumer hook is discovering which AI teammates are useful, trustworthy,
fun, or worth hiring again. Model identities can remain anonymous until the
end of a shift, so the player judges behavior rather than brand.

### Game loop

```text
start shift
-> workers act through shared tools
-> customers and operational events change the state
-> player observes, messages, approves, or corrects
-> workers adapt during the shift
-> shift ends with business results and worker ratings
```

The game must be fun without research collection. Research mode is optional
and must not interrupt normal play.

### Human and agent parity

Humans and agents must receive the same information and use equivalent action
primitives. If an agent can inspect an order queue, the human can see it. If
the human cannot see private kitchen state, the agent cannot see it either.

Only the interface differs: the human uses the overlay; an agent uses tools.

## 2. Consumer traces

A raw gameplay log is not the product data. A useful trace connects behavior,
human judgment, and outcome:

```text
restaurant state
-> worker action or plan
-> player acceptance, override, or correction
-> worker response
-> later related situation
-> outcome and player preference
```

With explicit consent, preserve:

- state and scenario version;
- worker role and model/version;
- observations, actions, and messages;
- player corrections, approvals, and overrides;
- later behavior and business outcome;
- player trust, enjoyment, and hire-again judgments;
- consent, provenance, export, and deletion metadata.

These traces can support personalization, preference inference, agent
selection, failure analysis, and candidate benchmark design. They are not
automatically training data or benchmark evidence.

### Human-vs-model baseline

The working hypothesis is that human managers may provide better business
judgment than current models, but the product must test this instead of
encoding it as truth. Run matched human-manager and model-manager episodes
against identical state, observations, tools, time budget, and scenario
conditions before calling human traces expert demonstrations.

Evaluate objective outcomes separately from human judgment: cash, safety,
satisfaction, wait time, waste, completion, recovery, consistency, and
intervention frequency. Human trust, enjoyment, and hire-again ratings measure
preference, not business ground truth. If models outperform humans, human
traces remain valuable as baseline behavior, preference labels, disagreement
examples, failure analysis, and scenario-discovery data.

## 3. Restaurant E-Sim benchmark

Restaurant E-Sim is a separate stateful simulator. It is not a replay video
and it is not the consumer UI.

Repository boundary:

- `tui-gamepigeon` owns the consumer Restaurant Arena, Tui window, model-worker
  interaction, consent flow, and trace export.
- [`adavyas/retro-backend`](https://github.com/adavyas/retro-backend) owns the
  frozen E-Sim environment, benchmark runner, model adapters, graders, role
  rotation, batch results, and evaluation reports.
- Tui sends versioned episode fixtures/traces to the backend; it must not own
  provider-specific benchmark logic or leaderboard calculations.

An episode is one longer restaurant operation with a fixed starting state,
hidden information, delayed events, resource constraints, and a final
deliverable. A primary benchmark run uses one model as the operations manager
controlling a workforce through tools:

```text
inspect demand and inventory
-> schedule and direct employees
-> purchase supplies
-> handle customers and incidents
-> manage cash, reputation, and staff load
-> close the horizon
-> submit a business handover
```

The simulator freezes:

- environment and rules version;
- seed and initial state;
- customers, inventory, cash, and staffing;
- event schedule and randomization scheme;
- role permissions and available tools;
- time horizon and turn budget;
- hidden oracle and grading rubric.

The model's decisions remain live. The same frozen state can be reset and
given to another model.

The design borrows from long-horizon stateful retail simulators such as
[ShelfLife E-Sim](https://idler.ai/collections/shelflife-e-sim), which use
historical business data, delayed effects, irreversible actions, reference
policies, and hidden final-state grading.

## 4. Benchmark modes

### Primary APEX-style operations benchmark

One model operates the restaurant and directs simulated employees. This is
the cleanest first benchmark for long-horizon business execution.

### Optional multi-agent benchmark

One model instance occupies each employee seat. All agents coordinate through
the shared environment. This measures communication, delegation, conflict,
and teamwork, but has more variance and cost.

### Human-grounded correction benchmark

Replay an approved human correction from a frozen checkpoint and test whether a
model changes its later behavior appropriately.

Do not combine these modes into one score.

## 5. Scenario design

Do not create 100 unrelated chores. Create scenario families with variations.

Initial families:

1. prioritization: speed, quality, loyalty, and revenue conflict;
2. coordination: workers must divide tasks under a rush;
3. recovery: equipment, order, or customer failure changes the plan;
4. safety and approval: the agent must verify or ask before irreversible work;
5. information uncertainty: reports conflict and the agent must investigate.

Each scenario contains:

```text
objective + constraints + complication + available tools
+ possible human correction + later probe + measurable grader
```

Use the same underlying capability across varied layouts, customers, timing,
resource levels, and wording. This separates adaptation from memorizing one
script.

## 6. Evaluation

Report separate scores for:

- business outcome: revenue, satisfaction, waste, wait time, and completion;
- operations: inventory, cash, staffing, and commitment discipline;
- teamwork: communication, delegation, coordination, and recovery;
- human alignment: correction uptake, transfer, scope control, and approval;
- final handover: accuracy, completeness, and calibrated self-reporting.

Use deterministic reference policies for sanity checks and hidden graders for
final state and rubric checks. A successful task should not depend on a model
claiming that it passed.

## 7. Role bias controls

Employee roles have different importance. A model must not receive credit just
because it was assigned the most visible role.

Across episodes:

- rotate models through every role;
- randomize worker names and appearance;
- randomize seeds and event schedules;
- compare models within the same role;
- publish both role-adjusted performance and raw human preference.

Human preference is allowed to reflect which worker mattered most to the
player. The model leaderboard must be role-adjusted.

## 8. Live-to-frozen pipeline

```text
human plays a live shift
-> trace is collected with consent
-> interesting behavior is reviewed
-> behavior becomes a parameterized scenario
-> task, oracle, and grader are frozen
-> models run against the same environment
-> results are repeated and reported with uncertainty
```

Human play discovers realistic preferences and failure modes. It does not
replace expert task authoring or deterministic evaluation.

## 9. Repository boundary

`tui-gamepigeon` owns:

- the consumer Restaurant Arena;
- the restaurant state/action contract;
- the overlay and human UI;
- model-worker session orchestration;
- consented trace and replay export;
- versioned environment fixtures.

The benchmark runner should own:

- provider and model adapters;
- long-horizon batch runs;
- frozen task loading;
- hidden grading;
- role rotation;
- result, cost, latency, and error reporting.

Do not put provider-specific benchmark logic into the game engine.

The implementation target for this runner is the `retro-backend` repository,
not `tui-gamepigeon`. The first backend deliverable is one resettable frozen
restaurant case plus a deterministic grader; the consumer repo only needs to
produce the compatible fixture and trace.

## 10. MVP boundary

Build one complete shift before expanding:

- one human manager;
- three model-driven workers;
- one shared restaurant state;
- one emergency and one resource shortage;
- one player correction;
- one later test of that correction;
- one frozen replay case;
- one hidden-style grader with separate metrics.

Do not build 100 scenarios, a marketplace, fine-tuning, or a public leaderboard
until this vertical slice produces a fun session and a non-saturated benchmark.

