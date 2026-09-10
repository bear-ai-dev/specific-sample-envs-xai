import type { GameEntry, PlayableGame } from "../src/games/registry.js";
import { FEATURED_GAME_IDS, MENU_GAMES, isPlayable } from "../src/games/registry.js";
import type { StepResult } from "../src/core/game.js";
import type { Key } from "../src/core/key.js";
import type { EpisodeEndReason, TraceActor } from "../src/recording/types.js";
import { renderNativeGame } from "./renderers.js";
import { captureOverlayEvent } from "./analytics.js";
import type { RoundStatus } from "../src/games/restaurant-arena/rounds.js";
import {
  appendOverlayAction,
  buildOverlayGameResult,
  buildOverlayTraceChunks,
  buildSealedOverlayTraceChunks,
  type StoredOverlayTrace,
} from "./recording.js";
import { getOverlayWindow, invoke, isTauri } from "./tauri-bridge.js";
import { bindUpdateBanner, refreshUpdateBanner } from "./update.js";
import {
  CLEAR as WORKER_BUDGET_CLEAR,
  WORKER_BUDGET_EVENT,
  readWorkerBudgetSignal,
  shouldReportFallback,
  workerBudgetHoldMs,
  workerBudgetMessage,
  type WorkerBudgetState,
} from "./worker-budget.js";
import {
  type AuthUser,
  beginSignIn,
  cancelSignIn,
  copySignInUrl,
  gateMarkup,
  isSignedIn,
  loadAuthSession,
  renderAccountChip,
  renderSignInBar,
  signedInUser,
  setSignedInUser,
  setSyncError,
} from "./auth.js";
import { loadSavedGame, type SavedGame } from "./persistence.js";
import { mountRestaurantArenaScene, type RestaurantArenaSceneHandle, type RestaurantArenaState } from "./restaurant-arena-scene.js";
import { buildArenaTimeline, renderTimelineHtml } from "../src/games/restaurant-arena/timeline.js";
import { captureArenaTrace, exportTraceJson, exportTraceJsonl, type RestaurantArenaTraceV3, type TraceV3Model } from "../src/games/restaurant-arena/trace.js";
import type { PlayerInterventionInput, PlayerInterventionTarget, RestaurantGame } from "../src/games/restaurant-arena/restaurant-game.js";
import { WorkerModelClient, type ModelCallMetrics, type ModelRequest } from "../src/games/restaurant-arena/worker-client.js";
import { WorkerOrchestrator, type OrchestratorTick } from "../src/games/restaurant-arena/worker-orchestrator.js";
import type { Role } from "../src/games/restaurant-arena/types.js";

declare const __APP_VERSION__: string | undefined;

const windowHandle = getOverlayWindow();
const screenElement = document.querySelector<HTMLElement>("#screen")!;

function browserKey(event: KeyboardEvent): Key | null {
  switch (event.key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "Enter": return "enter";
    case "Backspace": return "backspace";
  }
  if (event.key.length !== 1) return null;
  const lower = event.key.toLowerCase();
  if (lower === "w") return "up";
  if (lower === "s") return "down";
  if (lower === "a") return "left";
  if (lower === "d") return "right";
  if (lower === "q") return "quit";
  return { char: event.key };
}

type Screen = "gate" | "menu" | "variations" | "scores" | "settings" | "game";

type ArcadeSettings = {
  autoOpenOnPrompt: boolean; autoPauseOnStop: boolean; resetOnNewSession: boolean;
  agentBreakSuggestions: boolean; suggestionsSnoozedUntil: number | null;
  defaultWindowSize: "compact" | "expanded"; resumeLastGame: boolean;
  reducedMotion: boolean | null; showPersonalScores: boolean; cloudGameplaySync: boolean;
  productAnalytics: boolean; recordingWhilePlaying: boolean;
};
const DEFAULT_SETTINGS: ArcadeSettings = {
  autoOpenOnPrompt: true, autoPauseOnStop: true, resetOnNewSession: true,
  agentBreakSuggestions: true, suggestionsSnoozedUntil: null, defaultWindowSize: "compact",
  resumeLastGame: false, reducedMotion: null, showPersonalScores: true,
  cloudGameplaySync: true, productAnalytics: true, recordingWhilePlaying: true,
};
let settings: ArcadeSettings = { ...DEFAULT_SETTINGS };

interface LocalScoreEntry {
  game_type: string;
  variation_id: string;
  score: number;
  completed_at: string;
}

interface LocalScores {
  personal_bests: Array<{ game_type: string; score: number }>;
  recent: LocalScoreEntry[];
  top_scores: LocalScoreEntry[];
}
let screen: Screen = "gate";
let cursor = -1;
let variationCursor = 0;
let entry: GameEntry | undefined;
let game: PlayableGame | undefined;
let expanded = false;
let gameStartedAt = 0;
let actionsTaken = 0;
let gameEnded = false;
let gameSessionId: string | undefined;
let activeTrace: StoredOverlayTrace | undefined;
/**
 * The id of the run currently on screen, kept past `activeTrace`.
 *
 * `endGame` hands the trace off to the recording store and clears
 * `activeTrace` -- and it runs *before* the game-over overlay is built, so
 * reading the id off `activeTrace` at debrief time always came back empty on
 * the one path that matters: a completed shift. That is the path whose id a
 * tester has to read back to us (#281). Set when the run starts, cleared when
 * the next one does.
 */
let sessionReceiptId: string | undefined;
let lastReplay: { entry: GameEntry; variationId: string; seed: number; actions: string[]; arenaTrace?: RestaurantArenaTraceV3 } | undefined;
let replaying = false;
let localScores: LocalScores = { personal_bests: [], recent: [], top_scores: [] };
let restaurantArenaScene: RestaurantArenaSceneHandle | undefined;
let workerModel: TraceV3Model | undefined;
let workerOrchestrator: WorkerOrchestrator | undefined;
const workerActivity: string[] = [];
/** Which staff member the intervention panel currently addresses. */
let interveneRole: PlayerInterventionTarget = "chef";

const PREVIEW_SCORES: LocalScores = {
  personal_bests: [
    { game_type: "restaurant-arena", score: 130 },
  ],
  recent: ([
    ["restaurant-arena", "dinner-rush", 130, "2026-07-26T20:12:00.000Z"],
    ["restaurant-arena", "dinner-rush", 118, "2026-07-26T18:46:00.000Z"],
    ["restaurant-arena", "dinner-rush", 104, "2026-07-25T22:10:00.000Z"],
  ] as Array<[string, string, number, string]>).map(([game_type, variation_id, score, completed_at]) => ({ game_type, variation_id, score, completed_at })),
  top_scores: [],
};
PREVIEW_SCORES.top_scores = PREVIEW_SCORES.recent.slice().sort((a, b) => b.score - a.score).slice(0, 10);

