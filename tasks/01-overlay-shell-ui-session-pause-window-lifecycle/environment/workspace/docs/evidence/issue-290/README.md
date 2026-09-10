# Issue 290: cross-engine comparison readiness

## Result

**Partially comparable.** Routine priority and the tick-8 oven incident run
through both engines. The manager-correction difference is explicitly
unsupported, rather than treated as a passing comparison.

The native Arena can accept a manager intervention through
`RestaurantGame.submitPlayerIntervention()` / `stepEnvelope()`. E-Sim records
validated manager directives, but its v1 directives deliberately do not mutate
restaurant state. A runtime correction therefore has different scoring inputs
until a later manager-action contract reconciles the two behaviors.

The v2 comparison fixture uses `supply_lead` as canonical and normalizes it at
the frozen v1 E-Sim boundary, which still calls the role `expediter`.

## What was checked

```sh
npx --yes bun@1.3.11 test src/games/restaurant-arena/baseline.test.ts
```

Result: 4 passing native replay/trace checks. This proves native replay is
deterministic; it does **not** prove cross-engine equivalence.

With both clean worktrees present, run the comparison:

```sh
RETRO_BACKEND_ROOT=/absolute/path/to/retro-backend \
  npx --yes bun@1.3.11 scripts/compare-arena-engines.ts
```

It fails on an unexpected routine or incident difference and emits the known
manager-correction difference as `unsupported`.

Native traces already record `restaurantStateHash` at each replay input. That
is the comparison value to export after each shared scenario step; do not
compare native checkpoint hashes with E-Sim trajectory hashes.

## Smallest next change

1. Give E-Sim a manager action that changes restaurant state through the same
   authority boundary as a native correction.
2. Compare the resulting manager-correction scoring inputs rather than listing
   that scenario as unsupported.

Until that work exists, no human/model result should claim correction behavior
is comparable.
