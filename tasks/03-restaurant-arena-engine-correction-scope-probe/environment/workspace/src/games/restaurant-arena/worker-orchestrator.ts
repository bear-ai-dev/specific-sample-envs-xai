import { buildFullRolePrompt, type PromptBuilderOptions } from "./prompts.js";
import { RestaurantGame, type EnvelopeTelemetry } from "./restaurant-game.js";
import { ACTION_VERSION, type ActionEnvelope, type Role, type Tool } from "./types.js";
import type { TraceV3Model } from "./trace.js";
import type { ActionContext, ModelCallMetrics } from "./worker-client.js";

/** The small surface the orchestrator needs from WorkerModelClient. */
export interface WorkerActionClient {
  act(context: ActionContext, systemPrompt: string, turnPrompt: string): Promise<ActionEnvelope>;
  /** Metrics from the most recently completed act() call, when the transport reported any. */
  lastMetrics?(): ModelCallMetrics | undefined;
  abort?(): void;
}

export const TURN_ORDER: readonly Role[] = ["host", "supply_lead", "chef", "server"];

export type WorkerTurnStatus = "accepted" | "rejected" | "fallback" | "paused";

export interface WorkerTurn {
  role: Role;
  status: WorkerTurnStatus;
  action?: ActionEnvelope;
  error?: string;
}

export interface OrchestratorTick {
  advanced: boolean;
  paused: boolean;
  complete: boolean;
  turns: WorkerTurn[];
}

export interface WorkerOrchestratorOptions {
  /** The model client used for every staff role. */
  client: WorkerActionClient;
  /** Run roles in this order. Sequential execution keeps every envelope on one tick. */
  roles?: readonly Role[];
  promptOptions?: PromptBuilderOptions;
  /** Wall-clock pacing for start(); a direct runTick() is always immediate. */
  tickIntervalMs?: number | (() => number);
  now?: () => Date;
  requestId?: () => string;
  /** Receives individual model/action failures without making the loop stop. */
  onError?: (turn: WorkerTurn) => void;
  /**
   * The model behind every worker turn, recorded on the trace event. Absent
   * for environment-driven runs, which have no model to attribute.
   */
  model?: TraceV3Model;
  /** Monotonic clock for latency. Injectable so tests get deterministic numbers. */
  elapsedMs?: () => number;
  /** Receives each paced round after its state changes are committed. */
  onTick?: (report: OrchestratorTick) => void;
}

const FALLBACKS: Record<Role | "expediter", { tool: Tool; arguments: Record<string, unknown> }> = {
  chef: { tool: "inspect", arguments: { targetId: "oven-1" } },
  server: { tool: "inspect", arguments: { targetId: "pass" } },
  host: { tool: "update_guest", arguments: { message: "Thank you for your patience; we will seat you as soon as a table is ready." } },
  supply_lead: { tool: "inspect", arguments: { targetId: "pass" } },
  get expediter() {
    return this.supply_lead;
  },
};

/**
 * Turns the four Restaurant Arena workers into a paced, autonomous shift.
 * It deliberately schedules one role at a time: every observation and action
 * remains on the current simulator tick, so an earlier worker cannot make a
 * later worker submit a stale envelope.
 */
export class WorkerOrchestrator {
  private readonly roles: readonly Role[];
  private readonly tickIntervalMs: number | (() => number);
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private paused = false;
  private inFlight = false;
  private requestSequence = 0;
  private requestEpoch = 0;
  private roundTick?: number;
  private nextRoleIndex = 0;
  private readonly roundTurns: WorkerTurn[] = [];
  /** When the current decision round's first worker began, for roundMs. */
  private roundStartedAt?: number;

