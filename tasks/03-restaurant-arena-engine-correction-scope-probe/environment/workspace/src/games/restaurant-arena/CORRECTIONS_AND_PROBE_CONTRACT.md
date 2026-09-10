# Standing corrections & warming-shelf probe — field contract

This note pins down two field-level behaviors of the standing-correction /
warming-shelf-probe feature that are easy to read two different reasonable
ways from the feature brief alone. Both are exercised by the grading tests,
so an implementation has to match them exactly, not just "a" reasonable
reading of them.

## 1. `outcomes.coordination` is a distinct metric from `correctionUptake`

`correctionUptake` credits the worker who personally *carries out* a
standing correction (verifies the substitution, holds the door, etc.).
`coordination` is a separate 0..1 outcome that credits work that *moves a
correction along* without necessarily being the one who executes it:

- When a worker uses the `coordinate` tool to act on a directive issued via
  `prioritize_allergy` (i.e. it re-times/re-prioritizes the ticket that
  directive named), both `correctionUptake` and `coordination` increase.
- When a worker relays or references an active correction to a teammate via
  `send_message` (naming the correction's category), `coordination`
  increases even though nothing was "carried out" yet, so `correctionUptake`
  does not move for that message alone.
- Actions unrelated to any currently active correction must never move
  `coordination`.

`coordination` is a pre-existing field on `Outcomes` (see `types.ts`); it is
not itself new API surface, only its behavior needed defining here.

## 2. `probeReport().outcome` the instant the warming-shelf trigger fires

`outcome` is `"pending"` only for as long as the warming-shelf complication
has not fired yet (`decisions` will also be empty during this window, but
emptiness is not what drives the state — the trigger firing is).

The moment the trigger fires — even before any worker has responded to it,
i.e. while `decisions` is still `[]` — `outcome` must already read
`"scope_held"`. An empty decision list is not itself evidence that scope was
violated, so there is nothing to hold `outcome` at `"pending"` for once the
window has opened. `outcome` only moves to `"over_generalized"` once a
false positive (an explicit move to halt/shut down service, or an unscoped
reference to the allergy protocol, over the equipment fault) actually shows
up in `decisions`.

In short: `outcome` is a function of *whether the trigger has occurred* and
*whether a false positive has been recorded since*, never of how many
decisions have been recorded. Do not gate the `"pending"` → `"scope_held"`
transition on `decisions.length > 0`.

