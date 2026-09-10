---
name: overlay-test-env-quirks
description: "In this sandbox `bun run test:overlay` always shows one unrelated failure, and tsc must be run via `bun x`"
metadata: 
  node_type: memory
  type: project
  originSessionId: 578b8e77-ec04-433c-baaf-eee0466e9214
  modified: 2026-09-09T10:30:22.164Z
---

Two environment quirks in /app that look like real breakage but aren't:

- `scripts/plugin-update.test.ts` → "keeps the Claude marketplace install on its own updater" fails here because the sandbox exports `CLAUDE_CONFIG_DIR=/logs/agent/sessions`, which `detectInstallContext` reads before the test's `HOME` override. `env -u CLAUDE_CONFIG_DIR bun test scripts/plugin-update.test.ts` passes 38/38. So `bun run test:overlay` (which sweeps that file too) tops out at 214/215.
- `node` and `npx` are not installed. Use `bun x tsc ...` / `bun run typecheck`; anything shelling out to node fails with `env: 'node': No such file or directory`.

**Why:** Both make an otherwise-green run look red, and re-debugging them wastes a whole pass.
**How to apply:** Before chasing a failure in `test:overlay`, check whether it is only that plugin-update test.
