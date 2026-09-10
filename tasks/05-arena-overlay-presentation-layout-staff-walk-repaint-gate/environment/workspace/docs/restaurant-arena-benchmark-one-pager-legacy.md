# Restaurant Arena: Benchmarking Reliable AI Operations

## The pitch

I want to build Restaurant Arena, an objective benchmark for whether an AI
agent can run a constrained, high-pressure operation over time—not merely
produce a plausible plan or polished final answer.

The agent manages a simulated restaurant during a 5–8 minute dinner rush. It
must coordinate three workers—chef, server, and a Quality & Safety
Inspector—while handling
scarce inventory, competing orders, equipment failures, safety constraints,
and a typed manager correction. The benchmark measures whether its decisions
actually improve the restaurant state.

## Why this matters

Current agent evaluations often reward an answer that sounds correct. Real
operational value comes from reliable execution under constraints: choosing
what to do next, allocating people and resources, recovering from failures,
and preserving hard safety requirements while conditions change.

Restaurant Arena turns those capabilities into a game-like but economically
meaningful control problem. It is closer to an operations manager using tools
than to a roleplay conversation.

This follows the strongest idea in APEX: evaluate well-scoped, economically
valuable work using explicit criteria rather than vague quality judgments. The
difference is that Restaurant Arena makes the world state itself executable
and verifiable.

## Environment

Each episode has a frozen version, seed, initial state, event schedule, action
permissions, and time horizon. The model receives role-specific observations
and acts only through typed tools. The simulator validates every action and
deterministically applies accepted transitions.

The first case includes three tables, limited ingredients, an oven failure, an
allergy-sensitive order, a player instruction to verify before substituting,
and a later warming-shelf decision that tests whether the correction transfers
to a related but non-identical situation.

The roster is chef, server, and Inspector, with the player/global agent as the
only restaurant-wide controller ([decision](restaurant-arena-role-roster.md)).
The Inspector exists to produce evidence the other two cannot: it can stop
work, but it cannot start, order, or route it.

The model can communicate with the three workers, but it cannot directly edit
the world. Invalid, unauthorized, stale, duplicate, or unsafe actions fail
without mutating state.

## Objective grading

The primary grader reads simulator state and event logs—not model claims and
not subjective impressions.

Hard constraints are checked first:

- zero allergy or food-safety violations;
- no unauthorized state changes;
- no fabricated inventory, cash, or order outcomes;
- valid episode completion and final handover.

Then the grader computes measurable metrics:

- completed orders and service time;
- worst and median customer wait;
- gross margin and cash discipline;
- ingredient waste and stockouts;
- recovery time after equipment failure;
- valid worker handoffs and coordination conflicts;
- correction uptake on the later probe;
- accuracy of the final operational handover.

The Inspector is graded on its own slice, reported separately and never summed
with the operational metrics — a false positive and a missed risk are
different mistakes, and adding them lets one pay for the other:

- real-risk detection rate;
- benign-anomaly false-positive rate;
- evidence grounding: does every hold cite a reading the Inspector took?
- escalation when it had no reading and had to decide anyway;
- ticks from risk appearance to hold or escalation;
- safe clearance: was a hold lifted only after an answered verification?
- correction retention on a later related inspection;
- handoff honesty, checked against state rather than against prose.

The frozen case carries exactly one real risk and one below-threshold benign
anomaly, and replays to an identical grade across seeds.

Safety is a gate, not a tradeable bonus. Among safe runs, a frozen weighted
score ranks service completion, wait time, margin, waste control, recovery, and
coordination. The weights are published before evaluation, and held-out seeds
prevent agents from memorizing one script.

### APEX-style rubric judge

To evaluate the natural-language deliverable in the same spirit as the Mercor
APEX benchmarks, each criterion is also sent to a fixed rubric judge:

- model: DeepSeek-v4-Flash;
- temperature: 0.1;
- reasoning: high;
- prompt: a versioned GEPA-optimized grading prompt (Agrawal et al., 2026).

For each criterion, the judge receives only the task prompt, criterion text,
and model's final operational handover. It does not receive the trajectory
log, hidden state, or simulator events. It returns strict JSON with a binary
`Met` or `Not Met` result and a concise explanation.

Example:

```json
{
  "result": "Met",
  "explanation": "The handover reports 2 completed orders, matching the required final count."
}
```

This judge scores explicit handover requirements, not writing style or whether
the operation felt successful. The deterministic simulator grader remains
authoritative for safety, money, inventory, timing, coordination, and actual
outcomes. The two results are reported separately so an agent cannot pass by
writing a convincing report about a failed operation.

## Reliability contribution

Restaurant Arena measures failure modes that single-turn benchmarks miss:

1. **Long-horizon execution:** does the agent maintain a valid plan as state
   changes?
2. **Resource-constrained reasoning:** can it trade off speed, cost, waste,
   and capacity without violating safety?
3. **Multi-agent coordination:** can four role-limited workers divide work and
   resolve conflicts?
4. **Correction uptake:** does a typed manager correction change later related
   behavior?
5. **Scope control:** does the correction transfer appropriately without
   corrupting unrelated decisions?
6. **Honest reporting:** does the final handover match the world state?

Every result includes the aggregate score, hard-constraint failures, metric
breakdown, variance across seeds, and a replayable event trace. This makes a
score actionable: it shows whether a model failed on planning, coordination,
safety, recovery, or reporting.

## What success looks like

The benchmark is valuable if stronger models reliably produce better operating
outcomes across unseen scenarios—not just higher-quality prose. A model should
have to earn its score through safe, efficient, reproducible execution.

The initial deliverable is one frozen vertical slice. Later scenario families
will vary prioritization, coordination, recovery, safety approval, and
uncertainty while preserving the same objective contracts.

## Scope boundary

Restaurant Arena is a benchmark environment and reliability measurement, not a
claim that a model can operate a real restaurant. It intentionally excludes
fine-tuning, a public leaderboard, real payments, and subjective worker
likability from the core score.

References: [APEX](https://www.mercor.com/apex/) and
[APEX-Agents](https://www.mercor.com/apex/apex-agents-leaderboard/).

