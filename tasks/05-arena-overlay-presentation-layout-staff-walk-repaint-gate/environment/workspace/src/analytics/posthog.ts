import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { storedUserId } from "../auth.js";
import type { AnalyticsCloudEvent } from "./events.js";

/**
 * Product analytics (DAU / feature usage), separate from the gameplay trace
 * capture path (overlay/recording.ts -> queue_recording_chunks -> tauri/src/main.rs).
 * This never blocks or crashes gameplay — if there's no API key or a network
 * error, capture() calls are no-ops.
 */

function createClient(): PostHog | null {
  const apiKey = process.env.POSTHOG_API_KEY;
  return apiKey
    ? new PostHog(apiKey, { host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com" })
    : null;
}

function deviceIdFile(): string {
  return join(homedir(), ".tui-gamepigeon", "device_id");
}

function getDeviceId(): string {
  const file = deviceIdFile();
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch {
    // fall through to generating a fresh id
  }
  const id = randomUUID();
  try {
    mkdirSync(join(homedir(), ".tui-gamepigeon"), { recursive: true });
    writeFileSync(file, id);
  } catch {
    // best-effort; an in-memory id still works for this process
  }
  return id;
}

export class Analytics {
  constructor(
    private client: Pick<PostHog, "capture" | "shutdown"> | null = createClient(),
    private distinctId = storedUserId() ?? getDeviceId(),
  ) {}

  setDistinctId(distinctId: string): void {
    if (distinctId) this.distinctId = distinctId;
  }

  resetDistinctId(): void {
    this.distinctId = getDeviceId();
  }

  capture(event: AnalyticsCloudEvent): void {
    if (!this.client) return;
    try {
      this.client.capture({
        distinctId: this.distinctId,
        event: event.type,
        timestamp: new Date(event.time),
        properties: {
          ...event.data,
          $insert_id: event.id,
          cloud_event_id: event.id,
          cloud_event_source: event.source,
          cloud_event_specversion: event.specversion,
          cloud_event_datacontenttype: event.datacontenttype,
          ...(event.subject ? { cloud_event_subject: event.subject } : {}),
        },
      });
    } catch {
      // analytics must never crash gameplay
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.client?.shutdown();
    } catch {
      // ignore
    }
  }
}

export const analytics = new Analytics();
