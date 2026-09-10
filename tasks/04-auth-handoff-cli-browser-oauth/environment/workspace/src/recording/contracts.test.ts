import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GameEventChunk, TraceEventChunk } from "./types.js";

function contract(path: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "../../contracts", path), "utf8"));
}

describe("recording wire contracts", () => {
  it("ships parseable version-one request and acknowledgment schemas", () => {
    const request = contract("game-event-chunk-v1.schema.json") as {
      properties: { schema_version: { const: number } };
      required: string[];
    };
    const response = contract("ingest-response-v1.schema.json") as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { const?: unknown }>;
    };
    expect(request.properties.schema_version.const).toBe(1);
    expect(request.required).toContain("events");
    expect(response.required).toContain("accepted_event_range");
    expect(response.required).toEqual([
      "accepted",
      "duplicate",
      "game_id",
      "chunk_id",
      "chunk_sequence",
      "accepted_event_range",
      "queued",
      "server_received_at_ms",
    ]);
    expect(response.properties.queued!.const).toBe(true);
    expect(response.additionalProperties).toBe(false);
    expect(Object.keys(response.properties)).not.toContain("broker_partition");
    expect(Object.keys(response.properties)).not.toContain("broker_offset");
  });

  it("ships a consistent valid request fixture", () => {
    const fixture = contract("fixtures/valid/game-event-chunk-v1.json") as GameEventChunk;
    expect(fixture.schema_version).toBe(1);
    expect(fixture.event_count).toBe(fixture.events.length);
    expect(fixture.first_event_sequence).toBe(fixture.events[0]!.event_sequence);
    expect(fixture.last_event_sequence).toBe(fixture.events.at(-1)!.event_sequence);
    expect(fixture.events.map((event) => event.event_sequence)).toEqual([1, 2, 3]);
  });

  it("ships a schema-two trace fixture with universal event identities", () => {
    const schema = contract("interaction-trace-chunk-v2.schema.json") as {
      properties: { schema_version: { const: number } };
      required: string[];
      $defs: { event: { required: string[] } };
    };
    const fixture = contract("fixtures/valid/interaction-trace-chunk-v2.json") as TraceEventChunk;
    expect(schema.properties.schema_version.const).toBe(2);
    expect(schema.required).toEqual(expect.arrayContaining(["user_id", "game_id", "chunk_id"]));
    expect(schema.$defs.event.required).toEqual(
      expect.arrayContaining(["event_id", "user_id", "game_id", "chunk_id"]),
    );
    expect(fixture.schema_version).toBe(2);
    expect(fixture.client.recording_sdk_version).toBe("2");
    expect(fixture.event_count).toBe(fixture.events.length);
    expect(fixture.events.every((event) =>
      event.user_id === fixture.user_id &&
      event.game_id === fixture.game_id &&
      event.chunk_id === fixture.chunk_id &&
      event.event_id.startsWith("evt_")
    )).toBe(true);
  });
});
