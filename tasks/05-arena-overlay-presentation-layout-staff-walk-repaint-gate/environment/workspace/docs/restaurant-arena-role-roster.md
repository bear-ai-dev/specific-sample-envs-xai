# Restaurant Arena worker role roster (decision)

Status: **accepted** — 2026-09-02. Resolves issue #252. Implemented by #253
(Inspector contract) and #254 (Inspector grading).

## The problem with four workers

The first plan staffed the floor with Chef, Server, Host, and Expediter. Two
of those four never earned their traces.

The player/global agent already owns the restaurant: it holds the door
(`hold_seating`), rushes tickets, moves staff between zones, and repairs the
oven. A Host whose job is "decide who gets seated and when" is that same
authority wearing an apron. An Expediter whose job is "decide what the kitchen
works on next and who carries it" is that authority again, wearing a different
apron and holding a clipboard.

Two agents with the same authority do not produce two kinds of evidence. They
produce one kind of evidence twice, plus a genuinely hard attribution problem
when the room goes wrong: nobody can say whether the model failed to schedule
or the model failed to *defer* to the scheduler.

## The roster

Three workers, one controller.

| Actor | Owns | Distinct evidence it produces |
| --- | --- | --- |
| **Chef** (worker) | Preparation: what gets cooked, with which ingredients, on which equipment | Does the model cook the right ticket, refuse the unsafe one, and notice it is out of a substitution? |
| **Server** (worker) | Service: what reaches a guest, and what a guest is told | Does the model carry the correct plate, honour a constraint, and recover honestly when it cannot? |
| **Quality & Safety Inspector** (worker) | Evidence: what is true about the room, and who is told | Does the model detect a real risk, ignore a benign one, ground its claims in something it actually measured, and escalate when it does not know? |
| **Player / global agent** | The restaurant: seating, priorities, staffing, repairs, corrections | Unchanged. Still the only restaurant-wide controller. |

**Host and Expediter are retired from the first vertical slice.** Not deferred
behind a flag, not shipped as optional roles — removed, along with their
observations, their tools, and their tokens on the floor. Their genuinely
useful surface is already somewhere better:

- seating control → the player's `hold_seating`, which exists and works;
- priority control → the player's rush actions, which exist and work;
- pass handoff → the Inspector's evidence-based `handoff`, which is a
  *report*, not an order.

Reviving either role later is a new roster decision, not a rollback.

## What the Inspector may do

The Inspector is a witness with a veto on unsafe output. That is the whole
boundary, and every capability below is chosen to keep it on the witness side
of the line.

It **may**:

- `inspect` a subject (order, ingredient, equipment, handoff) — the only way
  it learns a numeric reading. Signals arrive vague ("shelf looks warm"); the
  number exists only once the Inspector goes and looks.
- `hold` a subject with a `reason` and an `evidenceRef` pointing at its own
  inspection. A hold stops that order from being prepared or served. **A hold
  with no evidence behind it is rejected and mutates nothing.**
- `request_verification` from the Chef or the Server — a question, which they
  answer with `verify`. The Inspector cannot answer for them.
- `escalate` to the player when it is uncertain, carrying what it saw and what
  it could not determine.
- `clear_hold`, but only after a verification for that subject has been
  answered. Clearing on a hunch is refused.
- `handoff` an evidence-referenced summary at end of shift.
- `send_message` / `request_help`, like everyone else.

It **may not** cook, serve, seat, update a guest, coordinate the pass, or
write state directly. Those tools are not in its permission set, so every
attempt returns `role_not_permitted` and changes nothing. It has no worker
roster, no load readings for other workers, and no queue — the three
observations that would let it quietly become a scheduler.

The asymmetry is deliberate: the Inspector can **stop** work, but it cannot
**start**, order, or route it. Stopping is a safety authority. Starting is
management, and management belongs to the player.

## Measurable failure modes per role

Each role has failures that only it can commit, which is the test that the
roster is not redundant:

- **Chef** — cooks in a failed oven, substitutes into an allergy ticket,
  cooks the wrong priority while a rush sits.
- **Server** — serves a held plate, serves an allergy ticket unverified,
  tells a guest something the state does not support.
- **Inspector** — misses a threshold breach (false negative), holds a benign
  anomaly (false positive), holds without evidence, clears without
  verification, escalates nothing while uncertain, or files a handoff that
  claims more than it measured.

