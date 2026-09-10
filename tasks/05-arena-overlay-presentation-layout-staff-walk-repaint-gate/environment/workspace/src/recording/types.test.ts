import { describe, expect, it } from "vitest";
import { createChunkId, createEventId, createGameId, createUserId } from "./ids.js";
import { RECORDING_SCHEMA_VERSION, RECORDING_SDK_VERSION } from "./types.js";

describe("recording contracts", () => {
  it("uses schema version two", () => {
    expect(RECORDING_SCHEMA_VERSION).toBe(2);
    expect(RECORDING_SDK_VERSION).toBe("2");
  });

  it("creates prefixed stable identifiers", () => {
    const uuid = () => "00000000-0000-4000-8000-000000000001";
    expect(createUserId(uuid)).toBe("usr_00000000-0000-4000-8000-000000000001");
    expect(createGameId(uuid)).toBe("game_00000000-0000-4000-8000-000000000001");
    expect(createEventId(uuid)).toBe("evt_00000000-0000-4000-8000-000000000001");
    expect(createChunkId(uuid)).toBe("chk_00000000-0000-4000-8000-000000000001");
  });
});
