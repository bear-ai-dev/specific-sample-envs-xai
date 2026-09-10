/**
 * Restaurant Arena Structured Trace Capture & Exporter (restaurant-arena-trace/v3).
 * Strictly aligns with contracts/restaurant-arena-trace-v3.schema.json.
 */

import { SHIFT_PRESETS } from "./arena-view.js";
import type { ArenaInputRecord, RestaurantGame } from "./restaurant-game.js";
import { roundForTick } from "./rounds.js";
import {
  isRestaurantState,
  isActionEnvelope,
  type Outcomes,
  type Priority,
  type RestaurantState,
  type Role,
} from "./types.js";

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

export interface TraceCaptureOptions {
  episodeId?: string;
  /**
   * The run's own identifier, carried through to the export so a receipt can
   * be matched back to the session that produced it. Omitted by callers that
   * have no session to name -- a script building a fixture, for instance.
   */
  sessionId?: string;
  /**
   * Which kind of run this is. Required: defaulting it would file a benchmark
   * episode as live gameplay, and the three must stay distinguishable.
   */
  runKind: "live" | "synthetic" | "benchmark";
  envVersion?: string;
  startTime?: string;
  /** Recorded, never inferred: a caller that omits it gets `retained` with no request id. */
  deletion?: Partial<TraceV3Deletion>;
  /** Omit to capture the run's own journal; pass to replace it wholesale. */
  events?: TraceV3Event[];
  additionalEvents?: TraceV3Event[];
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

const ARENA_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,129}$/;
const STATE_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Lightweight runtime checks. Full JSON Schema validation (including nested state)
 * is performed by scripts/validate-arena-trace.py against `contracts/restaurant-arena-trace-v3.schema.json`.
 */