const TRACE_KEY_PREFIX = "gamepigeon:recording:";

function persistTrace(trace: StoredOverlayTrace): void {
  if (!settings.recordingWhilePlaying) return;
  try {
    localStorage.setItem(`${TRACE_KEY_PREFIX}${trace.gameId}`, JSON.stringify(trace));
  } catch {
    // Recording must never interrupt gameplay.
  }
}

function appVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.2.0";
}

/**
 * Hands full chunks to the local recording store while the episode is still
 * running, so a long game is not stuck in the browser journal until it ends.
 * Sealed chunks are byte-stable, so the store treats the eventual final
 * submit of the same chunk ids as a no-op.
 */
const FLUSH_INTERVAL_MS = 5_000;
let flushTimer: number | undefined;

/**
 * Sealing replays the whole journal, so coalesce bursts of input (a gravity
 * tick arrives several times a second) onto a slow timer.
 */
function scheduleTraceFlush(trace: StoredOverlayTrace): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    if (activeTrace === trace) flushSealedTrace(trace);
  }, FLUSH_INTERVAL_MS);
}

function cancelTraceFlush(): void {
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = undefined;
}

function flushSealedTrace(trace: StoredOverlayTrace): void {
  try {
    const sealed = buildSealedOverlayTraceChunks(trace, appVersion());
    const alreadyFlushed = trace.flushedChunks ?? 0;
    const chunks = sealed.slice(alreadyFlushed);
    if (chunks.length === 0) return;
    trace.flushedChunks = sealed.length;
    persistTrace(trace);
    void invoke("queue_recording_chunks", { chunks, result: null }).catch(() => {
      // Leave them for the next flush or the end-of-episode submit.
      trace.flushedChunks = alreadyFlushed;
    });
  } catch {
    // Recording must never interrupt gameplay.
  }
}

function submitTrace(
  trace: StoredOverlayTrace,
  reason: EpisodeEndReason,
  completedScore?: number,
): void {
  if (!settings.recordingWhilePlaying) return;
  try {
    trace.endReason ??= reason;
    trace.endedAtMs ??= Date.now();
    trace.completedScore ??= completedScore;
    persistTrace(trace);
    const chunks = buildOverlayTraceChunks(
      trace,
      trace.endReason,
      appVersion(),
      trace.endedAtMs,
    );
    void invoke("queue_recording_chunks", {
      chunks,
      result: buildOverlayGameResult(trace),
    }).then(() => {
      localStorage.removeItem(`${TRACE_KEY_PREFIX}${trace.gameId}`);
    }).catch(() => {
      // Keep the compact seed/action journal for the next launch.
    });
  } catch {
    // Keep the journal if replay or serialization fails.
  }
}

function recoverTraces(): void {
  const pending: StoredOverlayTrace[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(TRACE_KEY_PREFIX)) continue;
    try {
      pending.push(JSON.parse(localStorage.getItem(key)!) as StoredOverlayTrace);
    } catch {
      // Preserve malformed recovery data for manual inspection.
    }
  }
  for (const trace of pending) submitTrace(trace, trace.endReason ?? "client_closed");
}
let savedGame: SavedGame | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function gameTitle(gameId: string): string {
  return MENU_GAMES.find((item) => item.id === gameId)?.title ?? gameId;
}

function variationTitle(entry: LocalScoreEntry): string {
  if (entry.variation_id === "classic") return "";
  return MENU_GAMES.find((item) => item.id === entry.game_type)?.variations
    .find((variation) => variation.id === entry.variation_id)?.title ?? entry.variation_id;
}

/** Mode label for in-game chrome; omit default single-mode and generic `classic` ids. */
function visibleVariationTitle(entry: GameEntry, variationIndex: number): string | null {
  const variation = entry.variations[variationIndex];
  if (!variation || entry.variations.length === 1) return null;
  if (variation.id === "classic") return null;
  return variation.title;
}

function playingHeadingTitles(entry: GameEntry, variationIndex: number): string {
  const mode = visibleVariationTitle(entry, variationIndex);
  const modeHtml = mode ? `<small class="mode-title">${escapeHtml(mode)}</small>` : "";
  return `<strong class="game-title">${escapeHtml(entry.title)}</strong>${modeHtml}`;
}

function scoreDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Completed run";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function personalBest(gameId: string, currentScore?: number): number | undefined {
  const stored = localScores.personal_bests.find((item) => item.game_type === gameId)?.score;
  return currentScore === undefined ? stored : Math.max(stored ?? currentScore, currentScore);
}

function refreshLocalScores(): void {
  void invoke<LocalScores>("read_local_scores").then((scores) => {
    if (!scores || !Array.isArray(scores.personal_bests) || !Array.isArray(scores.recent) || !Array.isArray(scores.top_scores)) return;
    localScores = scores;
    if (screen === "menu") drawMenu();
    else if (screen === "variations") drawVariations();
    else if (screen === "scores") drawScores();
    else if (screen === "game") drawGame();
  }).catch(() => undefined);
}

function gameCard(item: GameEntry, index: number): string {
  const featured = FEATURED_GAME_IDS.includes(item.id as typeof FEATURED_GAME_IDS[number]);
  const best = personalBest(item.id);
  return `<button type="button" class="game-card${featured ? " featured" : ""}${index === cursor ? " selected" : ""}" data-game-index="${index}">
    <span class="game-icon icon-${item.id}" aria-hidden="true"></span>
    <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small></span>
    <b aria-label="${best === undefined ? "No personal best yet" : `Personal best ${best}`}">${best === undefined ? "Best —" : `Best ${best}`} →</b>
  </button>`;
}

