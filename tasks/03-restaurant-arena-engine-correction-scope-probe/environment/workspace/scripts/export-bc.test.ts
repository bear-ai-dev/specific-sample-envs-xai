import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function chunk(gameId: string): unknown {
  return {
    schema_version: 2,
    user_id: "usr_test",
    game_id: gameId,
    game_type: "2048",
    game_version: "1",
    chunk_id: `chk_${gameId}`,
    chunk_sequence: 1,
    first_event_sequence: 1,
    last_event_sequence: 3,
    event_count: 3,
    created_at_ms: 10,
    client: { platform: "tui", application_version: "test", recording_sdk_version: "2" },
    events: [
      {
        schema_version: 2,
        user_id: "usr_test",
        game_id: gameId,
        chunk_id: `chk_${gameId}`,
        event_id: `evt_${gameId}_1`,
        event_sequence: 1,
        event_version: 1,
        event_type: "observation",
        visibility: "policy",
        client_time_ms: 1,
        monotonic_time_us: 1_000,
        payload: {
          observation_id: `obs_${gameId}`,
          representation: "engine_state_v1",
          state: { board: [2, 0] },
        },
      },
      {
        schema_version: 2,
        user_id: "usr_test",
        game_id: gameId,
        chunk_id: `chk_${gameId}`,
        event_id: `evt_${gameId}_2`,
        event_sequence: 2,
        event_version: 1,
        event_type: "control_changed",
        visibility: "policy",
        client_time_ms: 2,
        monotonic_time_us: 2_000,
        payload: {
          based_on_observation_id: `obs_${gameId}`,
          control: "left",
          action: "left",
          kind: "impulse",
          actor: "human",
        },
      },
      {
        schema_version: 2,
        user_id: "usr_test",
        game_id: gameId,
        chunk_id: `chk_${gameId}`,
        event_id: `evt_${gameId}_3`,
        event_sequence: 3,
        event_version: 1,
        event_type: "outcome_changed",
        visibility: "policy",
        client_time_ms: 3,
        monotonic_time_us: 3_000,
        payload: {
          score_before: 0,
          score_after: 4,
          score_delta: 4,
          engine_reward: 4,
          reward_spec_id: "engine_v1",
          terminal: false,
          caused_by_event_id: `evt_${gameId}_2`,
          progress: { moved: true, success: false },
        },
      },
    ],
  };
}

/** A throwaway HOME holding one chunk in each queue directory the exporter can reach. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "gamepigeon-export-home-"));
  const recordings = join(home, ".tui-gamepigeon", "recordings");
  for (const [directory, gameId] of [
    [join(recordings, "completed", "chunks"), "game_terminal"],
    [join(recordings, "overlay-completed"), "game_synced"],
    [join(recordings, "overlay-pending"), "game_unsynced"],
  ] as const) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${gameId}.json`), JSON.stringify(chunk(gameId)));
  }
  return home;
}

function gameIds(output: string): string[] {
  return ["train", "validation", "test"]
    .flatMap((split) => readFileSync(join(output, `${split}.jsonl`), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { game_id: string }).game_id)
    .sort();
}

describe("export-bc defaults", () => {
  test("scans the unsynced overlay-pending backlog, not just completed chunks", () => {
    const home = fakeHome();
    const output = join(home, "dataset");
    try {
      const result = spawnSync(process.execPath, [join(ROOT, "scripts/export-bc.ts"), "--output", output], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("from 3 chunks");
      expect(gameIds(output)).toEqual(["game_synced", "game_terminal", "game_unsynced"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("gamepigeon export", () => {
  test("resolves relative output paths against the caller's working directory", () => {
    const home = fakeHome();
    const workspace = mkdtempSync(join(tmpdir(), "gamepigeon-export-cwd-"));
    try {
      const result = spawnSync(process.execPath, [join(ROOT, "src/index.ts"), "export", "--output", "./dataset"], {
        encoding: "utf8",
        cwd: workspace,
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(workspace, "dataset", "manifest.json"))).toBe(true);
      // Never into the install directory, which is read-only for a global npm install.
      expect(existsSync(join(ROOT, "dataset"))).toBe(false);
      expect(gameIds(join(workspace, "dataset"))).toContain("game_unsynced");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("documents the export subcommand in the usage banner", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "src/index.ts"), "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gamepigeon export");
  });
});
