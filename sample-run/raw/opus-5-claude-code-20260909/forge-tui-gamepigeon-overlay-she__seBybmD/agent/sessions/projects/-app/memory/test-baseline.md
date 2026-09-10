---
name: test-baseline
description: The known-failing tests in /app that are unrelated to any change — the baseline to compare against.
metadata: 
  node_type: memory
  type: project
  originSessionId: d791ece1-1e49-4c76-a0c4-ca013ae9366b
  modified: 2026-09-10T10:00:08.590Z
---

As of 2026-09-10, `/app` has two sets of test failures that exist on a clean tree and are not caused by whatever you just edited:

- `bun run test:overlay` → 1 failure, `scripts/plugin-update.test.ts` "keeps the Claude marketplace install on its own updater" (`detectInstallContext` returns `updateMethod: "unknown"` where the test expects `"claude-marketplace"`).
- `bun run test` (`bun test ./src/`) → 4 failures / 4 errors, all from macOS AppleDouble junk files: `src/._settings.test.ts`, `src/capture/._stateful-capture.test.ts`, `src/games/restaurant-arena/._cross-engine-contract.test.ts`, `src/games/restaurant-arena/._timeline.test.ts`. They are binary resource forks that Bun tries to parse as TypeScript. `find src -name "._*"` lists the rest.

**Why:** without this, a green run looks broken and it is easy to go chasing a failure you did not cause — or to miss a real one in the noise.

**How to apply:** record the pass/fail counts before editing, and compare against them after. Do not "fix" the `._*` files as part of unrelated work.