function drawMenu(): void {
  const savedCandidate = savedGame;
  const saved = savedCandidate && MENU_GAMES.some(({ id }) => id === savedCandidate.gameId) ? savedCandidate : null;
  const savedTitle = saved ? MENU_GAMES.find(({ id }) => id === saved.gameId)?.title ?? saved.gameId : "";
  const resume = saved
    ? `<button type="button" class="resume-button" data-resume aria-label="Resume ${escapeHtml(savedTitle)}"><span>Resume</span><strong>${escapeHtml(savedTitle)}</strong></button>`
    : "";
  screenElement.innerHTML = `<section class="arcade-menu">
    <header class="menu-heading"><div><p>Companion mission</p><h1>Tui</h1>${resume}</div><div class="menu-actions"><button type="button" class="scores-button" data-open-how-to-play>? How to Play</button><button type="button" class="scores-button" data-open-settings aria-label="Open settings">Settings</button>${settings.showPersonalScores ? '<button type="button" class="scores-button" data-open-scores>Scores</button>' : ""}</div></header>
    <div class="game-list">${MENU_GAMES.map(gameCard).join("")}</div>
  </section>`;
  screenElement.dataset.screen = "menu";
}

function settingRow(key: keyof ArcadeSettings, label: string, description: string): string {
  const value = settings[key];
  if (typeof value !== "boolean") return `<label class="setting-row"><span><strong>${label}</strong><small>${description}</small></span><select data-setting="${key}"><option value="compact" ${value === "compact" ? "selected" : ""}>Compact</option><option value="expanded" ${value === "expanded" ? "selected" : ""}>Expanded</option></select></label>`;
  return `<label class="setting-row"><span><strong>${label}</strong><small>${description}</small></span><input type="checkbox" data-setting="${key}" ${value ? "checked" : ""} /></label>`;
}

function drawSettings(): void {
  screen = "settings";
  screenElement.innerHTML = `<section class="settings-menu"><header class="menu-heading"><button type="button" id="inline-back" class="inline-back">‹ Games</button><div><p>Arcade preferences</p><h1>Settings</h1></div></header><div class="settings-list">
    ${settingRow("autoOpenOnPrompt", "Auto-open on agent prompt", "Show Tui when you send a prompt.")}
    ${settingRow("autoPauseOnStop", "Auto-pause when agent stops", "Pause the active game at a turn boundary.")}
    ${settingRow("resetOnNewSession", "Reset to menu on new session", "Start each session from the game menu.")}
    ${settingRow("agentBreakSuggestions", "Agent break suggestions", "Allow occasional suggestions to play.")}
    <label class="setting-row"><span><strong>Snooze suggestions</strong><small>Pause suggestions for an hour, day, or week.</small></span><select data-setting="suggestionsSnoozedUntil"><option value="0">Until enabled</option><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option></select></label>
    ${settingRow("defaultWindowSize", "Default window size", "Choose the initial overlay frame.")}
    ${settingRow("resumeLastGame", "Resume last game on open", "Skip the menu when a saved game exists.")}
    ${settingRow("showPersonalScores", "Show personal scores", "Keep the Scores entry in the menu.")}
    ${settingRow("cloudGameplaySync", "Cloud gameplay sync", "Upload recorded games when signed in.")}
    ${settingRow("productAnalytics", "Product analytics", "Allow anonymous product usage events.")}
    ${settingRow("recordingWhilePlaying", "Recording while playing", "Save gameplay traces locally for sync.")}
  </div></section>`;
  screenElement.dataset.screen = "settings";
}

