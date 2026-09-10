# Game-Based Coding RL Tasks

These tasks are based on a real enterprise gaming repository. Each one asks an
agent to build, fix or extend a production game system.

## Results

| Model | Harness | Tasks | Passes / trials | Pass rate |
| --- | --- | ---: | ---: | ---: |
| Opus 5 | Claude Code | 5 | 31/40 | 77.5% |
| Grok 4.6 | Grok Build | 5 | 15/40 | 37.5% |

See the [task-by-task results](sample-run/indexes/pass-rate-matrix.md) and the
[complete trial index](sample-run/indexes/trials.json).

## Efficiency

| Model | Harness | Trials | Avg. time (seconds) | Avg. output tokens | Avg. steps |
| --- | --- | ---: | ---: | ---: | ---: |
| Opus 5 | Claude Code | 40 | 1,455.5 | 87,263.4 | 118.7 |
| Grok 4.6 | Grok Build | 40 | 1,053.3 | 56,733.2 | 45.5 |

## Tasks

1. **Overlay shell lifecycle** - Restore game launch, pause, resume, restart,
   window controls, sign-out, and saved progress.
2. **Arena trace replay** - Capture, validate, export, and replay complete
   Restaurant Arena sessions without losing state or outcomes.
3. **Correction scope probe** - Make manager corrections persist, constrain the
   right worker actions, and receive credit when followed.
4. **Auth handoff** - Add safe Google and GitHub browser sign-in to the CLI and
   return the authenticated session to the game.
5. **Arena overlay presentation** - Responsive floor layouts,
   hallway-aware staff movement, and drag-safe repaint behavior.

## Scoring

A rollout passes only when every graded requirement passes. Each task has eight
completed Opus 5 rollouts and eight completed Grok 4.6 rollouts.

## Repository layout

```text
tasks/<task>/
trajectories/<task>/<model-harness>/
sample-run/results/<model-harness>/<task>/
sample-run/indexes/
sample-run/manifests/cohort.json
```

Each task includes its environment, instruction, tests, reference solution, and
rollout evidence.

Visual task pages show the frozen baseline beside the reference solution. Each
task page also includes a passing Grok rollout and representative failed
rollouts from both models.

## Run a task

```bash
specific build tasks/<task>
specific oracle tasks/<task>
```
