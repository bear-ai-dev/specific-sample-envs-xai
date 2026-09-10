# Play Tui — setup

This is the whole setup. It takes about five minutes, most of it waiting for a
download. You do not need to clone anything, install Rust, or run a server.

If a step does not do what this page says it does, stop and say so — that is the
thing being tested, not you.

## Before you start

You need:

- **macOS on Apple silicon** (M1 or later), **Windows 10 or later**, **Ubuntu
  22.04+**, or a **current Fedora**.
- [Node.js](https://nodejs.org) 18 or later, so that `npx` exists. Check with
  `node --version`.
- An internet connection for the first launch.

**Intel Macs are not supported yet.** There is no packaged overlay build for
them, and the install will fail on the download step with a message about a
missing release asset. If `uname -m` prints `x86_64` on your Mac, stop here.

You do **not** need Bun. The command below fetches it.

## 1. Install

Pick the line for the coding tool you already use and run it in a terminal.

Claude Code:

```bash
npx -y bun x @tui-games/tui@latest install --claude
```

Codex:

```bash
npx -y bun x @tui-games/tui@latest install --codex
```

Other supported tools: swap the flag for `--opencode`, `--hermes`, `--openclaw`,
or `--antigravity`. For `--antigravity`, run the command from inside the project
folder you want it in.

**Restart your coding tool when the command finishes.** It will not pick up the
new command until you do.

## 2. Sign in

Tui needs an account. Launch it:

```bash
gamepigeon
```

The first launch opens a browser page where you can create an account or sign in
with email, Google, or GitHub. Once that is done, the browser tab can be closed;
later launches reuse the saved session and will not ask again.

If the browser does not open on its own, the overlay shows a **Copy link**
button — paste that link into a browser yourself.

## 3. Play a shift

```bash
gamepigeon restaurant-arena
```

A small window opens on top of whatever you are doing. Inside it:

- **Arrow keys** or **WASD** to move, **Enter** to select.
- **Esc** or **q** hides the window. Running `gamepigeon` again brings it back
  with your game still in progress.
- Drag the top bar to move the window; the **↗** control resizes it.

Play until the shift ends and you reach the debrief screen. That is the finish
line.

## What the status line under the floor means

The line under the restaurant floor says who is running your crew:

| It says | What is happening |
| --- | --- |
| **Deterministic crew · live model unavailable** | The crew is running on fixed rules. This is normal and expected for this pilot. |
| **Waiting for the shared model account — Ns** | A live crew is queued behind a shared, rate-limited account. It is waiting its turn, not broken. It will continue on its own. |
| **Shared model account is rate limited — retrying in Ns** | The account said to slow down. Same thing: wait, do not restart. |
| **Fallback · …** | A live crew turn actually failed and fixed rules took over for it. |

**You will almost certainly see "Deterministic crew".** The live-crew mode runs
on a shared model account whose key is not distributed, so it stays on the
team's own machines. Everything else about the shift is the same.

## If something goes wrong

- **`command not found: gamepigeon`** — the coding tool was not restarted, or
  the install picked a different tool than the one you use. Re-run step 1 with
  the right flag.
- **`Tui overlay binary was not found`** or a download error — your platform has
  no packaged build (see the Intel Mac note above), or the download was blocked.
- **The account chip says "Sync paused"** — your play is still being recorded
  locally. Keep going and mention it afterwards.
- **Anything else** — take a screenshot of the window and send it. A confusing
  screen is a finding, not a mistake.

## When you finish

Tell whoever gave you this page:

1. Roughly how long setup took, and where you had to stop and think.
2. Whether you reached the debrief screen.
3. Anything on screen you could not make sense of.
