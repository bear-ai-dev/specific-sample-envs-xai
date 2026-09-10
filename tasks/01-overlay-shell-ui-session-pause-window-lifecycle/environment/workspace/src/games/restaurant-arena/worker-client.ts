import { ACTION_VERSION, type ActionEnvelope, type Observation, type Role, type Tool } from "./types.js";
import { ROLE_PERMISSIONS } from "./projections.js";

export type ActionParseErrorCode = "invalid_json" | "invalid_tool" | "invalid_arguments";

export class ActionParseError extends Error {
  constructor(readonly code: ActionParseErrorCode, message: string) {
    super(message);
    this.name = "ActionParseError";
  }
}

export interface ActionContext {
  episodeId: string;
  actorId: string;
  role: Role;
  observation: Observation;
}

export interface ModelRequest {
  systemPrompt: string;
  turnPrompt: string;
  observation: Observation;
}

/**
 * What a transport can tell us about one provider call beyond the completion
 * text. Every field is best-effort: a transport that cannot separate queue
 * time from provider time, or whose provider omits usage, leaves the
 * corresponding field absent rather than guessing at it.
 */
export interface ModelCallMetrics {
  /** Time spent waiting for a shared account's request budget before the provider call started. */
  queueMs?: number;
  /** The provider call itself, excluding queueMs. */
  providerMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  finishReason?: string;
}

export interface ModelCompletionResult {
  text: string;
  metrics?: ModelCallMetrics;
}

/** A transport with nothing to report beyond the completion may return a bare string. */
export type ModelCompletion = (request: ModelRequest, signal: AbortSignal) => Promise<string | ModelCompletionResult>;

export class ModelRequestError extends Error {
  constructor(readonly code: "timeout" | "request_failed", message: string) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export interface WorkerModelClientOptions {
  complete: ModelCompletion;
  /**
   * Wall clock allowed for one attempt, or `null` to let the transport bound
   * it instead.
   *
   * A timer started here covers everything `complete` does, and against a
   * rate-limited account that includes time spent queued for the account's
   * request budget before any request is made. A shift throttled to a 60s
   * queue would abort every worker at 6s and record a round of errors, which
   * reads as a broken crew rather than a waiting one. The Tauri transport
   * already bounds the provider call itself, and its timer starts after
   * admission, so `null` is the accurate choice there -- waiting in line does
   * not count against the worker's patience.
   */
  timeoutMs?: number | null;
  retries?: number;
  now?: () => Date;
  requestId?: () => string;
}

const REQUIRED_ARGS: Record<Tool, readonly string[]> = {
  inspect: ["targetId"],
  prepare: ["orderId"],
  serve: ["tableId", "orderId"],
  seat: ["tableId", "partyId"],
  update_guest: ["message"],
  coordinate: ["workerId", "orderId", "priority"],
  request_help: ["reason"],
  send_message: ["to", "text"],
  // Player-only — no role's ROLE_PERMISSIONS grants these, so a worker
  // completion can never pass validateAction's role check for them even if
  // a model hallucinated one. Listed here only so this map stays exhaustive.
  approve: ["decisionId", "optionId"],
  correct: ["note"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionFrom(value: unknown): { tool: unknown; arguments: unknown } | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.action) ? { tool: value.action.tool, arguments: value.action.arguments } : { tool: value.tool, arguments: value.arguments };
}

function validateAction(role: Role, value: unknown): { tool: Tool; arguments: Record<string, unknown> } {
  const action = actionFrom(value);
  if (!action || typeof action.tool !== "string" || !Object.hasOwn(REQUIRED_ARGS, action.tool)) {
    throw new ActionParseError("invalid_tool", "completion does not contain a supported tool action");
  }
  const tool = action.tool as Tool;
  if (!ROLE_PERMISSIONS[role].includes(tool)) {
    throw new ActionParseError("invalid_tool", `${role} may not use ${tool}`);
  }
  if (!isRecord(action.arguments)) {
    throw new ActionParseError("invalid_arguments", `${tool} requires an arguments object`);
  }
  for (const key of REQUIRED_ARGS[tool]) {
    if (typeof action.arguments[key] !== "string" || !(action.arguments[key] as string).trim()) {
      throw new ActionParseError("invalid_arguments", `${tool} requires non-empty string '${key}'`);
    }
  }
  if ("priority" in action.arguments && action.arguments.priority !== "normal" && action.arguments.priority !== "high") {
    throw new ActionParseError("invalid_arguments", "priority must be 'normal' or 'high'");
  }
  return { tool, arguments: action.arguments };
}

/** JSON objects in completion order, including prose-wrapped and fenced JSON. */
function jsonObjects(completion: string): unknown[] {
  const values: unknown[] = [];
  for (let start = completion.indexOf("{"); start !== -1; start = completion.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < completion.length; end += 1) {
      const char = completion[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { values.push(JSON.parse(completion.slice(start, end + 1))); } catch { /* try the next object */ }
        break;
      }
    }
  }
  return values;
}

