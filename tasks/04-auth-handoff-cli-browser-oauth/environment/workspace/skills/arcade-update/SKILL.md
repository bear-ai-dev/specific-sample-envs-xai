---
name: arcade-update
description: Update the tui-gamepigeon Tui plugin to the latest version from the marketplace.
allowed-tools: Bash(claude *, bun *, rm *)
---

# Update Tui Plugin

Update the tui-gamepigeon Claude Code plugin to the latest marketplace release.

Run these steps in sequence. After each bash command, check the exit code before proceeding.

## Step 1: Update marketplace

Try the update first:

```bash
claude plugin marketplace update tui-gamepigeon
```

If this fails (e.g. git/SSH auth error), fall back to adding via HTTPS, then removing the old entry:

```bash
claude plugin marketplace add https://github.com/Trolleroof/tui-gamepigeon.git
```

If the add succeeded, remove the old marketplace entry:

```bash
claude plugin marketplace remove tui-gamepigeon
```

If the add failed, do NOT run remove — the old marketplace entry is still needed. Tell the user: "Marketplace update failed. Check your network connection and try again."

## Step 2: Update plugin to latest version

```bash
claude plugin update tui-gamepigeon@tui-gamepigeon
```

`update` force-upgrades an already-installed plugin. `install` is a no-op when an entry already exists in `installed_plugins.json`, so it will not upgrade.

If `update` fails, fall back to:

```bash
claude plugin install tui-gamepigeon@tui-gamepigeon --scope user
```

If both fail, tell the user: "Plugin update failed. Please report this issue at https://github.com/Trolleroof/tui-gamepigeon/issues"

## Step 3: Clear update flag and confirm

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-update.ts" --clear
```

If `CLAUDE_PLUGIN_ROOT` is unset, fall back to:

```bash
rm -f "${GAMEPIGEON_HOME:-$HOME/.gamepigeon}/update-available.json"
```

After all steps succeed, tell the user:

- Tui plugin updated successfully
- Run `/reload-plugins` to apply the update, or restart Claude Code
- The overlay binary will refresh itself on the next session if a newer build is available