async function loadSettings(): Promise<void> {
  try { settings = { ...DEFAULT_SETTINGS, ...(await invoke<Partial<ArcadeSettings>>("read_settings")) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
  localStorage.setItem("gamepigeon.settings.productAnalytics", String(settings.productAnalytics));
  expanded = settings.defaultWindowSize === "expanded";
  if (settings.reducedMotion !== null) document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
}

function saveSetting(key: string, value: unknown): void {
  if (!(key in settings)) return;
  (settings as unknown as Record<string, unknown>)[key] = value;
  localStorage.setItem("gamepigeon.settings.productAnalytics", String(settings.productAnalytics));
  void invoke("write_settings", { settings: { [key]: value } }).catch(() => undefined);
  if (screen === "settings") drawSettings();
}

function drawGate(): void {
  screen = "gate";
  screenElement.innerHTML = gateMarkup();
  screenElement.dataset.screen = "gate";
  renderAccountChip();
  renderSignInBar();
}

/** Called once a session exists: leave the gate and show the arcade. */
function unlockTui(user: AuthUser): void {
  setSignedInUser(user);
  cursor = -1;
  screen = "menu";
  drawMenu();
  renderAccountChip();
  renderSignInBar();
}

function drawVariations(): void {
  if (!entry) return;
  const selected = entry;
  const best = personalBest(selected.id);
  screenElement.innerHTML = `<section class="variation-menu">
    <header class="menu-heading variation-heading"><button type="button" id="inline-back" class="inline-back">‹ Tui</button><div><p>Choose a room</p><h1>Levels</h1></div><button type="button" class="scores-button" data-open-how-to-play>? How to Play</button></header>
    <div class="variation-list">${selected.variations.map((variation, index) =>
      `<button type="button" class="variation-card${index === variationCursor ? " selected" : ""}" data-variation-index="${index}">
        <span><strong>${escapeHtml(variation.title)}</strong><small>${escapeHtml(variation.description)}</small></span><b>${escapeHtml(variation.goal)}${best === undefined ? "" : `<em>Best ${best}</em>`}</b>
      </button>`,
    ).join("")}</div>
  </section>`;
  screenElement.dataset.screen = "variations";
}

function drawScores(): void {
  screen = "scores";
  const cards = MENU_GAMES.map((game) => {
    const best = personalBest(game.id);
    const runs = localScores.recent.filter((entry) => entry.game_type === game.id);
    return `<article class="leaderboard-card">
      <header><span class="game-icon icon-${game.id}" aria-hidden="true"></span><div><strong>${escapeHtml(game.title)}</strong><small>Personal best</small></div><b>${best ?? "—"}</b></header>
      <ol class="run-list">${runs.map((entry) => {
        const meta = [variationTitle(entry), scoreDate(entry.completed_at)].filter(Boolean).map(escapeHtml).join(" · ");
        return `<li><b>${entry.score}</b><small>${meta}</small></li>`;
      }).join("") || "<li class=empty>Play a run to set your first score.</li>"}</ol>
    </article>`;
  }).join("");
  screenElement.innerHTML = `<section class="scores-menu">
    <header class="menu-heading"><button type="button" id="inline-back" class="inline-back">‹ Games</button><div><h1>Personal Leaderboard</h1></div></header>
    <div class="leaderboard-grid">${cards}</div>
  </section>`;
  screenElement.dataset.screen = "scores";
}

// ── Piece motion ──────────────────────────────────────────────────────
//
// Boards are patched in place rather than re-rendered, and every animation is
// a short-lived class on the cells that actually changed. Classes are cleared
// on a timer instead of `animationend` so `prefers-reduced-motion` — which
// collapses durations to ~0 — still shows the static markers defined in
// index.html for the same beat.

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Write the HUD's `<strong>` values left to right, skipping unchanged ones. */
function setHud(values: readonly string[]): void {
  const spans = screenElement.querySelectorAll<HTMLElement>(".game-hud span strong");
  values.forEach((value, index) => {
    const el = spans[index];
    if (el) setText(el, value);
  });
}

/**
 * The arena draws itself entirely on the canvas, so the in-place update is
 * one hand-off of the playable view — clock, feed, waiting parties and the
 * open decision included.
 */
function arenaView(activeGame: PlayableGame): RestaurantArenaState {
  const withView = activeGame as PlayableGame & { view?: () => unknown };
  return (withView.view ? withView.view() : activeGame.state()) as RestaurantArenaState;
}

function updateRestaurantArena(activeGame: PlayableGame): boolean {
  const mount = screenElement.querySelector<HTMLElement>("[data-phaser-mount]");
  if (!mount) return false;
  restaurantArenaScene?.render(arenaView(activeGame));
  refreshInterventionPanel(activeGame);
  return true;
}

// ── Player intervention panel ────────────────────────────────────────
//
// The only piece of arena chrome in the DOM rather than on the canvas:
// natural-language guidance needs a real text input, which Phaser has no
// primitive for. Every control here ends in `submitIntervention`, which
// routes through `RestaurantGame.submitPlayerIntervention` — the same
// validated `ActionEnvelope` boundary a worker's own actions go through —
// so player text can never reach `currentState` directly.

function interveneEls() {
  return {
    toggle: screenElement.querySelector<HTMLButtonElement>("[data-arena-intervene-toggle]"),
    panel: screenElement.querySelector<HTMLElement>("[data-arena-intervene-panel]"),
    close: screenElement.querySelector<HTMLButtonElement>("[data-arena-intervene-close]"),
    roles: screenElement.querySelector<HTMLElement>("[data-arena-intervene-roles]"),
    text: screenElement.querySelector<HTMLTextAreaElement>("[data-arena-intervene-text]"),
    urgent: screenElement.querySelector<HTMLInputElement>("[data-arena-intervene-urgent]"),
    send: screenElement.querySelector<HTMLButtonElement>("[data-arena-intervene-send]"),
    tickets: screenElement.querySelector<HTMLElement>("[data-arena-intervene-tickets]"),
    correct: screenElement.querySelector<HTMLButtonElement>("[data-arena-intervene-correct]"),
    approve: screenElement.querySelector<HTMLElement>("[data-arena-intervene-approve]"),
    status: screenElement.querySelector<HTMLElement>("[data-arena-intervene-status]"),
    budget: screenElement.querySelector<HTMLElement>("[data-arena-intervene-budget]"),
    pass: screenElement.querySelector<HTMLButtonElement>("[data-arena-intervene-pass]"),
  };
}

function setInterveneStatus(message: string, tone: "ok" | "error" = "ok"): void {
  const { status } = interveneEls();
  if (!status) return;
  status.textContent = message;
  if (tone === "error") status.dataset.tone = "error";
  else delete status.dataset.tone;
}

function workerModelLabel(): string {
  if (!workerModel) return "Deterministic crew · live model unavailable";
  return `${workerModel.provider} · ${workerModel.name}${workerModel.version ? ` · ${workerModel.version}` : ""}`;
}

/**
 * What the shared model account is doing to this shift, and the timer that
 * takes the banner down if the transport goes quiet. A throttle gets no
 * follow-up report -- the next request simply happens later -- so the
 * countdown is what clears it.
 */
let workerBudget: WorkerBudgetState = WORKER_BUDGET_CLEAR;
let workerBudgetTimer: ReturnType<typeof setTimeout> | undefined;

function setWorkerBudget(state: WorkerBudgetState): void {
  workerBudget = state;
  if (workerBudgetTimer !== undefined) clearTimeout(workerBudgetTimer);
  workerBudgetTimer = undefined;
  const message = workerBudgetMessage(state, workerModelLabel());
  if (!message) {
    setWorkerMode();
    return;
  }
  setWorkerMode(message, "waiting");
  workerBudgetTimer = setTimeout(() => setWorkerBudget(WORKER_BUDGET_CLEAR), workerBudgetHoldMs(state));
}

function setWorkerMode(message = workerModelLabel(), tone: "live" | "pending" | "waiting" | "error" | undefined = workerModel ? "live" : undefined): void {
  const status = screenElement.querySelector<HTMLElement>("[data-arena-worker-mode]");
  if (!status) return;
  status.textContent = message;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

function setWorkerStatus(role: Role | "expediter", status: "idle" | "thinking" | "acting" | "error"): void {
  restaurantArenaScene?.setWorkerStatus(role, status);
}

function addWorkerActivity(message: string): void {
  workerActivity.unshift(message);
  workerActivity.splice(8);
  const feed = screenElement.querySelector<HTMLOListElement>("[data-arena-worker-activity]");
  if (!feed) return;
  feed.replaceChildren(...workerActivity.map((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    return item;
  }));
}

function stopWorkerOrchestrator(): void {
  workerOrchestrator?.stop();
  workerOrchestrator = undefined;
  // Leaving the shift ends the wait it described; a banner counting down over
  // the menu would be describing requests nobody is making.
  if (workerBudgetTimer !== undefined) clearTimeout(workerBudgetTimer);
  workerBudgetTimer = undefined;
  workerBudget = WORKER_BUDGET_CLEAR;
}

interface WorkerModelResponse {
  text: string;
  queueMs: number;
  providerMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  finishReason?: string;
}

/** Absent provider fields (no usage on this response) stay absent, not zero. */
function workerModelMetrics(response: WorkerModelResponse): ModelCallMetrics {
  return {
    queueMs: response.queueMs,
    providerMs: response.providerMs,
    ...(response.inputTokens !== undefined ? { inputTokens: response.inputTokens } : {}),
    ...(response.outputTokens !== undefined ? { outputTokens: response.outputTokens } : {}),
    ...(response.cachedInputTokens !== undefined ? { cachedInputTokens: response.cachedInputTokens } : {}),
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
  };
}

function attachWorkerOrchestrator(activeGame: PlayableGame): void {
  if (!workerModel || activeGame.name !== "restaurant-arena") return;
  workerActivity.length = 0;
  const arena = activeGame as unknown as RestaurantGame;
  const client = new WorkerModelClient({
    retries: 0,
    // The Rust transport bounds the provider call and starts that bound after
    // the request budget admits it, so queue time is not charged to the
    // worker. A timer here would start while the request is still in line and
    // abort a crew that is only waiting its turn.
    timeoutMs: null,
    complete: async (request: ModelRequest, signal: AbortSignal) => {
      const role = request.observation.role;
      const startedAt = performance.now();
      setWorkerStatus(role, "thinking");
      // A request already queued behind the account's share is not pending on
      // the model; the budget banner is the more specific thing to say. The
      // activity feed still logs the request either way -- it is a log of what
      // happened, not a description of the current state.
      if (shouldReportFallback(workerBudget)) setWorkerMode(`Pending · ${workerModelLabel()} · ${role}`, "pending");
      addWorkerActivity(`${role}: requested live action`);
      const requestId = crypto.randomUUID();
      const cancel = () => void invoke("cancel_worker_model", { requestId });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const response = await invoke<WorkerModelResponse>("complete_worker_model", {
          requestId,
          request: { systemPrompt: request.systemPrompt, turnPrompt: request.turnPrompt },
        });
        if (signal.aborted) throw new Error("model request canceled");
        setWorkerStatus(role, "acting");
        addWorkerActivity(`${role}: response received in ${Math.round(performance.now() - startedAt)}ms`);
        return { text: response.text, metrics: workerModelMetrics(response) };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
  let orchestrator: WorkerOrchestrator;
  orchestrator = new WorkerOrchestrator(arena, {
    client,
    model: workerModel,
    tickIntervalMs: () => arena.tickMs() || 1_000,
    onError: (turn) => {
      if (workerOrchestrator !== orchestrator) return;
      setWorkerStatus(turn.role, "error");
      addWorkerActivity(`${turn.role}: fallback — ${turn.error ?? "invalid action"}`);
      // A shift held back by the shared account is waiting, not broken (#281).
      // Only the banner is suppressed; the feed above still records the turn.
      if (!shouldReportFallback(workerBudget)) return;
      setWorkerMode(`Fallback · ${workerModelLabel()} · ${turn.role}: ${turn.error ?? "invalid action"}`, "error");
    },
    onTick: (report: OrchestratorTick) => {
      if (workerOrchestrator !== orchestrator || game !== activeGame) return;
      for (const turn of report.turns) {
        if (turn.status === "accepted") {
          setWorkerStatus(turn.role, "acting");
          addWorkerActivity(`${turn.role}: applied ${turn.action?.tool ?? "action"}`);
        }
        else if (turn.status === "fallback" || turn.status === "rejected") setWorkerStatus(turn.role, "error");
      }
      // Turns landing again is proof the account is answering, whatever the
      // last throttle said was left on its countdown.
      if (report.turns.every((turn) => turn.status === "accepted")) setWorkerBudget(WORKER_BUDGET_CLEAR);
      drawGame();
    },
  });
  workerOrchestrator = orchestrator;
}

/** Every control funnels through here — the panel's only write path. */
function submitIntervention(input: PlayerInterventionInput): void {
  if (!game) return;
  const withIntervene = game as PlayableGame & {
    submitPlayerIntervention?: (i: PlayerInterventionInput) => { accepted: boolean; error?: { message: string } };
  };
  if (!withIntervene.submitPlayerIntervention) return;
  workerOrchestrator?.pause();
  const result = withIntervene.submitPlayerIntervention(input);
  if (result.accepted) {
    setInterveneStatus("Sent.");
  } else {
    setInterveneStatus(result.error?.message ?? "Could not send that.", "error");
  }
  // A rejected stale/invalid intervention must not strand live workers in the
  // paused state either; drawGame() re-enters the selected scheduler.
  drawGame();
}

/** Wire the static shell once per mount; content refreshes in place after. */
function bindInterventionPanel(): void {
  const els = interveneEls();
  if (!els.toggle || !els.panel) return;
  interveneRole = "chef";

  els.toggle.addEventListener("click", () => {
    const opening = els.panel!.hidden;
    els.panel!.hidden = !opening;
    els.toggle!.setAttribute("aria-expanded", String(opening));
    if (opening && game) refreshInterventionPanel(game);
  });
  els.close?.addEventListener("click", () => {
    els.panel!.hidden = true;
    els.toggle!.setAttribute("aria-expanded", "false");
  });
  els.roles?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-role]");
    if (!target?.dataset.role) return;
    interveneRole = target.dataset.role as PlayerInterventionInput["targetRole"];
    els.roles!.querySelectorAll<HTMLButtonElement>("[data-role]").forEach((btn) => btn.classList.toggle("is-selected", btn === target));
  });
  els.send?.addEventListener("click", () => {
    const text = els.text?.value.trim() ?? "";
    if (!text) {
      setInterveneStatus("Say something first.", "error");
      return;
    }
    submitIntervention({ kind: "message", targetRole: interveneRole, text, priority: els.urgent?.checked ? "high" : "normal" });
    if (els.text) els.text.value = "";
    if (els.urgent) els.urgent.checked = false;
  });
  els.correct?.addEventListener("click", () => {
    submitIntervention({ kind: "correction", targetRole: interveneRole });
  });
  // Passing is a decision, so it goes on the record like any other. Doing
  // nothing and choosing to do nothing read identically in a trace otherwise.
  els.pass?.addEventListener("click", () => {
    if (!game) return;
    const withPass = game as PlayableGame & { passRound?: () => { accepted: boolean; error?: { message: string } } };
    if (!withPass.passRound) return;
    workerOrchestrator?.pause();
    const result = withPass.passRound();
    setInterveneStatus(result.accepted ? "Round passed." : result.error?.message ?? "Could not pass.", result.accepted ? "ok" : "error");
    drawGame();
  });
  els.tickets?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-order-id]");
    if (!target || target.hasAttribute("data-already-high")) return;
    submitIntervention({ kind: "priority", targetRole: interveneRole, orderId: target.dataset.orderId!, priority: "high" });
  });
  els.approve?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-decision-id]");
    if (!target?.dataset.decisionId || !target.dataset.optionId) return;
    submitIntervention({
      kind: "approve",
      targetRole: (target.dataset.speakerRole as PlayerInterventionInput["targetRole"]) ?? interveneRole,
      decisionId: target.dataset.decisionId,
      optionId: target.dataset.optionId,
    });
  });
}