  constructor(
    private readonly game: RestaurantGame,
    private readonly options: WorkerOrchestratorOptions,
  ) {
    this.roles = options.roles ?? TURN_ORDER;
    this.game.setExternalControllers(this.roles);
    this.tickIntervalMs = options.tickIntervalMs ?? 1_000;
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Pause before a player intervention; no later worker or tick is started. */
  pause(): void {
    this.paused = true;
    this.requestEpoch += 1;
    this.options.client.abort?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.running && !this.inFlight && !this.timer && !this.game.isOver()) void this.pump();
  }

  /**
   * Applies a player change with the worker loop paused. Callers can resume()
   * once the player has finished prioritising, approving, or repositioning.
   */
  intervene<T>(intervention: () => T): T {
    this.pause();
    return intervention();
  }

  start(): void {
    if (this.game.isOver()) return;
    if (this.running) return this.resume();
    this.resume();
    this.running = true;
    void this.pump();
  }

  stop(): void {
    this.running = false;
    this.pause();
  }

  private async pump(): Promise<void> {
    if (!this.running || this.paused || this.game.isOver()) {
      if (this.game.isOver()) this.running = false;
      return;
    }
    const clock = this.options.elapsedMs ?? (() => Date.now());
    const startedAt = clock();
    const report = await this.runTick();
    this.options.onTick?.(report);
    if (!this.running || this.paused || this.game.isOver()) {
      if (this.game.isOver()) this.running = false;
      return;
    }
    const interval = typeof this.tickIntervalMs === "function" ? this.tickIntervalMs() : this.tickIntervalMs;
    this.timer = setTimeout(() => void this.pump(), Math.max(0, interval - (clock() - startedAt)));
  }

  /** Execute a complete staff decision round, then advance exactly one game tick. */
  async runTick(): Promise<OrchestratorTick> {
    if (this.inFlight) throw new Error("worker orchestrator tick already in progress");
    this.syncRoundToGameTick();
    if (this.paused || this.game.isOver()) {
      return { advanced: false, paused: this.paused, complete: this.game.isOver(), turns: [] };
    }

    this.inFlight = true;
    try {
      if (this.nextRoleIndex === 0 && this.roundStartedAt === undefined) {
        const clock = this.options.elapsedMs ?? (() => Date.now());
        this.roundStartedAt = clock();
      }
      while (this.nextRoleIndex < this.roles.length) {
        const role = this.roles[this.nextRoleIndex]!;
        if (this.paused || this.game.isOver()) {
          return this.partialReport({ role, status: "paused" });
        }
        const turn = await this.runWorker(role);
        if (turn.status === "paused") return this.partialReport(turn);
        this.roundTurns.push(turn);
        this.nextRoleIndex += 1;
      }

      // An intervention can arrive while the final model request is awaiting.
      if (this.paused || this.game.isOver()) {
        return this.partialReport();
      }
      this.game.step("tick");
      const turns = [...this.roundTurns];
      this.resetRound();
      return { advanced: true, paused: false, complete: this.game.isOver(), turns };
    } finally {
      this.inFlight = false;
    }
  }

  private syncRoundToGameTick(): void {
    const tick = this.game.state().episode.tick;
    if (this.roundTick === undefined) {
      this.roundTick = tick;
    } else if (this.roundTick !== tick) {
      this.resetRound();
      this.roundTick = tick;
    }
  }

  private resetRound(): void {
    this.roundTick = undefined;
    this.nextRoleIndex = 0;
    this.roundTurns.length = 0;
    this.roundStartedAt = undefined;
  }

  private partialReport(pendingTurn?: WorkerTurn): OrchestratorTick {
    return {
      advanced: false,
      paused: this.paused,
      complete: this.game.isOver(),
      turns: pendingTurn ? [...this.roundTurns, pendingTurn] : [...this.roundTurns],
    };
  }

