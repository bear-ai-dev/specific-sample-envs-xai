import { invoke } from "./tauri-bridge.js";

declare const __POSTHOG_CAPTURE_KEY__: string;

const POSTHOG_CAPTURE_KEY = typeof __POSTHOG_CAPTURE_KEY__ === "string" ? __POSTHOG_CAPTURE_KEY__ : "";
const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";

type EventData =
  | { app_version: string; platform: "overlay" }
  | { game_type: string; variation_id: string }
  | {
    game_type: string;
    variation_id: string;
    outcome: "completed" | "abandoned";
    score: number;
    success: boolean;
    duration_ms: number;
    actions_taken: number;
  };

type OverlayEvent = {
  specversion: "1.0";
  id: string;
  source: string;
  type: "app.opened" | "game.started" | "game.ended";
  time: string;
  datacontenttype: "application/json";
  subject?: string;
  data: EventData;
};

function deviceId(): string {
  const key = "gamepigeon.analytics.device_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export function posthogProperties(event: OverlayEvent, distinctId: string): Record<string, unknown> {
  return {
    distinct_id: distinctId,
    ...event.data,
    $insert_id: event.id,
    $timestamp: event.time,
    cloud_event_id: event.id,
    cloud_event_source: event.source,
    cloud_event_specversion: event.specversion,
    cloud_event_datacontenttype: event.datacontenttype,
    ...(event.subject ? { cloud_event_subject: event.subject } : {}),
  };
}

export function captureOverlayEvent(
  type: "app.opened" | "game.started" | "game.ended",
  data: EventData,
  subject?: string,
): void {
  if (localStorage.getItem("gamepigeon.settings.productAnalytics") === "false") return;
  const event: OverlayEvent = {
    specversion: "1.0" as const,
    id: crypto.randomUUID(),
    source: "/tui-gamepigeon/overlay",
    type,
    time: new Date().toISOString(),
    datacontenttype: "application/json" as const,
    ...(subject ? { subject } : {}),
    data,
  };
  const capture = POSTHOG_CAPTURE_KEY ? fetch(POSTHOG_CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      api_key: POSTHOG_CAPTURE_KEY,
      event: event.type,
      properties: posthogProperties(event, deviceId()),
    }),
  }) : Promise.reject(new Error("PostHog capture key is not configured"));
  void capture.then((response) => {
    if (!response.ok) throw new Error("PostHog capture failed");
  }).catch(() => invoke("record_analytics_event", { event: JSON.stringify(event) }).catch(() => undefined));
}
