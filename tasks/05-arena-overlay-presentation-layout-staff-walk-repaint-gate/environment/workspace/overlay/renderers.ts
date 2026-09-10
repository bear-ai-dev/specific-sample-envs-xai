import type { PlayableGame } from "../src/games/registry.js";

const INTERVENE_ROLES: readonly { role: string; label: string }[] = [
  { role: "host", label: "Host" },
  { role: "supply_lead", label: "Supply & Risk Lead" },
  { role: "chef", label: "Chef" },
  { role: "server", label: "Server" },
  { role: "everyone", label: "Everyone" },
];

/**
 * The player intervention panel: the one piece of arena chrome that lives in
 * the DOM rather than the canvas, because free-text guidance needs a real
 * `<textarea>` — Phaser has no text input of its own. Its shell is static;
 * `updateRestaurantArena` (app.ts) refills the ticket list and the
 * approve/deny section from the live view without touching whatever the
 * player is mid-typing in the message box.
 */
function renderInterventionPanel(): string {
  const roleButtons = INTERVENE_ROLES.map(
    ({ role, label }, index) =>
      `<button type="button" class="arena-intervene-role${index === 0 ? " is-selected" : ""}" data-role="${role}">${label}</button>`,
  ).join("");
  return `<button type="button" class="arena-intervene-toggle" data-arena-intervene-toggle aria-expanded="false" aria-controls="arena-intervene-panel">Staff</button>
<div class="arena-intervene-panel" id="arena-intervene-panel" data-arena-intervene-panel hidden>
  <div class="arena-intervene-head">
    <strong>Talk to the floor</strong>
    <button type="button" class="arena-intervene-close" data-arena-intervene-close aria-label="Close">×</button>
  </div>
  <p class="arena-intervene-budget" data-arena-intervene-budget role="status" aria-live="polite"></p>
  <p class="arena-intervene-label">Activity</p>
  <ol class="arena-worker-activity" data-arena-worker-activity aria-label="Live staff activity"></ol>
  <div class="arena-intervene-roles" data-arena-intervene-roles role="group" aria-label="Select a staff member">${roleButtons}</div>
  <label class="arena-intervene-label" for="arena-intervene-text">Message</label>
  <textarea id="arena-intervene-text" class="arena-intervene-text" data-arena-intervene-text rows="2" maxlength="256" placeholder="Tell them what you need…"></textarea>
  <label class="arena-intervene-urgent"><input type="checkbox" data-arena-intervene-urgent /> Mark urgent</label>
  <button type="button" class="arena-intervene-send" data-arena-intervene-send>Send message</button>
  <div class="arena-intervene-divider"></div>
  <p class="arena-intervene-label">Prioritize a ticket</p>
  <div class="arena-intervene-tickets" data-arena-intervene-tickets></div>
  <div class="arena-intervene-divider"></div>
  <button type="button" class="arena-intervene-correct" data-arena-intervene-correct>Protect safety — verify before substituting</button>
  <button type="button" class="arena-intervene-pass" data-arena-intervene-pass>Pass the round — no change (N)</button>
  <div class="arena-intervene-approve" data-arena-intervene-approve hidden></div>
  <p class="arena-intervene-status" data-arena-intervene-status role="status" aria-live="polite"></p>
</div>`;
}

/**
 * The arena is one window: clock, transport, tickets and every action live
 * on the canvas itself, so the HTML contributes nothing but the stage — plus
 * the one DOM exception above, since free-text player guidance can't be
 * drawn with Phaser's canvas primitives.
 */
function renderRestaurantArena(_game: PlayableGame): string {
  return `<div class="board arena-stage" role="group" aria-label="Restaurant Arena floor"><div data-phaser-mount></div><p class="arena-worker-mode" data-arena-worker-mode role="status" aria-live="polite">Deterministic crew · live model unavailable</p>${renderInterventionPanel()}</div>`;
}

const RENDERERS: Record<string, (game: PlayableGame) => string> = {
  "restaurant-arena": renderRestaurantArena,
};

export function renderNativeGame(game: PlayableGame): string {
  const renderer = RENDERERS[game.name];
  if (!renderer) throw new Error(`No HTML renderer for ${game.name}`);
  return `<section class="game game-${game.name}" data-game="${game.name}">${renderer(game)}</section>`;
}
