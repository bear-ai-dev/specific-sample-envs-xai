/**
 * Restaurant Arena event/state hashing primitives and shared trace types.
 */

import type { ArenaInputRecord } from "./restaurant-game.js";
import type { Role } from "./types.js";

export const TRACE_V3_VERSION = "restaurant-arena-trace/v3" as const;
export const TRACE_V3_CONTRACT_VERSION = "restaurant-arena/v1" as const;

/**
 * The arena build a trace was recorded against. Kept in step with the package
 * version by hand: the overlay bundles this module for the browser, where
 * reading package.json at runtime is not available.
 */
export const ARENA_ENV_VERSION = "0.3.4" as const;

export type TraceEventKind =
  | "observation"
  | "action"
  | "player_correction"
  | "message"
  | "outcome"
  | "inspection"
  | "hold"
  | "hold_cleared"
  | "verification_request"
  | "verification_response"
  | "escalation"
  | "handoff"
  | "supply_order"
  | "supply_delivered"
  | "stockout";

export type TraceV3Role = Role | "expediter";

export interface TraceV3Model {
  provider: string;
  name: string;
  version?: string;
}

export interface TraceV3Subject {
  kind: "order" | "ingredient" | "equipment" | "handoff";
  id: string;
}

/**
 * The three keys a grader sorts on. Everything a tool returns beyond them
 * (`status: "verified"`, counts, ids) rides alongside untouched.
 */
export interface TraceV3ToolResult extends Record<string, unknown> {
  /** False on every rejected or failed call. Filter on this to select failures. */
  ok?: boolean;
  /** Model or tool round trip. Absent when no call stood behind the event. */
  latencyMs?: number;
  /** Time spent waiting for a shared account's request budget before the provider call started. */
  queueMs?: number;
  /** The provider call itself, excluding queueMs. Absent when the transport cannot separate the two. */
  providerMs?: number;
  /** Elapsed time since this decision round started, through this worker's own completion. */
  roundMs?: number;
  /** Absent fields below mean the provider did not report that count, not that it was zero. */
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  finishReason?: string;
  error?: { code: string; message: string; retryable?: boolean } | null;
}

export interface TraceV3Deletion {
  requestId: string | null;
  status: "retained" | "requested" | "deleted";
}

export interface TraceV3Event {
  tick: number;
  /**
   * The decision round this event happened in (#262). Round *r* advances
   * ticks 2r-1 and 2r, so a reviewer can line a manager action up against the
   * worker turns it shaped without counting ticks by hand.
   */
  round?: number;
  kind: TraceEventKind;
  timestamp: string;
  stateHash: string;
  actorId?: string;
  role?: TraceV3Role;
  targetRole?: TraceV3Role;
  checkpointId?: string;
  model?: TraceV3Model;
  requestId?: string;
  idempotencyKey?: string;
  text?: string | null;
  observation?: Record<string, unknown> | null;
  action?: Record<string, unknown> | null;
  toolResult?: TraceV3ToolResult | null;
  outcome?: Record<string, unknown> | null;
  correctionRationale?: string | null;
  correctionCategory?: "safety" | "priority" | "quality" | "pace" | null;
  changedDecisionEventId?: string | null;
  probeEventId?: string | null;
  subject?: TraceV3Subject;
  payload?: Record<string, unknown> | null;
}

export interface RestaurantArenaTraceV3 {
  version: typeof TRACE_V3_VERSION;
  episodeId: string;
  /**
   * The one run this trace came from.
   *
   * `episodeId` names the *scenario* -- `dinner-rush-218220` is the same
   * dinner rush every time it is played, and the benchmark fixture leans on
   * that. So it cannot identify a session: two people playing the same seed
   * export the same `episodeId`, which makes two sessions indistinguishable
   * on receipt and a re-export indistinguishable from a new one (#281).
   *
   * Optional so every v3 export written before this field stays valid. A
   * trace without one is a trace whose session cannot be matched, not a
   * malformed trace.
   */
  sessionId?: string;
  seed: number;
  envVersion: string;
  contractVersion: typeof TRACE_V3_CONTRACT_VERSION;
  runKind: "live" | "synthetic" | "benchmark";
  /** The world at tick 0. Required: without it a trace cannot be replayed. */
  initialState: Record<string, unknown>;
  events: TraceV3Event[];
  deletion: TraceV3Deletion;
  replay: {
    variation: string;
    inputs: ArenaInputRecord[];
    finalStateHash: string;
    /** Optional so earlier v3 exports remain valid. */
    finalRestaurantStateHash?: string;
  };
  terminal: { status: "active" | "completed" | "abandoned"; tick: number; reason: string | null };
}

/**
 * Pure, deterministic SHA-256 implementation (FIPS 180-4).
 * Runs synchronously in any JavaScript runtime (Node, Bun, browser) without external dependencies.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = bytes.length;
  const bitLen = len * 8;
  const withPadLen = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(withPadLen);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(withPadLen - 4, bitLen >>> 0, false);
  view.setUint32(withPadLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let i = 0; i < withPadLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const w15 = w[j - 15]!;
      const w2 = w[j - 2]!;
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^
        ((w15 >>> 18) | (w15 << 14)) ^
        (w15 >>> 3);
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^
        ((w2 >>> 19) | (w2 << 13)) ^
        (w2 >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let j = 0; j < 64; j++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[j]! + w[j]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const hex = [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => (v >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `sha256:${hex}`;
}

const FLOAT_FIELDS = new Set([
  "cash", "coordination", "correctionUptake", "load", "reading",
  "reputation", "safetyThreshold", "satisfaction", "waitTime", "waste",
]);

function serializeJson(value: unknown, pretty: boolean, sortKeys: boolean, level = 0, key?: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return FLOAT_FIELDS.has(key ?? "") && Number.isInteger(value) ? `${value}.0` : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeJson(item, pretty, sortKeys, level + 1));
    return pretty && items.length > 0
      ? `[\n${items.map((item) => `${"  ".repeat(level + 1)}${item ?? "null"}`).join(",\n")}\n${"  ".repeat(level)}]`
      : `[${items.map((item) => item ?? "null").join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (sortKeys) keys.sort();
    const entries = keys.flatMap((entryKey) => {
      const serialized = serializeJson(record[entryKey], pretty, sortKeys, level + 1, entryKey);
      return serialized === undefined ? [] : [[entryKey, serialized] as const];
    });
    return pretty && entries.length > 0
      ? `{\n${entries.map(([entryKey, serialized]) => `${"  ".repeat(level + 1)}${JSON.stringify(entryKey)}: ${serialized}`).join(",\n")}\n${"  ".repeat(level)}}`
      : `{${entries.map(([entryKey, serialized]) => `${JSON.stringify(entryKey)}:${serialized}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

/** Backend-compatible JSON: sorted keys and decimal spelling for float fields. */
export function canonicalJson(value: unknown): string {
  return serializeJson(value, false, true) ?? "null";
}

export function computeStateHash(data: unknown): string {
  const json = typeof data === "string" ? data : canonicalJson(data);
  return sha256Bytes(new TextEncoder().encode(json));
}

