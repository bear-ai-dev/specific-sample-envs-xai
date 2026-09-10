export const MILESTONE_FEED_LABELS = [
  "ORIGINAL DECISION",
  "PLAYER CORRECTION",
  "LATER PROBE",
  "SHIFT OUTCOMES",
] as const;

/** The fixed narrative spine used by the live Event Feed renderer. */
export function milestoneFeedText(): string {
  return MILESTONE_FEED_LABELS.join("  →  ");
}
