/**
 * Export the reference Restaurant Arena trace fixture for `retro-backend`.
 *
 * The fixture is a complete dinner-rush shift on a fixed seed, played through
 * the same deterministic path the demo takes: the tick-8 allergy incident,
 * the player's safety correction, and the outcome. "Smallest valid" here
 * means the smallest run that still *succeeds* — a trace missing the
 * correction chain has nothing for a grader to grade, so a trimmed event
 * list would be a failing fixture, not a small one.
 *
 *   bun scripts/export-arena-trace.ts            # writes the fixture
 *   bun scripts/export-arena-trace.ts --check    # verifies without writing
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RestaurantGame } from "../src/games/restaurant-arena/restaurant-game.js";
import {
  exportTraceJson,
  summarizeTraceFailures,
  validateArenaTraceV3,
  type RestaurantArenaTraceV3,
} from "../src/games/restaurant-arena/trace.js";

/** The seed the demo and the benchmark both run. */
export const FIXTURE_SEED = 218220;
export const FIXTURE_EPISODE_ID = "dinner-rush-benchmark-218220";

const REPO_ROOT = join(import.meta.dir, "..");
export const FIXTURE_PATH = join(REPO_ROOT, "contracts/fixtures/restaurant-arena-trace-v3.json");

/**
 * Wall clock the fixture's timestamps are pinned to.
 *
 * A live run stamps events from `Date.now()`, which would make every export a
 * diff. The fixture is a synthetic artefact checked into the repo, so its
 * clock is fixed here and its timestamps keep only the spacing the tick clock
 * gave them. Nothing else is rewritten: state hashes never covered timestamps.
 */
const FIXTURE_EPOCH_MS = Date.parse("2026-09-05T18:00:00.000Z");
const MS_PER_TICK = 3000;

/**
 * Play the fixed-seed shift end to end. Deterministic: same seed, same input
 * sequence, same events, same timestamps — so re-running this produces a
 * byte-identical trace, and `--check` can tell a stale fixture from a current one.
 */
export function buildFixtureTrace(): RestaurantArenaTraceV3 {
  const game = new RestaurantGame(FIXTURE_SEED);
  game.step("sim_start");

  // Up to the tick-8 oven failure under the peanut-allergy ticket.
  for (let tick = 0; tick < 10; tick += 1) game.step("tick");

  // The player's safety correction.
  game.step("verify_substitution");

  // On to the end of the shift.
  for (let tick = 0; tick < 20 && !game.isOver(); tick += 1) game.step("tick");

  const trace = game.captureTrace({
    episodeId: FIXTURE_EPISODE_ID,
    runKind: "benchmark",
    deletion: { requestId: null, status: "retained" },
  });

  return {
    ...trace,
    events: trace.events.map((event) => ({
      ...event,
      timestamp: new Date(FIXTURE_EPOCH_MS + event.tick * MS_PER_TICK).toISOString(),
    })),
  };
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const trace = buildFixtureTrace();

  const validation = validateArenaTraceV3(trace);
  if (!validation.valid) {
    console.error("Refusing to export: trace does not validate against restaurant-arena-trace-v3.");
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const json = `${exportTraceJson(trace)}\n`;

  if (checkOnly) {
    let onDisk: string;
    try {
      onDisk = readFileSync(FIXTURE_PATH, "utf8");
    } catch {
      console.error(`Fixture missing: ${FIXTURE_PATH}. Run: bun scripts/export-arena-trace.ts`);
      process.exit(1);
    }
    if (onDisk !== json) {
      console.error("Fixture is stale. Run: bun scripts/export-arena-trace.ts");
      process.exit(1);
    }
    console.log(`Fixture is current (${trace.events.length} events).`);
    return;
  }

  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, json, "utf8");

  const failures = summarizeTraceFailures(trace);
  console.log(`Wrote ${FIXTURE_PATH}`);
  console.log(`  runKind:  ${trace.runKind}`);
  console.log(`  seed:     ${trace.seed}`);
  console.log(`  events:   ${trace.events.length}`);
  console.log(`  failures: ${failures.total}${
    failures.total > 0 ? ` (${JSON.stringify(failures.byCode)})` : ""
  }`);
}

if (import.meta.main) main();