/** Refill the ticket list and the approve/deny section from the live view — never the message box, so an in-progress draft survives a tick. */
function refreshInterventionPanel(activeGame: PlayableGame): void {
  if (activeGame.name !== "restaurant-arena") return;
  const els = interveneEls();
  if (!els.panel) return;
  const view = arenaView(activeGame);

  const live = (view.orders ?? []).filter((order) => order.status !== "served" && order.status !== "cancelled");
  if (els.tickets) {
    els.tickets.innerHTML = live.length
      ? live
          .map((order) => {
            const label = (order.tableId ?? order.id).replace("table-", "T");
            const alreadyHigh = order.priority === "high";
            return `<button type="button" class="arena-intervene-ticket" data-order-id="${order.id}"${alreadyHigh ? " data-already-high" : ""}>${label} · ${order.items.join("+") || "—"}${alreadyHigh ? " (high)" : ""}</button>`;
          })
          .join("")
      : `<span class="arena-intervene-empty">No live tickets.</span>`;
  }

  // The round budget (#262). The engine owns it; the panel only reports it,
  // so the human manager and the model manager cannot drift apart.
  const withRounds = activeGame as PlayableGame & { roundStatus?: () => RoundStatus };
  const round = withRounds.roundStatus?.();
  if (round && els.budget) {
    els.budget.textContent = round.canAct
      ? `Round ${round.round} of ${round.totalRounds} — 1 action left`
      : `Round ${round.round} of ${round.totalRounds} — spent, the floor runs itself now`;
    els.budget.dataset.spent = String(!round.canAct);
  }
  if (round) {
    // A spent round closes every write control at once. The keyboard hits the
    // same budget inside the engine, so there is no shortcut around this.
    for (const control of [els.send, els.correct, els.pass]) {
      if (control) control.disabled = !round.canAct;
    }
    if (els.text) els.text.disabled = !round.canAct;
    els.tickets?.querySelectorAll("button").forEach((button) => {
      (button as HTMLButtonElement).disabled = !round.canAct;
    });
  }

  if (els.approve) {
    const decision = view.decision;
    if (decision) {
      els.approve.hidden = false;
      els.approve.innerHTML =
        `<p class="arena-intervene-label">${decision.speaker} needs a call — ${decision.title}</p>` +
        decision.options
          .map(
            (option) =>
              `<button type="button" class="arena-intervene-approve-option" data-tone="${option.tone}" data-decision-id="${decision.id}" data-option-id="${option.id}" data-speaker-role="${decision.speakerRole}">${option.label}</button>`,
          )
          .join("");
    } else {
      els.approve.hidden = true;
      els.approve.innerHTML = "";
    }
  }
}

