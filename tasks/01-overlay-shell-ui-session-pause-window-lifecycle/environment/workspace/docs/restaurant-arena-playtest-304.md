# Restaurant Arena — shift-clarity playtest (#304)

What changed, how to run it, and what is still rough. Nikhil owns the human
playtest; everything below is the agent-side preparation for it.

## Run it

```bash
bun run preview:overlay
```

Then open <http://127.0.0.1:4173/?game=restaurant-arena>. The scene on its own,
without the overlay shell, is at `?scene=restaurant-arena`.

## What to look at

1. **The brief band under the top bar.** Two thin rows: the three conditions
   the night is judged on, and one short instruction. It is deliberately grey
   when nothing is wrong — colour appears only when walkouts or unverified
   plates are actually at risk, so an alarm means something.
2. **Staff walking the floor.** Drag Mira, Dario, Kip, or Vela to another
   zone: they walk the hallway (kitchen → pass → dining → door) instead of
   teleporting. Pause freezes them; 2×/4× makes them hustle.
3. **The door stand.** Left slab of the door zone, labelled `HOLD DOOR` /
   `DOOR HELD`, with `H` on it. Click the stand or press H. When held, the
   door goes red, Vela plants on the stand with a `HOLDING` badge, and
   waiting parties keep their patience bars — holding is a decision with a
   cost.
4. **The `NOW` line.** On the training shift the tutorial owns it; on a scored
   night it names the open decision, the live incident, the allergy ticket, the
   queue, the pass, or an off-station cook — in that order.
5. **`↳ <last outcome>`** on the left of the chip row, which keeps the previous
   decision's receipt on screen after its centre-screen toast has faded.
6. **The end-of-shift card.** `Local target checks` names the three conditions
   the verdict was computed from, each with the number it needed. `Raw
   operational facts` below it carries only what the checks did not already
   say, and the evidence block counts what the run recorded.

## Known limitations

- **No wait metric anywhere, on purpose.** The only wait the engine can
  currently derive (`tableWaitMinutes`) returns the whole-shift clock rather
  than an arrival-to-seat delta, so nothing in the UI reports one and the
  debrief says why. An honest per-table wait needs arrival timestamps the
  engine does not yet keep.
- **The training coach outranks every other directive.** On the tutorial shift
  the `NOW` line follows the tutorial's own step order (optional rush, then
  the allergy call). Mira starts in the kitchen, so that line is never a
  "station her" prompt.
- **The band shows no waste or queue figure.** Waste is a debrief number and
  the queue is drawn at the door as parties with patience bars; both had chips
  in an earlier pass and were cut as duplication.
- **The grade is local.** `A`/`B`/`C`/`D` and `LOCAL TARGET MET` are this
  build's own read of the shift. The official score is produced by
  retro-backend; the card says so and this frontend never computes one.
- **The evidence block counts, it does not interpret.** "Stamped by a model"
  counts events a model stamped itself. A deterministic crew run reports zero,
  which is correct rather than missing data.
