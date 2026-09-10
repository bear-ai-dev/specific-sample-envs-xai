/**
 * Compact Decision-and-Correction Timeline Viewer for Restaurant Arena.
 *
 * Presents the 4 key sequence milestones in order:
 *  1. Original decision (Incident trigger & Proposed worker action)
 *  2. Correction (Player intervention & Worker reaction)
 *  3. Later probe (a later, unrelated equipment event)
 *  4. Outcome (Shift outcome metrics)
 */

import type { RestaurantGame } from "./restaurant-game.js";
import type { RestaurantArenaTraceV3, TraceV3Event, TraceV3Role } from "./trace.js";
import type { ArenaView } from "./arena-view.js";
import type { Role } from "./types.js";

export type SequenceMilestone =
  | "original_decision"
  | "correction"
  | "later_probe"
  | "outcome";

export const KEY_SEQUENCE_MILESTONES: readonly SequenceMilestone[] = [
  "original_decision",
  "correction",
  "later_probe",
  "outcome",
] as const;

export type TimelineBadgeTone =
  | "danger"
  | "warning"
  | "info"
  | "success"
  | "neutral";

export interface TimelineCard {
  readonly id: string;
  readonly milestone: SequenceMilestone;
  readonly stepIndex: number; // Recorded order, starting at 1
  readonly title: string;
  readonly role?: Role | TraceV3Role | "player" | "system" | "house";
  readonly tick: number;
  readonly badgeText: string;
  readonly badgeTone: TimelineBadgeTone;
  readonly headline: string;
  readonly detail: string;
  readonly metadata?: Record<string, string | number | boolean>;
}

export interface TimelineModel {
  readonly cards: readonly TimelineCard[];
  readonly milestonesPresented: readonly SequenceMilestone[];
  readonly episodeId: string;
  readonly isComplete: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTrace(obj: unknown): obj is RestaurantArenaTraceV3 {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as RestaurantArenaTraceV3).version === "restaurant-arena-trace/v3" &&
    Array.isArray((obj as RestaurantArenaTraceV3).events)
  );
}

function isGame(obj: unknown): obj is RestaurantGame {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as RestaurantGame).state === "function" &&
    typeof (obj as RestaurantGame).view === "function"
  );
}

export function buildArenaTimeline(source: RestaurantGame | RestaurantArenaTraceV3 | ArenaView): TimelineModel {
  const trace = isTrace(source);
  const game = isGame(source);
  const state = game ? source.state() : trace ? undefined : source;
  const events: Pick<TraceV3Event, "tick" | "kind" | "actorId" | "role" | "text" | "payload" | "toolResult" | "action">[] = trace
    ? source.events
    : game
      ? source.getRecordedEvents()
      : source.feed.map((entry) => ({
          tick: entry.tick,
          kind: entry.voice === "you" ? "player_correction" : entry.kind === "action" ? "action" : "message",
          actorId: entry.voice === "you" ? "player" : entry.voice === "house" ? "system" : entry.voice,
          text: entry.text,
        }));
  const cards: TimelineCard[] = events.map((event, index) => {
    const player = event.actorId === "player" || event.kind === "player_correction";
    const correction = event.kind === "player_correction";
    const milestone: SequenceMilestone = event.kind === "outcome" ? "outcome" : correction ? "correction" : "original_decision";
    const failed = event.toolResult?.ok === false;
    return {
      id: `recorded-${index}`, milestone, stepIndex: index + 1,
      title: event.kind === "outcome" ? "Shift Outcome Metrics" : correction ? "Player Intervention" : "Recorded Event",
      role: player ? "player" : event.role ?? "system",
      tick: event.tick,
      badgeText: failed ? "REJECTED" : event.kind.replaceAll("_", " ").toUpperCase(),
      badgeTone: failed ? "danger" : player ? "info" : "neutral",
      headline: event.text ?? `${event.actorId ?? "system"}: ${event.action?.tool ?? event.kind}`,
      detail: event.toolResult?.error?.message ?? "",
    };
  });
  return {
    cards,
    milestonesPresented: KEY_SEQUENCE_MILESTONES.filter((milestone) => cards.some((card) => card.milestone === milestone)),
    episodeId: trace ? source.episodeId : state!.episode.id,
    isComplete: trace ? source.terminal.status === "completed" : state!.episode.phase === "complete",
  };
}

/**
 * Render the Timeline Viewer HTML.
 * Includes milestone progress strip and scrollable chronological cards.
 * Designed to handle large traces gracefully with smooth scrolling and zero visual clipping.
 */
export function renderTimelineHtml(timeline: TimelineModel): string {
  const milestoneLabels: Record<SequenceMilestone, string> = {
    original_decision: "1. Original Decision",
    correction: "2. Player Correction",
    later_probe: "3. Later Probe",
    outcome: "4. Shift Outcomes",
  };

  const stepsHtml = KEY_SEQUENCE_MILESTONES.map((milestone, idx) => {
    const isPresented = timeline.milestonesPresented.includes(milestone);
    return `
      <div class="milestone-step${isPresented ? " is-active" : ""}" data-milestone="${milestone}">
        <span class="milestone-dot">${idx + 1}</span>
        <span class="milestone-name">${escapeHtml(milestoneLabels[milestone])}</span>
      </div>
    `;
  }).join('<div class="milestone-connector"></div>');

  const cardsHtml = timeline.cards
    .map((card) => {
      const toneClass = `badge-${card.badgeTone}`;
      return `
        <div class="arena-timeline-card" data-milestone="${card.milestone}" data-step="${card.stepIndex}">
          <div class="card-header">
            <span class="card-step">#${card.stepIndex}</span>
            <span class="card-badge ${toneClass}">${escapeHtml(card.badgeText)}</span>
            <span class="card-title">${escapeHtml(card.title)}</span>
            <span class="card-tick">Tick ${card.tick}</span>
          </div>
          <p class="card-headline">${escapeHtml(card.headline)}</p>
          <p class="card-detail">${escapeHtml(card.detail)}</p>
        </div>
      `;
    })
    .join("");

  return `
    <div class="arena-timeline" role="region" aria-label="Shift decision and correction timeline" data-sequence="original_decision correction later_probe outcome">
      <div class="arena-timeline-header">
        <span class="arena-timeline-title">DECISION &amp; CORRECTION TIMELINE</span>
        <span class="arena-timeline-badge">${timeline.milestonesPresented.length} MILESTONES</span>
      </div>
      <div class="arena-timeline-milestones">
        ${stepsHtml}
      </div>
      <div class="arena-timeline-cards" tabindex="0" role="feed" aria-label="Chronological decision cards">
        ${cardsHtml}
      </div>
    </div>
  `;
}