/**
 * The header's personal best climbs with the live score, so it has to be
 * refreshed on the in-place path too — `renderGameScreen` only runs on launch.
 */
function setPersonalBest(): void {
  if (!game || !entry) return;
  const el = screenElement.querySelector<HTMLElement>(".playing-heading .personal-best");
  if (!el) return;
  const best = personalBest(entry.id, game.score());
  el.hidden = !best;
  if (best) setText(el, `Personal best ${best}`);
}

/**
 * Full repaint — only for entering a game, since it drops every animation.
 * Restaurant Arena draws its own transport controls, HUD and now its own
 * menu/restart on the canvas (see the hotspot() comment in the scene), so it
 * gets no DOM header at all — that chrome would just double up on-canvas
 * controls the player already has.
 */
function renderGameScreen(): void {
  if (!game || !entry) return;
  restaurantArenaScene?.destroy();
  restaurantArenaScene = undefined;
  const isArena = game.name === "restaurant-arena";
  const best = personalBest(entry.id, game.score());
  const header = isArena
    ? ""
    : `<header class="playing-heading"><button type="button" id="inline-back" class="inline-back">‹ Menu</button><div>${playingHeadingTitles(entry, variationCursor)}${replaying ? '<small class="mode-title">Replay</small>' : ""}<small class="personal-best"${best ? "" : " hidden"}>Personal best ${best ?? ""}</small></div><button type="button" data-restart aria-label="Restart game">↻ Restart</button></header>`;
  screenElement.innerHTML = `${header}${renderNativeGame(game)}`;
  screenElement.dataset.screen = "game";
  screenElement.dataset.game = game.name;
  const mount = screenElement.querySelector<HTMLElement>("[data-phaser-mount]");
  if (mount && isArena) {
    const mountScene = () => {
      if (!mount.isConnected || !game || game.name !== "restaurant-arena") return;
      restaurantArenaScene = mountRestaurantArenaScene(
        mount,
        arenaView(game),
        (action) => performAction(action),
        () => {},
      );
      bindInterventionPanel();
      refreshInterventionPanel(game);
      setWorkerMode();
    };
    // Let the flex/grid layout settle so Phaser boots at the real stage size,
    // not a half-laid-out box that leaves the floor painted in a corner.
    requestAnimationFrame(() => requestAnimationFrame(mountScene));
  }
}

function drawGame(): void {
  if (!game || !entry) return;
  const patch = screenElement.dataset.game === "restaurant-arena" ? updateRestaurantArena : undefined;
  if (!patch?.(game)) {
    renderGameScreen();
    return;
  }
  setPersonalBest();
}


interface ArenaDebrief {
  grade: string;
  headline: string;
  met: boolean;
  targets?: { label: string; value: string; requirement: string; met: boolean }[];
  lines: { label: string; value: string; good: boolean }[];
  lessons: string[];
}