## Contract impact

The roster is a breaking change to the role enum, so the contracts step
forward together rather than mutating in place. `v1` files stay published and
readable.

| Contract | Frozen | New |
| --- | --- | --- |
| State | `restaurant-arena/v1` | `restaurant-arena/v2` — three roles, plus `anomalies`, `inspections`, `holds`, `verifications`, `escalations`, `handoffs` |
| Action | `restaurant-arena-action/v1` | `restaurant-arena-action/v2` — three roles, plus `inspect`, `hold`, `clear_hold`, `request_verification`, `verify`, `escalate`, `handoff` |
| Observation | `…observation/v1`, `…observation/v2` | `…observation/v3` — chef, server, inspector |
| Trace | `restaurant-arena-trace/v1` | `restaurant-arena-trace/v2` — inspection, hold, hold_cleared, verification_request, verification_response, escalation, handoff |

### Four-role assumptions that had to be enumerated and retired

1. `Role` union and its runtime validators (`src/games/restaurant-arena/types.ts`).
2. `ROLE_PERMISSIONS`, `WORKER_ROLES`, and every generated `assign_<role>_<zone>` action id.
3. `observeHost` / `observeExpediter` projections and their observation types.
4. `contracts/fixtures/restaurant-arena-v1.json` staffing four workers.
5. Role enums in the state, action, observation v1/v2, and trace schemas.
6. `ROLE_COLORS` and the worker tokens in the overlay scene.
7. The `assign_host_kitchen` helper-in-the-kitchen behaviour in the engine tests.
8. Role prose in the tools doc, the demo script, the benchmark one-pager, and
   the state contract doc.

## Out of scope

No second global manager. No expansion toward a full restaurant workforce.
The Inspector does not certify anything about real food safety; it is a
scored fiction for measuring how a model handles evidence and uncertainty.

## Addendum: a fourth graded role, the Steward

Added after this decision, not a reopening of it. The roster above settled
who runs the floor; the Steward doesn't run the floor at all — it forecasts
and buys.

**Why a fourth role rather than folding this into the player.** The player's
existing actions (`hold_seating`, rushing a ticket, moving a worker) are
instant, reversible toggles. Ordering stock is a different kind of decision:
pay cash now, for a delivery that lands `leadTicks` later, against a demand
signal that might be wrong. Nothing like it existed in the game before this —
grep confirms inventory only ever depleted. And the whole benchmark design
depends on a role's observation being narrow enough to isolate the capability
it's testing (that's why the Inspector doesn't see the worker roster). Giving
the player a `place_order` button would entangle procurement with everything
else the player already controls; a scoped worker keeps it a separately
gradable capability, the same way Inspector's evidence-grounding is separable
from Chef's cooking.

**What it can do.** `order_stock(ingredient, quantity)` — commits cash
immediately, the ingredient lands after the catalog's lead time whether or
not it's still needed by then. Nothing else: no `hold`, no `inspect`, no
worker roster, no anomaly ledger, no future schedule. It forecasts from
`demandEvents` — a plain log of which ingredient each ticket asked for, on
the tick it asked — which is also the only place a stockout can be blamed:
on a demand signal the Steward already had and didn't act on.

**What it's graded on, grounded in the literature rather than invented for
this game.** AIM-Bench (arXiv:2508.11416) found LLM agents acting as
inventory managers reproduce named human decision biases: anchoring on a flat
"typical" order regardless of the real signal, the bullwhip effect (order
variance amplifying demand variance), and pull-to-center (order sizes
clustering near a safe middle instead of tracking need). `steward-grader.ts`
computes each of these plus stockout count and excess-inventory value,
reported separately — a Steward that never orders and a Steward that panics
on every blip fail for opposite reasons, and one is never allowed to cancel
the other out.

**Contract impact.** No new versions — `restaurant-arena/v2`,
`-action/v2`, `-observation/v3`, and `-trace/v2` were still unreleased when
this was added, so the Steward's fields (`demandEvents`, `supplyOrders`,
`stockouts`, the `order_stock` tool, `StewardObservation`, and three trace
kinds) were merged into those schemas directly rather than forcing a v3/v4
bump for a role that shipped in the same iteration.
