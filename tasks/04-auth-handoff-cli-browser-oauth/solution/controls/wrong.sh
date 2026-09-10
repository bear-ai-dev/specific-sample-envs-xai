#!/usr/bin/env bash
# Control: starts from the correct solution (solve.sh has already run in this
# container) and then introduces a deliberate regression, skipping the
# localhost-only redirect-target check on the /cli/handoff route so it would
# attach a session token to an attacker-supplied off-box URL. This must score
# 0 (specifically it must fail "refuses to hand a session to a non-localhost
# target" and the redirect-script-breakout check).
set -euo pipefail

repo_root="${1:-$(pwd)}"
file="$repo_root/cloudflare/auth-worker/src/index.ts"

python3 - "$file" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()

needle = (
    "      const next = url.searchParams.get(\"next\") ?? \"http://127.0.0.1:3210/auth/callback\";\n"
    "      const nextUrl = localhostCallback(next);\n"
    "      if (!nextUrl) {\n"
    "        return invalidTargetPage();\n"
    "      }\n"
    "\n"
    "      const auth = createAuth(env);\n"
)
replacement = (
    "      const next = url.searchParams.get(\"next\") ?? \"http://127.0.0.1:3210/auth/callback\";\n"
    "      const nextUrl = new URL(next);\n"
    "\n"
    "      const auth = createAuth(env);\n"
)
if needle not in src:
    raise SystemExit("expected /cli/handoff validation block not found; wrong.sh control is stale")
src = src.replace(needle, replacement, 1)
with open(path, "w") as f:
    f.write(src)
PYEOF

echo "Applied a deliberate localhost-check regression to $file"

