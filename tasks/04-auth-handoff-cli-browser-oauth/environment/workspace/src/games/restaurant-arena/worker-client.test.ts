import { describe, expect, it } from "bun:test";
import type { ChefObservation } from "./types.js";
import { ActionParseError, ModelRequestError, WorkerModelClient, parseModelAction } from "./worker-client.js";

const observation: ChefObservation = {
  version: "restaurant-arena-observation/v2", role: "chef", tick: 3, load: 0,
  orders: [], inventory: {}, equipment: [],
};
const context = { episodeId: "episode-1", actorId: "worker-chef", role: "chef" as const, observation };
const ids = { requestId: () => "req-1", now: () => new Date("2026-09-03T00:00:00Z") };

describe("worker model action parser (#249)", () => {
  for (const [name, completion] of [
    ["clean JSON", '{"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}'],
    ["fenced JSON", '```json\n{"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}\n```'],
    ["preamble JSON", 'I will prioritize it. {"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}'],
  ] as const) {
    it(`extracts ${name}`, () => {
      const action = parseModelAction(completion, context, ids);
      expect(action.tool).toBe("prepare");
      expect(action.idempotencyKey).toBe("episode-1:req-1");
    });
  }

  it("rejects unsupported tools and required arguments", () => {
    expect(() => parseModelAction('{"action":{"tool":"serve","arguments":{"tableId":"table-1"}}}', context, ids)).toThrow(ActionParseError);
    expect(() => parseModelAction('{"action":{"tool":"prepare","arguments":{}}}', context, ids)).toThrow(ActionParseError);
  });

  it("bounds an unfulfilled model request", async () => {
    const client = new WorkerModelClient({ complete: () => new Promise<string>(() => {}), timeoutMs: 10, retries: 0 });
    await expect(client.act(context, "system", "turn")).rejects.toBeInstanceOf(ModelRequestError);
  });

  it("lets the transport own the bound, so a queued request is not aborted", async () => {
    // A request waiting for the account's rate-limit budget has not failed;
    // it has not started. A client-side timer cannot tell those apart, so
    // timeoutMs: null hands the bound to the transport, whose own timer
    // starts after admission.
    let admitted = false;
    const client = new WorkerModelClient({
      timeoutMs: null,
      retries: 0,
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        admitted = true;
        return '{"tool":"prepare","arguments":{"orderId":"order-1"}}';
      },
    });

    const action = await client.act(context, "system", "turn");
    expect(admitted).toBe(true);
    expect(action.tool).toBe("prepare");
  });

  it("still cancels a queued request when its shift is replaced", async () => {
    // Dropping the client-side timer must not cost us cancellation: pausing
    // or restarting a shift is what stops a request that is merely in line.
    const client = new WorkerModelClient({
      timeoutMs: null,
      retries: 0,
      complete: (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      }),
    });

    const action = client.act(context, "system", "turn");
    client.abort();
    await expect(action).rejects.toMatchObject({ code: "request_failed", message: "canceled" });
  });

  it("aborts provider work when its shift is replaced", async () => {
    const client = new WorkerModelClient({
      complete: (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
      }),
      retries: 0,
    });

    const action = client.act(context, "system", "turn");
    client.abort();
    await expect(action).rejects.toMatchObject({ code: "request_failed", message: "canceled" });
  });

  it("surfaces the transport's metrics from the most recent act() call", async () => {
    const client = new WorkerModelClient({
      retries: 0,
      complete: async () => ({
        text: '{"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}',
        metrics: { queueMs: 12, providerMs: 340, inputTokens: 900, outputTokens: 40, cachedInputTokens: 700, finishReason: "stop" },
      }),
    });

    expect(client.lastMetrics()).toBeUndefined();
    await client.act(context, "system", "turn");
    expect(client.lastMetrics()).toEqual({ queueMs: 12, providerMs: 340, inputTokens: 900, outputTokens: 40, cachedInputTokens: 700, finishReason: "stop" });
  });

  it("leaves metrics unavailable for a transport that reports a bare completion", async () => {
    const client = new WorkerModelClient({
      retries: 0,
      complete: async () => '{"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}',
    });

    await client.act(context, "system", "turn");
    expect(client.lastMetrics()).toBeUndefined();
  });

  it("clears stale metrics when a later call never reaches the provider", async () => {
    let succeed = true;
    const client = new WorkerModelClient({
      retries: 0,
      complete: async () => {
        if (succeed) return { text: '{"action":{"tool":"prepare","arguments":{"orderId":"order-1"}}}', metrics: { providerMs: 100 } };
        throw new Error("provider unreachable");
      },
    });

    await client.act(context, "system", "turn");
    expect(client.lastMetrics()).toEqual({ providerMs: 100 });

    succeed = false;
    await expect(client.act(context, "system", "turn")).rejects.toBeInstanceOf(ModelRequestError);
    expect(client.lastMetrics()).toBeUndefined();
  });
});
