# Antigravity (Gemini) harness

Antigravity is Google's Gemini-based harness. Its CLI is **`agy`**, and it is the
only harness in this repo installed as a **project-local** plugin — there is no
`gemini` install flag, the target is `--antigravity`.

```bash
# From the project directory you will run `agy` in:
npx -y bun x @tui-games/tui@latest install --antigravity
```

That materializes `.agents/plugins/tui-gamepigeon/` (manifest, `hooks.json`, and
the `arcade` skill) into the current directory. Restart `agy` afterwards.

For local development, `bun run antigravity:dev` materializes the same plugin
from the checkout, points it at `scripts/`, and launches `agy`.

## Hook events: what Antigravity actually has

Antigravity's `hooks.json` looks like Claude's but does not share its events.
What it registers:

| Event            | Fires                     | Shape                         |
| ---------------- | ------------------------- | ----------------------------- |
| `SessionStart`   | at session start          | flat list of handlers         |
| `PreToolUse`     | before a tool step        | grouped (`matcher` + `hooks`) |
| `PostToolUse`    | after a tool step         | grouped (`matcher` + `hooks`) |
| `PreInvocation`  | before each model call    | flat list of handlers         |
| `PostInvocation` | after tool calls finish   | flat list of handlers         |
| `Stop`           | when the loop terminates  | flat list of handlers         |

`agy`'s bundled hooks documentation lists every one of those except
`SessionStart`, which fires but is undocumented — so nothing here depends on it.

**`UserPromptSubmit` and `SessionEnd` do not exist.** They are dropped without
an error, which is why on Antigravity the overlay never opened on a prompt,
never resumed after a pause, and never shut down at the end of a session. The
only tell is the load line in `~/.gemini/antigravity-cli/log/`:

```
Loaded hooks.json from …/.agents/plugins/tui-gamepigeon/hooks.json: 1 named hooks, 1 total handlers
```

Four declared handlers, one registered. When a `hooks.json` is right, the count
matches what it declares.

Three more contract differences matter:

- **stdout is parsed as JSON.** A hook that prints prose (the launcher's
  `Update available:` line, a stack trace) is a parse failure, not a message.
- **Hooks are synchronous.** There is no `async: true` like Claude's; a slow
  hook blocks the agent loop, with a 30s default timeout.
- **The working directory** is the directory containing `hooks.json`, and hook
  input arrives as JSON on stdin (camelCase, including `conversationId`).

## How the lifecycle is mapped

[`scripts/antigravity-hook.ts`](../scripts/antigravity-hook.ts) is the bridge.
`hooks.json` declares `SessionStart`, `PreInvocation`, and `Stop`, all three
pointing at it.

| Claude event       | Antigravity                                                     |
| ------------------ | --------------------------------------------------------------- |
| `SessionStart`     | first `PreInvocation` of a new session → `--reset`               |
| `UserPromptSubmit` | first `PreInvocation` of a turn → `--show` (+ update nudge)      |
| `Stop`             | `Stop` → `--pause`                                               |
| `SessionEnd`       | watchdog on the `agy` process → `--quit`                         |

Antigravity's own `SessionStart` only *clears* the session state, so the next
`PreInvocation` takes the new-session path. Nothing breaks if it stops firing —
it sharpens the boundary, it does not define it.

`PreInvocation` fires before *every* model call, so the turn boundary is
reconstructed from `~/.gamepigeon/antigravity-session.json`, which records the
harness pid, the conversation id, and whether the loop is running or stopped:

- **New session** (new `agy` process or a different conversation, which also
  covers `agy -c`): reset, then show. Reset first, so a stale overlay left
  mid-game snaps back to the menu before the window opens.
- **First prompt after a `Stop`**: show, which clears the paused flag.
- **Mid-turn invocations**: nothing. This is the common case and it stays local
  — no process spawned, no ancestor walk.

