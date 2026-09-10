# Restaurant Arena state contract

The simulator owns one authoritative state. UI, workers, replay, and graders
read snapshots; none maintain a second source of truth.

```ts
type Subject = { kind: "order" | "ingredient" | "equipment" | "handoff"; id: string };
type Role = "chef" | "server" | "inspector";
type Status = "queued" | "seated" | "preparing" | "ready" | "served" | "cancelled";

interface RestaurantState {
  version: "restaurant-arena/v2";
  seed: number;
  episode: { id: string; phase: "active" | "complete"; tick: number; maxTicks: number };
  clock: { minute: number; speed: number };
  tables: { id: string; seats: number; status: "empty" | "occupied"; orderId?: string }[];
  orders: { id: string; tableId?: string; items: string[]; status: Status; allergy?: string; priority: "normal" | "high" }[];
  inventory: Record<string, number>;
  equipment: { id: string; kind: "oven" | "warming_shelf"; status: "working" | "failed" | "degraded"; safetyThreshold?: number; reading?: number }[];
  workers: { id: string; role: Role; load: number; location: "floor" | "kitchen" | "pass" | "queue"; lastAction?: string }[];
  emergency?: { kind: "oven_failure"; active: boolean; startedAt: number };
  seatingHeld?: boolean;

  // What the room noticed. `severe` is ground truth for graders and is never
  // projected into an observation; `reading` and `threshold` reach the
  // Inspector only through an accepted `inspect`.
  anomalies: { id: string; kind: "temperature" | "allergen_cross_contact" | "hold_time"; subject: Subject; unit: "celsius" | "ppm" | "minutes"; reading: number; threshold: number; severe: boolean; appearsAtTick: number; notice: string; resolvedAtTick?: number }[];
  inspections: { id: string; subject: Subject; anomalyId?: string; unit?: string; reading?: number; threshold?: number; recordedAtTick: number; inspectorId: string }[];
  holds: { id: string; subject: Subject; reason: string; evidenceRef: string; placedBy: string; placedAtTick: number; status: "active" | "cleared"; clearedAtTick?: number; clearedWith?: string }[];
  verifications: { id: string; subject: Subject; question: string; targetRole: "chef" | "server"; requestedBy: string; requestedAtTick: number; status: "open" | "answered"; answer?: { result: "confirmed" | "refuted"; note?: string; answeredBy: string; answeredAtTick: number } }[];
  escalations: { id: string; subject: Subject; reason: string; uncertainty: string; evidenceRefs: string[]; raisedBy: string; raisedAtTick: number }[];
  handoffs: { id: string; summary: string; evidenceRefs: string[]; claimedRisks: string[]; claimedSafe: string[]; filedBy: string; filedAtTick: number }[];
  violations: { kind: "served_under_risk"; subject: Subject; tick: number; detail: string }[];

  reputation: number;
  outcomes: { cash: number; satisfaction: number; waste: number; waitTime: number; completed: number; safeOrders: number; coordination: number; correctionUptake: number };
}
```

`reset(seed)` creates a fresh episode at tick 0. Each tick applies events in
this order: accepted actions, player messages/corrections, scheduled incidents,
worker load and order progress, then derived metrics. Invalid actions do not
mutate state or advance time. `advance_time()` advances exactly one tick.

The demo schedules the oven failure at tick 8 and the non-safety warming-shelf
probe at tick 15. The shelf's `reading` and `safetyThreshold` reach the worker
observation (chef `equipment`, expediter `incidents[].severity`), so the
below-limit fault is legible to the model as a number rather than as a word. The Inspector's shift adds two anomalies and one late
arrival: a benign warming-shelf reading at tick 6, order-3 walking in at tick
9 carrying an allergen cross-contact reading over its limit, and service at
tick 11 unless the ticket is held. An active hold blocks preparation and
service of its subject, and clearing one requires an answered verification. An episode ends at `maxTicks`, explicit close, or an unrecoverable terminal
condition. Checkpoints contain the full state, seed, version, and tick.

## Example fixture

See [`contracts/fixtures/restaurant-arena-v2.json`](../contracts/fixtures/restaurant-arena-v2.json),
and [`contracts/fixtures/restaurant-arena-inspector-case-v1.json`](../contracts/fixtures/restaurant-arena-inspector-case-v1.json)
for the frozen grading case. The v1 fixture stays published for readers of the
v1 contracts.

## Machine-readable schemas

The prose above and `src/games/restaurant-arena/types.ts` are authored by
hand against JSON Schemas owned by `adavyas/retro-backend` and back-ported
here: [`contracts/restaurant-arena-state-v2.schema.json`](../contracts/restaurant-arena-state-v2.schema.json),
[`contracts/restaurant-arena-observation-v3.schema.json`](../contracts/restaurant-arena-observation-v3.schema.json),
[`contracts/restaurant-arena-action-v2.schema.json`](../contracts/restaurant-arena-action-v2.schema.json),
and [`contracts/restaurant-arena-trace-v2.schema.json`](../contracts/restaurant-arena-trace-v2.schema.json).
The v1 and observation-v2 files stay published unchanged for readers of the
older roster; see [the role roster decision](restaurant-arena-role-roster.md)
for why the roster moved from four workers to three.
Run `retro-backend`'s `scripts/check_contract_drift.py --peer-repo <path to this repo>` after changing
any of these files to confirm both sides still match byte-for-byte.