/** The service report: what the shift scored, and what to fix next run. */
function getArenaDebriefHtml(): string {
  if (!game || game.name !== "restaurant-arena") return "";
  const view = arenaView(game) as unknown as { debrief?: ArenaDebrief };
  const debrief = view.debrief;
  if (!debrief) return "";
  // Whatever the target checks already reported is dropped here: showing
  // "Takings $96" twice, once as a verdict and once as a stat, made the card
  // longer without making it say more.
  const checked = new Set((debrief.targets ?? []).map((target) => target.label.toLowerCase()));
  const lines = debrief.lines
    .filter((line) => !checked.has(line.label.toLowerCase()))
    .map(
      (line) =>
        `<span class="debrief-stat${line.good ? " is-good" : ""}"><small>${escapeHtml(line.label)}</small><strong>${escapeHtml(line.value)}</strong></span>`,
    )
    .join("");
  const lessons = debrief.lessons.map((lesson) => `<li>${escapeHtml(lesson)}</li>`).join("");
  // The verdict names which condition decided it. `lines` below are a
  // read-at-a-glance summary of the shift on their own thresholds, which are
  // not tonight's pass bar — keeping the two apart is what stops a green
  // "Walkouts 2" from sitting under a MISSED verdict it actually caused.
  const targets = (debrief.targets ?? [])
    .map(
      (target) =>
        `<li class="debrief-check${target.met ? " is-met" : ""}">` +
        `<span class="check-mark">${target.met ? "met" : "miss"}</span>` +
        `<span class="check-label">${escapeHtml(target.label)}</span>` +
        `<span class="check-value">${escapeHtml(target.value)}</span>` +
        `<span class="check-req">needs ${escapeHtml(target.requirement)}</span>` +
        `</li>`,
    )
    .join("");
  return `
    <div class="arena-debrief"${debrief.met ? ' data-met="yes"' : ""}>
      <p class="debrief-scope">Local gameplay summary · not an official evaluation</p>
      <p class="debrief-target">${debrief.met ? "LOCAL TARGET MET" : "LOCAL TARGET MISSED"}</p>
      <p class="debrief-grade"><strong>${escapeHtml(debrief.grade)}</strong> ${escapeHtml(debrief.headline)}</p>
      ${targets ? `<p class="debrief-criteria">Local target checks</p><ul class="debrief-checks">${targets}</ul>` : ""}
      <p class="debrief-criteria">Raw operational facts</p>
      <div class="debrief-stats">${lines}</div>
      <p class="debrief-caveat">No wait figure: the engine derives only a whole-shift clock reading, not an arrival-to-seat measurement.</p>
      <ul class="debrief-lessons">${lessons}</ul>
    </div>`;
}

/**
 * The evidence receipt: what the shift actually recorded, counted off the
 * run's own journal — the same events `Export Trace` writes out as
 * restaurant-arena-trace/v3.
 *
 * Split by who authored each event, because that split is the whole point of
 * the export: what the house did on its own (`system`) has to stay separable
 * from what the manager handed over (`player`) and what the workers did with
 * it. Every number here is counted, never estimated, and nothing is
 * attributed to a model that did not stamp the event itself.
 */