export function parseModelAction(completion: string, context: ActionContext, options: Pick<WorkerModelClientOptions, "now" | "requestId"> = {}): ActionEnvelope {
  let lastError: ActionParseError | undefined;
  for (const value of jsonObjects(completion)) {
    try {
      const action = validateAction(context.role, value);
      const requestId = options.requestId?.() ?? crypto.randomUUID();
      return {
        version: ACTION_VERSION,
        episodeId: context.episodeId,
        actorId: context.actorId,
        actorType: "worker",
        role: context.role,
        tool: action.tool,
        arguments: action.arguments,
        tick: context.observation.tick,
        timestamp: (options.now?.() ?? new Date()).toISOString(),
        requestId,
        idempotencyKey: `${context.episodeId}:${requestId}`,
      };
    } catch (error) {
      if (error instanceof ActionParseError) lastError = error;
    }
  }
  throw lastError ?? new ActionParseError("invalid_json", "completion contains no JSON object");
}

export class WorkerModelClient {
  private readonly timeoutMs: number | null;
  private readonly retries: number;
  private readonly controllers = new Set<AbortController>();
  private metrics?: ModelCallMetrics;

  constructor(private readonly options: WorkerModelClientOptions) {
    this.timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
    this.retries = options.retries ?? 1;
  }

  /** Cancel outstanding provider work when its shift is paused or replaced. */
  abort(): void {
    for (const controller of this.controllers) controller.abort();
  }

  /**
   * Metrics from the most recently completed act() call, when the transport
   * reported any. Undefined when the provider never responded, or reported
   * nothing beyond the completion text.
   */
  lastMetrics(): ModelCallMetrics | undefined {
    return this.metrics;
  }

  async act(context: ActionContext, systemPrompt: string, turnPrompt: string): Promise<ActionEnvelope> {
    let lastError: unknown;
    this.metrics = undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      this.controllers.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = this.timeoutMs;
      // Left unraced when the transport owns the bound. Abort still works
      // either way: cancelling a shift aborts the controller, which is what
      // stops a request that is merely queued.
      const timeout =
        budget === null
          ? undefined
          : new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new ModelRequestError("timeout", `model request timed out after ${budget}ms`));
              }, budget);
            });
      try {
        const attempt = this.options.complete(
          { systemPrompt, turnPrompt, observation: context.observation },
          controller.signal,
        );
        const raw = await (timeout === undefined ? attempt : Promise.race([attempt, timeout]));
        const { text, metrics } = typeof raw === "string" ? { text: raw, metrics: undefined } : raw;
        // Recorded before parsing: a completion that fails to parse still
        // reflects a real provider call, and its usage should not be lost.
        this.metrics = metrics;
        return parseModelAction(text, context, this.options);
      } catch (error) {
        lastError = error;
      } finally {
        this.controllers.delete(controller);
        if (timer) clearTimeout(timer);
      }
    }
    if (lastError instanceof ActionParseError || lastError instanceof ModelRequestError) throw lastError;
    if (lastError instanceof Error) throw new ModelRequestError("request_failed", lastError.message);
    throw new ModelRequestError("request_failed", "model request failed");
  }
}