Every overlay call is spawned **detached with its output discarded**, so the
hook itself only touches local files and returns in tens of milliseconds; the
overlay's own work (session refresh, binary download) happens outside the agent
loop. The hook always writes exactly one JSON object to stdout and always exits
zero.

Those children take an advisory lock on `~/.gamepigeon/antigravity-apply.lock`,
so a `pause` spawned by a quick `Stop` cannot overtake the slower `show` it is
meant to follow — `show` does a session refresh and can download a binary, and
without the lock the game resumed while the agent sat idle.

Two ordering caveats, both deliberate:

- The lock serves whoever asks first; it is not a queue. Two hook events fired
  within about a hundred milliseconds of each other can still apply out of
  order. The agent loop cannot produce that — `Stop` is followed by however long
  the user takes to type the next prompt — so it only shows up when a script
  drives the hooks back to back.
- When `agy` exits within milliseconds of a session's last `Stop`, that final
  `pause` can lose its overlay process to the teardown. It writes the paused
  flag before it spawns anything, and the watchdog quits the overlay a moment
  later, so the outcome is the same either way.

### Session end

Antigravity has no session-end event, so the first `PreInvocation` of a session
starts a detached shell watchdog:

```sh
while kill -0 "$AGY_PID" 2>/dev/null; do sleep 2; done; <overlay --quit>
```

A shell loop rather than another runtime, because it outlives the whole session.
It re-checks the session state before quitting, so a watchdog that fires late
never tears down an overlay a newer session has taken over. The `agy` process is
found by walking up from the hook's parent (hooks run through `sh -c`, so the
harness is a grandparent). On Windows, and when that walk cannot identify the
harness, the watchdog is skipped: the overlay then survives until its own
Shutdown button or the next session's reset.

### Update nudges

Claude injects the nudge through `UserPromptSubmit` stdout `additionalContext`.
Antigravity's equivalent is `PreInvocation`'s `injectSteps`:

```json
{ "injectSteps": [{ "ephemeralMessage": "An update is available (0.3.0). Run: …" }] }
```

It is emitted only on turn boundaries — never on every model call — and the
background `--check --harness antigravity` runs once per session. Both use the
same `~/.gamepigeon/update-available.json` flag as every other harness; the
installed version is compared against `package.json` at the installed checkout,
because Antigravity has no marketplace install record.

The overlay's own **Update** button works here too. `scripts/overlay.ts` writes
`~/.gamepigeon/install-context.json` on every launch; with
`GAMEPIGEON_HARNESS=antigravity` set by the launcher command, the recorded
`updateCommand` is `bun x @tui-games/tui@latest install --antigravity`, so the
button reinstalls the adapter instead of reaching for Claude's marketplace
record (which does not exist here — issue #176).

## Verifying an install

```bash
# 1. The plugin is materialized and declares only supported events.
cat .agents/plugins/tui-gamepigeon/hooks.json

# 2. Antigravity registers every handler (run after starting a session).
grep "hooks.json" ~/.gemini/antigravity-cli/log/*.log | tail -3
#    …/.agents/plugins/tui-gamepigeon/hooks.json: 1 named hooks, 3 total handlers

# 3. The hook answers with JSON and nothing else.
echo '{"conversationId":"probe"}' | node scripts/run-with-bun.cjs scripts/antigravity-hook.ts --pre-invocation
#    {}
```

Then, in `agy`: submit a prompt (overlay opens), let the response finish
(overlay pauses), submit again (overlay resumes), and quit the session (overlay
disappears within a couple of seconds).

## Upgrading an existing install

`hooks.json` is generated, not merged. If Antigravity picked the plugin up
through `agy plugin` importing a Claude Code install, that copy lives at
`~/.gemini/config/plugins/tui-gamepigeon/` and keeps whatever `hooks.json` it was
imported with — including the old, silently-ignored event names. Re-run the
installer from the project directory (or re-import) to pick up the current one,
and restart `agy`.
