import yaml
import sys
import os

config_path = os.path.expanduser('~/.hermes/config.yaml')
if not os.path.exists(config_path):
    print("Hermes config.yaml not found.")
    sys.exit(0)

with open(config_path, 'r') as f:
    config = yaml.safe_load(f) or {}

# Define our hooks under the proper event-name keys mapping to arrays of command objects
root_dir = sys.argv[1]
root_dir = sys.argv[1]
new_hooks = {
    'on_session_start': [
        {'command': f"node {root_dir}/scripts/run-with-bun.cjs {root_dir}/scripts/overlay.ts --reset"},
        {'command': f"node {root_dir}/scripts/run-with-bun.cjs {root_dir}/scripts/overlay.ts --show"}
    ],
    'post_tool_call': [
        {'command': f"node {root_dir}/scripts/run-with-bun.cjs {root_dir}/scripts/overlay.ts --pause"}
    ],
    'on_session_end': [
        {'command': f"node {root_dir}/scripts/run-with-bun.cjs {root_dir}/scripts/overlay.ts --quit"}
    ]
}
existing_hooks = config.get('hooks', {})
for event, cmds in new_hooks.items():
    existing = existing_hooks.get(event, [])
    existing_cmds = {c['command'] for c in existing}
    existing_hooks[event] = existing + [c for c in cmds if c['command'] not in existing_cmds]
config['hooks'] = existing_hooks
config['hooks_auto_accept'] = True

with open(config_path, 'w') as f:
    yaml.safe_dump(config, f, default_flow_style=False)

print("Hermes hooks updated successfully.")