function getArenaEvidenceHtml(): string {
  if (!game || game.name !== "restaurant-arena") return "";
  const journal = game as unknown as { getRecordedEvents?: () => { actorId?: string; model?: unknown; toolResult?: { ok?: boolean } | null }[] };
  if (typeof journal.getRecordedEvents !== "function") return "";
  let events: { actorId?: string; model?: unknown; toolResult?: { ok?: boolean } | null }[];
  try {
    events = journal.getRecordedEvents();
  } catch (err) {
    console.error("Failed to read the arena event journal:", err);
    return "";
  }
  const system = events.filter((event) => event.actorId === "system").length;
  const manager = events.filter((event) => event.actorId === "player").length;
  const worker = events.length - system - manager;
  const rejected = events.filter((event) => event.toolResult?.ok === false).length;
  const modelStamped = events.filter((event) => event.model !== undefined && event.model !== null).length;
  // Only the authorship split gets tiles — that split is what the export is
  // for. The rest is one line, because a six-tile grid made a footnote look
  // like a scoreboard.
  const rows: [string, string][] = [
    ["System", `${system}`],
    ["Your handover", `${manager}`],
    ["Worker turns", `${worker}`],
  ];
  return `
    <div class="arena-evidence">
      <p class="debrief-criteria">${events.length} recorded events · exported by <code>Export Trace</code></p>
      <div class="evidence-stats">${rows
        .map(([label, value]) => `<span class="evidence-stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`)
        .join("")}</div>
      <p class="debrief-caveat">${rejected} rejected call${rejected === 1 ? "" : "s"} · ${modelStamped} stamped by a model. Counted from this run&rsquo;s journal, never inferred.</p>
    </div>`;
}

/**
 * The session id, on screen, at the end of the shift.
 *
 * Retrieving one person's contributed session means matching what they played
 * against what arrived (#281), and until now nothing on screen named the run:
 * the id existed only inside the exported file and the chunk stream. A tester
 * on their own machine had nothing to quote back.
 */
function sessionReceiptHtml(): string {
  if (!sessionReceiptId) return "";
  return `
    <p class="session-receipt">
      <small>Session ID</small>
      <code data-session-id>${escapeHtml(sessionReceiptId)}</code>
    </p>`;
}

/** Decision and correction timeline viewer for the shift end-screen. */
function getArenaTimelineHtml(): string {
  if (!game || game.name !== "restaurant-arena") return "";
  try {
    const timeline = buildArenaTimeline(game as unknown as RestaurantGame);
    return renderTimelineHtml(timeline);
  } catch (err) {
    console.error("Failed to build arena timeline:", err);
    return "";
  }
}

/** Export the raw restaurant-arena-trace-v3 JSON or JSONL file. */
function exportCurrentTrace(format: "json" | "jsonl" = "json"): void {
  if (!game || game.name !== "restaurant-arena") return;
  try {
    // A shift played in the overlay is live gameplay by definition; synthetic
    // and benchmark traces are produced by scripts/export-arena-trace.ts.
    const trace = captureArenaTrace(game as unknown as RestaurantGame, {
      runKind: "live",
      ...(sessionReceiptId ? { sessionId: sessionReceiptId } : {}),
    });
    const content = format === "jsonl" ? exportTraceJsonl(trace) : exportTraceJson(trace);
    // Named by session, not episode: `episodeId` is the scenario, so every
    // run of the same seed used to download over the last one (#281).
    const filename = `restaurant-arena-trace-${trace.sessionId ?? trace.episodeId}.${format === "jsonl" ? "jsonl" : "json"}`;
    const mimeType = format === "jsonl" ? "application/x-ndjson" : "application/json";
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const btn = screenElement.querySelector<HTMLButtonElement>('[data-action="export-trace"]');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = "Exported!";
      setTimeout(() => {
        if (btn) btn.innerHTML = orig;
      }, 2000);
    }
  } catch (err) {
    console.error("Failed to export trace:", err);
  }
}

function moveMenuCursor(delta: number): void {
  if (cursor === -1) {
    cursor = delta > 0 ? 0 : MENU_GAMES.length - 1;
  } else {
    cursor = (cursor + delta + MENU_GAMES.length) % MENU_GAMES.length;
  }
  drawMenu();
  screenElement.querySelector<HTMLButtonElement>(`[data-game-index="${cursor}"]`)?.focus();
}

function handleMenuKey(key: Key): void {
  if (key === "up" || key === "left") moveMenuCursor(-1);
  else if (key === "down" || key === "right") moveMenuCursor(1);
  else if (key === "enter") chooseGame(cursor);
  else if (key === "quit") void windowHandle.hide();
  else if (typeof key === "object" && key.char.toLowerCase() === "g") drawSettings();
}

function chooseGame(index: number): void {
  const selected = MENU_GAMES[index];
  if (!selected || !isPlayable(selected)) return;
  cursor = index;
  entry = selected;
  variationCursor = 0;
  screen = "variations";
  drawVariations();
}

function handleVariationKey(key: Key): void {
  if (!entry) return;
  if (key === "up" || key === "left") variationCursor = (variationCursor - 1 + entry.variations.length) % entry.variations.length;
  else if (key === "down" || key === "right") variationCursor = (variationCursor + 1) % entry.variations.length;
  else if (key === "quit") { screen = "menu"; drawMenu(); return; }
  drawVariations();
}

function handleScoresKey(key: Key): void {
  if (key === "quit") {
    screen = "menu";
    drawMenu();
  }
}

function handleSettingsKey(key: Key): void {
  if (key === "quit") { screen = "menu"; drawMenu(); }
}

function genericAction(key: Key): string | null {
  if (!game) return null;
  const raw = typeof key === "string" ? key : key.char === " " ? "space" : key.char.toLowerCase();
  const action = game.keymap?.[raw] ?? raw;
  return (game.actions as readonly string[]).includes(action) ? action : null;
}


function performAction(action: string): boolean {
  if (!game || replaying || game.isOver() || !(game.actions as readonly string[]).includes(action)) return false;
  workerOrchestrator?.pause();
  const result = stepGame(
    action,
    action === "tick" || action === "bot_move" ? "environment" : "human",
  );
  actionsTaken++;

  drawGame();
  return result.moved;
}

function stepGame(action: string, actor: TraceActor): StepResult {
  if (!game) throw new Error("No active game");
  const result = game.step(action);
  if (activeTrace) {
    appendOverlayAction(activeTrace, action, actor);
    persistTrace(activeTrace);
    scheduleTraceFlush(activeTrace);
  }
  return result;
}

/** Mirror the physical key on its matching on-screen control, if any. */
function setControlPressed(action: string, pressed: boolean): void {
  screenElement.querySelector(`.control[data-action="${action}"]`)?.classList.toggle("key-pressed", pressed);
}

function handleGameKey(key: Key): void {
  if (!game) return;
  if (game.isOver()) return;
  const action = genericAction(key);
  if (action) {
    performAction(action);
    setControlPressed(action, true);
  }
}

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable=\"true\"]")) return;
  if (screen === "gate") {
    // Block menu/game input until signed in; Enter starts sign-in.
    if (event.key === "Enter") { event.preventDefault(); void beginSignIn(); }
    return;
  }
  const key = browserKey(event);
  if (!key) return;
  event.preventDefault();
  if (screen === "menu") handleMenuKey(key);
  else if (screen === "variations") handleVariationKey(key);
  else if (screen === "scores") handleScoresKey(key);
  else if (screen === "settings") handleSettingsKey(key);
  else handleGameKey(key);
});

window.addEventListener("keyup", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select, [contenteditable=\"true\"]")) return;
  if (screen !== "game" || !game) return;
  const key = browserKey(event);
  if (!key) return;
  const action = genericAction(key);
  if (action) setControlPressed(action, false);
});

screenElement.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button,input,select");
  if (!target) return;
  if (screen === "gate") {
    // gateMarkup() renders these buttons after this listener is bound, so
    // they can only be reached through delegation here.
    if (target.id === "auth-signin") void beginSignIn();
    else if (target.id === "auth-signin-cancel") {
      void cancelSignIn();
    } else if (target.id === "auth-copy-link") {
      void copySignInUrl().then((copied) => {
        target.textContent = copied ? "Copied" : "Press ⌘C";
        window.setTimeout(() => { target.textContent = "Copy link"; }, 2_000);
      });
    }
    return;
  }
  if (target.id === "inline-back") {
    if (screen === "variations" || screen === "scores" || screen === "settings") { screen = "menu"; drawMenu(); }
    return;
  }
  if (target.hasAttribute("data-open-settings")) return drawSettings();
  if (target.hasAttribute("data-open-scores")) return drawScores();
  if (target.dataset.setting) {
    const raw = target instanceof HTMLInputElement ? target.checked : (target as HTMLSelectElement).value;
    const value = target.dataset.setting === "suggestionsSnoozedUntil"
      ? (raw === "0" ? null : Date.now() + Number(raw) * 60 * 60 * 1000) : raw;
    return saveSetting(target.dataset.setting, value);
  }
  if (target.dataset.gameIndex) return chooseGame(Number(target.dataset.gameIndex));
  if (target.dataset.action === "export-trace") return void exportCurrentTrace("json");
  if (target.dataset.action === "export-trace-jsonl") return void exportCurrentTrace("jsonl");
  if (target.dataset.action) performAction(target.dataset.action);
});

window.addEventListener(WORKER_BUDGET_EVENT, (event) => {
  const state = readWorkerBudgetSignal((event as CustomEvent<unknown>).detail);
  if (state) setWorkerBudget(state);
});

document.querySelector("#account-chip")?.addEventListener("click", () => {
  if (!isSignedIn()) void beginSignIn();
});
// The gate's sign-in button is handled by the screen click delegation above,
// since it isn't in the DOM yet at bind time.

bindUpdateBanner();
void refreshUpdateBanner();

void loadSettings().then(async () => {
  workerModel = await invoke<TraceV3Model | undefined>("read_worker_model_config").catch(() => undefined);
  captureOverlayEvent("app.opened", { app_version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.2.0", platform: "overlay" });

  if (!isTauri()) {
    if (new URLSearchParams(window.location.search).get("scores") === "demo") localScores = PREVIEW_SCORES;
    const saved = loadSavedGame();
    savedGame = saved?.ownerId === "" ? saved : undefined;
    screen = "menu";
    drawMenu();
    refreshLocalScores();
  } else {
    void loadAuthSession().then((user) => {
      if (user) {
        const saved = loadSavedGame();
        savedGame = saved?.ownerId === user.id ? saved : undefined;
        unlockTui(user);
        void invoke<string | null>("read_sync_error").then(setSyncError).catch(() => {});
        refreshLocalScores();
        recoverTraces();
      }
      else drawGate();
    });
  }
});