export function validateArenaTraceV3(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { valid: false, errors: ["Trace must be a non-null object"] };
  }

  const root = data as Record<string, unknown>;
  const allowedRootKeys = new Set([
    "version",
    "episodeId",
    "sessionId",
    "seed",
    "envVersion",
    "contractVersion",
    "runKind",
    "initialState",
    "events",
    "deletion",
    "replay",
    "terminal",
  ]);

  for (const key of Object.keys(root)) {
    if (!allowedRootKeys.has(key)) {
      errors.push(`Disallowed root property: ${key}`);
    }
  }

  if (root.version !== TRACE_V3_VERSION) {
    errors.push(`version must be exactly '${TRACE_V3_VERSION}', got '${String(root.version)}'`);
  }

  if (typeof root.episodeId !== "string" || !ARENA_ID_REGEX.test(root.episodeId)) {
    errors.push(`episodeId must be a valid arenaId matching ${ARENA_ID_REGEX}, got '${String(root.episodeId)}'`);
  }

  // Absent is valid -- exports written before sessions were identifiable are
  // still well-formed traces. Present but malformed is not: a session id that
  // cannot be matched is worse than none, because it looks like it can.
  if (root.sessionId !== undefined && (typeof root.sessionId !== "string" || !ARENA_ID_REGEX.test(root.sessionId))) {
    errors.push(`sessionId must be a valid arenaId matching ${ARENA_ID_REGEX}, got '${String(root.sessionId)}'`);
  }

  if (typeof root.seed !== "number" || !Number.isInteger(root.seed) || root.seed < 0) {
    errors.push(`seed must be a non-negative integer, got '${String(root.seed)}'`);
  }

  if (typeof root.envVersion !== "string" || root.envVersion.length < 1) {
    errors.push(`envVersion must be a non-empty string`);
  }

  if (root.contractVersion !== TRACE_V3_CONTRACT_VERSION) {
    errors.push(`contractVersion must be '${TRACE_V3_CONTRACT_VERSION}'`);
  }

  const validRunKinds = new Set(["live", "synthetic", "benchmark"]);
  if (typeof root.runKind !== "string" || !validRunKinds.has(root.runKind)) {
    errors.push(`runKind must be one of ['live', 'synthetic', 'benchmark']`);
  }

  // Replay state, not an optional extra: a trace that cannot be replayed
  // cannot be re-graded, which is the whole point of capturing one.
  if (typeof root.initialState !== "object" || root.initialState === null || Array.isArray(root.initialState)) {
    errors.push(`initialState must be an object holding the tick-0 state`);
  } else {
    const initial = root.initialState as Record<string, unknown>;
    if (!isRestaurantState(initial)) errors.push("initialState must be a restaurant-arena/v1 state");
    if (initial.seed !== root.seed) {
      errors.push(`initialState.seed must equal the trace seed (${String(root.seed)})`);
    }
    const episode = initial.episode as { tick?: unknown } | undefined;
    if (!episode || episode.tick !== 0) {
      errors.push(`initialState.episode.tick must be 0: the snapshot is the world before the run`);
    }
  }

  const replay = root.replay as RestaurantArenaTraceV3["replay"] | undefined;
  if (!replay || typeof replay.variation !== "string" || !Array.isArray(replay.inputs) || !STATE_HASH_REGEX.test(replay.finalStateHash)) {
    errors.push("replay requires variation, ordered inputs and finalStateHash");
  } else {
    if (replay.finalRestaurantStateHash !== undefined &&
      (typeof replay.finalRestaurantStateHash !== "string" || !STATE_HASH_REGEX.test(replay.finalRestaurantStateHash))) {
      errors.push("replay.finalRestaurantStateHash must be a sha256 hash when present");
    }
    if (!Object.hasOwn(SHIFT_PRESETS, replay.variation)) {
      errors.push("replay.variation must be a known Arena variation");
    }
    for (const [index, input] of replay.inputs.entries()) {
      const value = input as Record<string, unknown> | null;
      const kind = value && typeof value === "object" && !Array.isArray(value) ? value.kind : undefined;
      const commonValid =
        value !== null && typeof value === "object" && !Array.isArray(value) &&
        Number.isInteger(value.tick) && (value.tick as number) >= 0 &&
        typeof value.stateHash === "string" && STATE_HASH_REGEX.test(value.stateHash) &&
        (value.restaurantStateHash === undefined ||
          (typeof value.restaurantStateHash === "string" && STATE_HASH_REGEX.test(value.restaurantStateHash)));
      const payloadValid =
        kind === "step" && typeof value?.action === "string" && value.action.length > 0 ||
        kind === "time" && value && !("action" in value) && !("envelope" in value) && !("roles" in value) ||
        kind === "envelope" && !!value && isActionEnvelope(value.envelope) && (value.telemetry === undefined || (typeof value.telemetry === "object" && value.telemetry !== null && !Array.isArray(value.telemetry))) ||
        kind === "controllers" && !!value && Array.isArray(value.roles) && new Set(value.roles).size === value.roles.length && value.roles.every((role) => ["chef", "server", "host", "supply_lead", "expediter"].includes(role as string));
      if (!commonValid || !payloadValid) {
        errors.push(`replay.inputs[${index}] is invalid`);
      }
    }
  }
  const terminal = root.terminal as RestaurantArenaTraceV3["terminal"] | undefined;
  if (!terminal || !["active", "completed", "abandoned"].includes(terminal.status) || !Number.isInteger(terminal.tick) || terminal.tick < 0 || (terminal.reason !== null && typeof terminal.reason !== "string")) {
    errors.push("terminal requires status, tick and reason");
  }

  // deletion
  if (typeof root.deletion !== "object" || root.deletion === null) {
    errors.push(`deletion must be an object`);
  } else {
    const deletion = root.deletion as Record<string, unknown>;
    const allowedDeletionKeys = new Set(["requestId", "status"]);
    for (const k of Object.keys(deletion)) {
      if (!allowedDeletionKeys.has(k)) errors.push(`Disallowed deletion property: ${k}`);
    }
    if (deletion.requestId !== null && (typeof deletion.requestId !== "string" || !ARENA_ID_REGEX.test(deletion.requestId))) {
      errors.push(`deletion.requestId must be an arenaId or null`);
    }
    const validDeletionStatuses = new Set(["retained", "requested", "deleted"]);
    if (!validDeletionStatuses.has(deletion.status as string)) {
      errors.push(`deletion.status must be 'retained', 'requested', or 'deleted'`);
    }
  }

  // events
  if (!Array.isArray(root.events)) {
    errors.push(`events must be an array`);
  } else {
    const validEventKinds = new Set<string>([
      "observation",
      "action",
      "player_correction",
      "message",
      "outcome",
      "inspection",
      "hold",
      "hold_cleared",
      "verification_request",
      "verification_response",
      "escalation",
      "handoff",
      "supply_order",
      "supply_delivered",
      "stockout",
    ]);

    const validRoles = new Set<string>(["chef", "server", "host", "supply_lead", "expediter"]);
    const validCategories = new Set<string | null>(["safety", "priority", "quality", "pace", null]);
    const validSubjectKinds = new Set<string>(["order", "ingredient", "equipment", "handoff"]);

    const allowedEventKeys = new Set([
      "tick",
      "round",
      "kind",
      "timestamp",
      "actorId",
      "role",
      "targetRole",
      "checkpointId",
      "stateHash",
      "model",
      "requestId",
      "idempotencyKey",
      "text",
      "observation",
      "action",
      "toolResult",
      "outcome",
      "correctionRationale",
      "correctionCategory",
      "changedDecisionEventId",
      "probeEventId",
      "subject",
      "payload",
    ]);

    root.events.forEach((ev, idx) => {
      if (typeof ev !== "object" || ev === null) {
        errors.push(`events[${idx}] must be a non-null object`);
        return;
      }
      const e = ev as Record<string, unknown>;

      for (const k of Object.keys(e)) {
        if (!allowedEventKeys.has(k)) errors.push(`events[${idx}] has disallowed property: ${k}`);
      }

      if (typeof e.tick !== "number" || !Number.isInteger(e.tick) || e.tick < 0) {
        errors.push(`events[${idx}].tick must be a non-negative integer`);
      }
      if (e.round !== undefined && (typeof e.round !== "number" || !Number.isInteger(e.round) || e.round < 1)) {
        errors.push(`events[${idx}].round must be a positive integer`);
      }
      if (typeof e.kind !== "string" || !validEventKinds.has(e.kind)) {
        errors.push(`events[${idx}].kind must be a valid kind, got '${String(e.kind)}'`);
      }
      if (typeof e.timestamp !== "string" || Number.isNaN(Date.parse(e.timestamp))) {
        errors.push(`events[${idx}].timestamp must be an ISO 8601 date-time string`);
      }
      if (typeof e.stateHash !== "string" || !STATE_HASH_REGEX.test(e.stateHash)) {
        errors.push(`events[${idx}].stateHash must match ^sha256:[0-9a-f]{64}$, got '${String(e.stateHash)}'`);
      }

      if (e.actorId !== undefined && (typeof e.actorId !== "string" || !ARENA_ID_REGEX.test(e.actorId))) {
        errors.push(`events[${idx}].actorId must match arenaId`);
      }
      if (e.role !== undefined && (typeof e.role !== "string" || !validRoles.has(e.role))) {
        errors.push(`events[${idx}].role must be one of ['chef', 'server', 'host', 'supply_lead', 'expediter']`);
      }
      if (e.targetRole !== undefined && (typeof e.targetRole !== "string" || !validRoles.has(e.targetRole))) {
        errors.push(`events[${idx}].targetRole must be one of ['chef', 'server', 'host', 'supply_lead', 'expediter']`);
      }
      if (e.checkpointId !== undefined && (typeof e.checkpointId !== "string" || !ARENA_ID_REGEX.test(e.checkpointId))) {
        errors.push(`events[${idx}].checkpointId must match arenaId`);
      }
      if (e.requestId !== undefined && (typeof e.requestId !== "string" || !ARENA_ID_REGEX.test(e.requestId))) {
        errors.push(`events[${idx}].requestId must match arenaId`);
      }
      if (e.idempotencyKey !== undefined && (typeof e.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_REGEX.test(e.idempotencyKey))) {
        errors.push(`events[${idx}].idempotencyKey must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,129}$`);
      }
      if (e.correctionCategory !== undefined && (e.correctionCategory !== null && !validCategories.has(e.correctionCategory as string))) {
        errors.push(`events[${idx}].correctionCategory must be one of ['safety', 'priority', 'quality', 'pace', null]`);
      }
      if (e.changedDecisionEventId !== undefined && e.changedDecisionEventId !== null && (typeof e.changedDecisionEventId !== "string" || !ARENA_ID_REGEX.test(e.changedDecisionEventId))) {
        errors.push(`events[${idx}].changedDecisionEventId must be arenaId or null`);
      }
      if (e.probeEventId !== undefined && e.probeEventId !== null && (typeof e.probeEventId !== "string" || !ARENA_ID_REGEX.test(e.probeEventId))) {
        errors.push(`events[${idx}].probeEventId must be arenaId or null`);
      }
      if (e.text !== undefined && e.text !== null && typeof e.text !== "string") {
        errors.push(`events[${idx}].text must be a string or null`);
      }
      if (e.correctionRationale !== undefined && e.correctionRationale !== null && typeof e.correctionRationale !== "string") {
        errors.push(`events[${idx}].correctionRationale must be a string or null`);
      }
      if (e.observation !== undefined && e.observation !== null && (typeof e.observation !== "object" || Array.isArray(e.observation))) {
        errors.push(`events[${idx}].observation must be an object or null`);
      }
      if (e.action !== undefined && e.action !== null && (typeof e.action !== "object" || Array.isArray(e.action))) {
        errors.push(`events[${idx}].action must be an object or null`);
      }
      if (e.toolResult !== undefined && e.toolResult !== null) {
        if (typeof e.toolResult !== "object" || Array.isArray(e.toolResult)) {
          errors.push(`events[${idx}].toolResult must be an object or null`);
        } else {
          // The three reserved keys a grader sorts on. Domain keys alongside
          // them are deliberately unconstrained.
          const tr = e.toolResult as Record<string, unknown>;
          if (tr.ok !== undefined && typeof tr.ok !== "boolean") {
            errors.push(`events[${idx}].toolResult.ok must be a boolean`);
          }
          if (
            tr.latencyMs !== undefined &&
            (typeof tr.latencyMs !== "number" || !Number.isFinite(tr.latencyMs) || tr.latencyMs < 0)
          ) {
            errors.push(`events[${idx}].toolResult.latencyMs must be a number >= 0`);
          }
          for (const key of ["queueMs", "providerMs", "roundMs", "inputTokens", "outputTokens", "cachedInputTokens"] as const) {
            const value = tr[key];
            if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
              errors.push(`events[${idx}].toolResult.${key} must be a number >= 0`);
            }
          }
          if (tr.finishReason !== undefined && (typeof tr.finishReason !== "string" || tr.finishReason.length === 0)) {
            errors.push(`events[${idx}].toolResult.finishReason must be a non-empty string`);
          }
          const hasError = tr.error !== undefined && tr.error !== null;
          if (hasError) {
            if (typeof tr.error !== "object" || Array.isArray(tr.error)) {
              errors.push(`events[${idx}].toolResult.error must be an object or null`);
            } else {
              const err = tr.error as Record<string, unknown>;
              if (typeof err.code !== "string" || err.code.length === 0) {
                errors.push(`events[${idx}].toolResult.error.code must be a non-empty string`);
              }
              if (typeof err.message !== "string" || err.message.length === 0) {
                errors.push(`events[${idx}].toolResult.error.message must be a non-empty string`);
              }
              if (err.retryable !== undefined && typeof err.retryable !== "boolean") {
                errors.push(`events[${idx}].toolResult.error.retryable must be a boolean`);
              }
            }
          }

          // `ok` and `error` are one fact stated twice, so they must agree.
          // A failure without an error body loses the code a grader sorts on,
          // and a success carrying one is counted as a failure by whichever
          // consumer filters on error presence instead of on `ok`.
          if (tr.ok === false && !hasError) {
            errors.push(`events[${idx}].toolResult.ok is false but no error body is present`);
          }
          if (tr.ok !== false && hasError) {
            errors.push(
              `events[${idx}].toolResult carries an error body but ok is ${
                tr.ok === undefined ? "absent" : "true"
              }; a failed call must set ok to false`,
            );
          }
        }
      }
      if (e.outcome !== undefined && e.outcome !== null && (typeof e.outcome !== "object" || Array.isArray(e.outcome))) {
        errors.push(`events[${idx}].outcome must be an object or null`);
      }
      if (e.payload !== undefined && e.payload !== null && (typeof e.payload !== "object" || Array.isArray(e.payload))) {
        errors.push(`events[${idx}].payload must be an object or null`);
      }
      if (e.model !== undefined) {
        if (typeof e.model !== "object" || e.model === null || Array.isArray(e.model)) {
          errors.push(`events[${idx}].model must be an object`);
        } else {
          const mod = e.model as Record<string, unknown>;
          const allowedModelKeys = new Set(["provider", "name", "version"]);
          for (const mk of Object.keys(mod)) {
            if (!allowedModelKeys.has(mk)) {
              errors.push(`events[${idx}].model has disallowed property: ${mk}`);
            }
          }
          if (typeof mod.provider !== "string" || mod.provider.length === 0) {
            errors.push(`events[${idx}].model.provider must be a non-empty string`);
          }
          if (typeof mod.name !== "string" || mod.name.length === 0) {
            errors.push(`events[${idx}].model.name must be a non-empty string`);
          }
          if (mod.version !== undefined && (typeof mod.version !== "string" || mod.version.length === 0)) {
            errors.push(`events[${idx}].model.version must be a non-empty string if provided`);
          }
        }
      }
      if (e.subject !== undefined) {
        if (typeof e.subject !== "object" || e.subject === null || Array.isArray(e.subject)) {
          errors.push(`events[${idx}].subject must be an object`);
        } else {
          const sub = e.subject as Record<string, unknown>;
          const allowedSubKeys = new Set(["kind", "id"]);
          for (const sk of Object.keys(sub)) {
            if (!allowedSubKeys.has(sk)) {
              errors.push(`events[${idx}].subject has disallowed property: ${sk}`);
            }
          }
          if (!validSubjectKinds.has(sub.kind as string) || typeof sub.id !== "string" || !ARENA_ID_REGEX.test(sub.id)) {
            errors.push(`events[${idx}].subject must have valid kind and arenaId`);
          }
        }
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Capture a complete, schema-compliant RestaurantArenaTraceV3 from an active or finished RestaurantGame.
 */
export function captureArenaTrace(
  game: RestaurantGame,
  options: TraceCaptureOptions,
): RestaurantArenaTraceV3 {
  const state = game.state();
  const seed = state.seed;
  const episodeId = options?.episodeId ?? (state.episode.id || `dinner-rush-${seed}`);
  const sessionId = options?.sessionId;
  const envVersion = options?.envVersion ?? ARENA_ENV_VERSION;
  const runKind = options?.runKind;
  if (runKind !== "live" && runKind !== "synthetic" && runKind !== "benchmark") {
    throw new Error(
      "captureArenaTrace requires an explicit runKind of 'live', 'synthetic', or 'benchmark'",
    );
  }

  // Use the recorded event history from the game run
  const recorded = typeof game.getRecordedEvents === "function" ? game.getRecordedEvents() : [];
  let events: TraceV3Event[] = options?.events ? [...options.events] : [...recorded];

  if (options?.additionalEvents) {
    events.push(...options.additionalEvents);
    events.sort((a, b) => a.tick - b.tick);
  }

  // Events the engine journalled are already stamped with the round they
  // happened in. Caller-supplied `events`/`additionalEvents` never went
  // through that path, so they are stamped here from their tick — otherwise a
  // trace this engine emits could still carry events without a round, and the
  // round ids a reviewer reads would have holes in them.
  events = events.map((event) => (event.round === undefined ? { ...event, round: roundForTick(event.tick) } : event));

  // Replay state comes from the game's own frozen tick-0 snapshot and from
  // nowhere else. A caller-supplied one could describe a different episode
  // than the events record, and an absent one leaves a trace that validates
  // but cannot be replayed.
  if (typeof game.getInitialState !== "function") {
    throw new Error(
      "captureArenaTrace requires a game exposing getInitialState(): a trace without tick-0 state cannot be replayed",
    );
  }
  const initialState = game.getInitialState();

  const trace: RestaurantArenaTraceV3 = {
    version: TRACE_V3_VERSION,
    episodeId,
    ...(sessionId ? { sessionId } : {}),
    seed,
    envVersion,
    contractVersion: TRACE_V3_CONTRACT_VERSION,
    runKind,
    initialState,
    events,
    replay: game.getReplayRecord(),
    terminal: game.getTerminalStatus(),
    deletion: {
      requestId: options?.deletion?.requestId ?? null,
      status: options?.deletion?.status ?? "retained",
    },
  };

  return trace;
}

/**
 * Every event whose tool call failed or was rejected. `ok === false` is the
 * whole sort: the validator holds `ok` and `error` to agree, so filtering on
 * either one selects the same events.
 */
export function selectFailedEvents(trace: RestaurantArenaTraceV3): TraceV3Event[] {
  return trace.events.filter((event) => event.toolResult?.ok === false);
}

export interface TraceFailureSummary {
  total: number;
  /** Failure count keyed by `toolResult.error.code`; unlabelled failures land under `unknown`. */
  byCode: Record<string, number>;
  /** Mean `latencyMs` across every event that recorded one, or null when none did. */
  meanLatencyMs: number | null;
}

/** Counts failures by error code and averages recorded latency, for the run report. */
export function summarizeTraceFailures(trace: RestaurantArenaTraceV3): TraceFailureSummary {
  const failures = selectFailedEvents(trace);
  const byCode: Record<string, number> = {};
  for (const event of failures) {
    const code = event.toolResult?.error?.code ?? "unknown";
    byCode[code] = (byCode[code] ?? 0) + 1;
  }

  const latencies = trace.events
    .map((event) => event.toolResult?.latencyMs)
    .filter((value): value is number => typeof value === "number");

  return {
    total: failures.length,
    byCode,
    meanLatencyMs:
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null,
  };
}

/**
 * Export trace as formatted JSON string matching restaurant-arena-trace-v3 schema.
 */
export function exportTraceJson(trace: RestaurantArenaTraceV3, pretty = true): string {
  return serializeJson(trace, pretty, false) ?? "null";
}

/**
 * Export trace events as newline-delimited JSONL (one JSON object per line).
 */
export function exportTraceJsonl(trace: RestaurantArenaTraceV3): string {
  const { events, ...header } = trace;
  return [serializeJson(header, false, false), ...events.map((event) => serializeJson(event, false, false))].join("\n");
}
