import { createEventId } from "../recording/ids.js";

export const ANALYTICS_EVENT_TYPES = {
  appOpened: "app.opened",
  accountSignedUp: "account.signed_up",
  accountSignedIn: "account.signed_in",
  gameStarted: "game.started",
  gameEnded: "game.ended",
  pluginLaunched: "plugin.launched",
  pluginReattached: "plugin.reattached",
  agentTaskCompleted: "agent.task_completed",
  siteVisited: "site.visited",
  referralCreated: "referral.created",
  referralRedeemed: "referral.redeemed",
  paymentSucceeded: "payment.succeeded",
} as const;

export type AnalyticsEventType =
  (typeof ANALYTICS_EVENT_TYPES)[keyof typeof ANALYTICS_EVENT_TYPES];
export type AuthMethod = "password" | "google" | "github";

export interface AnalyticsEventDataMap {
  "app.opened": { app_version: string; platform: "tui" | "overlay" };
  "account.signed_up": { method: AuthMethod };
  "account.signed_in": { method: AuthMethod };
  "game.started": { game_type: string; variation_id: string };
  "game.ended": {
    game_type: string;
    variation_id: string;
    outcome: "completed" | "abandoned";
    score: number;
    success: boolean;
    duration_ms: number;
    actions_taken: number;
  };
  "plugin.launched": { harness: string };
  "plugin.reattached": { harness: string };
  "agent.task_completed": { harness: string };
  "site.visited": { referrer_host?: string; campaign?: string };
  "referral.created": { channel?: string };
  "referral.redeemed": { channel?: string };
  "payment.succeeded": { plan: string; currency: string; amount_minor: number };
}

export interface AnalyticsCloudEvent<T extends AnalyticsEventType = AnalyticsEventType> {
  specversion: "1.0";
  id: string;
  source: string;
  type: T;
  time: string;
  datacontenttype: "application/json";
  subject?: string;
  data: AnalyticsEventDataMap[T];
}

export function createAnalyticsEvent<T extends AnalyticsEventType>(
  type: T,
  data: AnalyticsEventDataMap[T],
  options: { id?: string; source?: string; subject?: string; time?: Date } = {},
): AnalyticsCloudEvent<T> {
  return {
    specversion: "1.0",
    id: options.id ?? createEventId(),
    source: options.source ?? "/tui-gamepigeon/client",
    type,
    time: (options.time ?? new Date()).toISOString(),
    datacontenttype: "application/json",
    ...(options.subject ? { subject: options.subject } : {}),
    data,
  };
}

export function createAuthAnalyticsEvent(input: {
  kind: "signed_up" | "signed_in";
  method: AuthMethod;
  userId?: string;
}): AnalyticsCloudEvent<"account.signed_up" | "account.signed_in"> {
  return createAnalyticsEvent(
    input.kind === "signed_up"
      ? ANALYTICS_EVENT_TYPES.accountSignedUp
      : ANALYTICS_EVENT_TYPES.accountSignedIn,
    { method: input.method },
    { subject: input.userId },
  );
}