  /** Metrics fields shared by the accepted and fallback telemetry passed to stepEnvelope(). */
  private metricsTelemetry(latencyMs: number | undefined, roundMs: number | undefined, metrics?: ModelCallMetrics): EnvelopeTelemetry {
    return {
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(roundMs !== undefined ? { roundMs } : {}),
      ...(metrics?.queueMs !== undefined ? { queueMs: metrics.queueMs } : {}),
      ...(metrics?.providerMs !== undefined ? { providerMs: metrics.providerMs } : {}),
      ...(metrics?.inputTokens !== undefined ? { inputTokens: metrics.inputTokens } : {}),
      ...(metrics?.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
      ...(metrics?.cachedInputTokens !== undefined ? { cachedInputTokens: metrics.cachedInputTokens } : {}),
      ...(metrics?.finishReason !== undefined ? { finishReason: metrics.finishReason } : {}),
    };
  }

  /** Elapsed time since this decision round's first worker began, measured now. */
  private roundMsSoFar(clock: () => number): number | undefined {
    return this.roundStartedAt !== undefined ? Math.max(0, clock() - this.roundStartedAt) : undefined;
  }

  private async runWorker(role: Role): Promise<WorkerTurn> {
    const requestEpoch = this.requestEpoch;
    const state = this.game.state();
    const worker = state.workers.find((candidate) => candidate.role === role);
    if (!worker) {
      const turn = { role, status: "rejected" as const, error: `no worker for role ${role}` };
      this.options.onError?.(turn);
      return turn;
    }

    const observation = this.game.observe(role);
    const prompts = buildFullRolePrompt(observation, this.options.promptOptions);
    const context: ActionContext = { episodeId: state.episode.id, actorId: worker.id, role, observation };
    const clock = this.options.elapsedMs ?? (() => Date.now());
    const startedAt = clock();
    try {
      const action = await this.options.client.act(context, prompts.systemPrompt, prompts.turnPrompt);
      const latencyMs = Math.max(0, clock() - startedAt);
      const roundMs = this.roundMsSoFar(clock);
      const metrics = this.options.client.lastMetrics?.();
      if (this.paused || requestEpoch !== this.requestEpoch) return { role, status: "paused", action };
      const result = this.game.stepEnvelope(action, { ...this.metricsTelemetry(latencyMs, roundMs, metrics), model: this.options.model });
      if (result.accepted) return { role, status: "accepted", action };
      // The rejection is already on the trace; the fallback that replaces it
      // is recorded separately so both attempts survive in the record.
      return this.applyFallback(role, `action rejected: ${result.error?.code ?? "unknown"}`, latencyMs, roundMs, metrics);
    } catch (error) {
      if (this.paused || requestEpoch !== this.requestEpoch) {
        return { role, status: "paused", error: error instanceof Error ? error.message : "model request failed" };
      }
      return this.applyFallback(
        role,
        error instanceof Error ? error.message : "model request failed",
        Math.max(0, clock() - startedAt),
        this.roundMsSoFar(clock),
        this.options.client.lastMetrics?.(),
      );
    }
  }

  private applyFallback(role: Role, error: string, latencyMs?: number, roundMs?: number, metrics?: ModelCallMetrics): WorkerTurn {
    if (this.paused || this.game.isOver()) return { role, status: "paused", error };
    const state = this.game.state();
    const worker = state.workers.find((candidate) => candidate.role === role);
    if (!worker) return { role, status: "rejected", error };
    const fallback = FALLBACKS[role];
    const requestId = this.options.requestId?.() ?? `fallback-${++this.requestSequence}`;
    const action: ActionEnvelope = {
      version: ACTION_VERSION,
      episodeId: state.episode.id,
      actorId: worker.id,
      actorType: "worker",
      role,
      tool: fallback.tool,
      arguments: { ...fallback.arguments },
      tick: state.episode.tick,
      timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      requestId,
      idempotencyKey: `${state.episode.id}:${requestId}`,
    };
    const result = this.game.stepEnvelope(action, this.metricsTelemetry(latencyMs, roundMs, metrics));
    const turn: WorkerTurn = {
      role,
      status: result.accepted ? "fallback" : "rejected",
      action,
      error,
    };
    this.options.onError?.(turn);
    return turn;
  }
}
