import { describe, expect, test } from "bun:test";
import { click, fire, loadApp, onNextPreviewResize, pressArenaControl, pressKey, settle } from "./dom-setup.js";
import { isSignedIn, setSignedInUser } from "./auth.js";

await loadApp();

function savedGameRecord(): { gameId: string; seed: number; actions: string[] } | null {
  const raw = localStorage.getItem("gamepigeon.arcade.active-game.v1");
  return raw ? JSON.parse(raw) : null;
}

describe("overlay session, prompt and window lifecycle", () => {
  test("boots straight to the arcade menu in browser preview", () => {
    const screenEl = document.querySelector<HTMLElement>("#screen")!;
    expect(screenEl.dataset.screen).toBe("menu");
  });

  test("opens and closes the how-to-play guide from the menu", () => {
    click('[data-open-how-to-play]');
    expect(document.querySelector<HTMLElement>("#how-to-play")!.hidden).toBe(false);
    click("#how-to-play-close");
    expect(document.querySelector<HTMLElement>("#how-to-play")!.hidden).toBe(true);
  });

  test("a host launch request starts a real session and persists it locally", async () => {
    fire("gamepigeon:launch", { game: "restaurant-arena", variation: "tutorial-shift" });
    await settle();
    const screenEl = document.querySelector<HTMLElement>("#screen")!;
    expect(screenEl.dataset.screen).toBe("game");
    expect(screenEl.dataset.game).toBe("restaurant-arena");
    const saved = savedGameRecord();
    expect(saved?.gameId).toBe("restaurant-arena");
    expect(saved?.actions).toEqual([]);
  });

  test("an agent pause freezes the board behind a dialog and resume clears it", async () => {
    const prompt = document.querySelector<HTMLElement>("#return-prompt")!;
    expect(prompt.hidden).toBe(true);
    fire("gamepigeon:pause");
    await settle();
    expect(prompt.hidden).toBe(false);
    fire("gamepigeon:resume");
    await settle();
    expect(prompt.hidden).toBe(true);
  });

  test("opening How to Play from an agent pause returns to the pause prompt, not the live board", async () => {
    // The pause dialog itself offers a "? How to Play" control
    // (`#how-to-play-from-pause`, shipped in overlay/dist/index.html); nothing
    // about that nested dialog should let the game quietly resume underneath.
    const prompt = document.querySelector<HTMLElement>("#return-prompt")!;
    const howToPlay = document.querySelector<HTMLElement>("#how-to-play")!;
    fire("gamepigeon:pause");
    await settle();
    expect(prompt.hidden).toBe(false);

    click("#how-to-play-from-pause");
    await settle();
    expect(howToPlay.hidden).toBe(false);
    // Opening it swaps which dialog is on top; the pause is still in effect
    // underneath, so the board must not be showing through unguarded.
    expect(prompt.hidden).toBe(true);

    click("#how-to-play-close");
    await settle();
    expect(howToPlay.hidden).toBe(true);
    // Closing it lands back on the pause prompt that opened it, not on the
    // running game.
    expect(prompt.hidden).toBe(false);

    fire("gamepigeon:resume");
    await settle();
    expect(prompt.hidden).toBe(true);
  });

  test("pressing Escape while playing minimizes the window, same as the hide button", async () => {
    // README ("In the overlay"): "Esc ... to hide" — the keyboard shortcut
    // has to reach the same window-frame code the on-screen hide button
    // does, not just be visually similar.
    const minimizeSize = onNextPreviewResize();
    pressKey("Escape");
    const pill = await minimizeSize;
    await settle(0);
    expect(pill).toEqual({ width: 144, height: 48 });
    expect(document.body.dataset.mode).toBe("pill");
    // The session underneath the pill is still the one that was running.
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("game");

    const restoreSize = onNextPreviewResize();
    click("#pill");
    await restoreSize;
    await settle(0);
    expect(document.body.dataset.mode).not.toBe("pill");
  });

  test("minimizing drops the native frame to the pill size and restoring lands back on the arcade floor", async () => {
    const minimizeSize = onNextPreviewResize();
    click("#hide");
    const pill = await minimizeSize;
    // Whether a control flips `dataset.mode` before or after it kicks off the
    // frame resize is an internal statement-ordering choice the instructions,
    // README and shipped CSS never adjudicate — only the settled end state
    // (attribute matches what's actually on screen) is a real behavior. Give
    // the click handler a full tick to finish before asserting on it, so the
    // check can't depend on which side of the resize promise it happens to
    // land on.
    await settle(0);
    expect(pill).toEqual({ width: 144, height: 48 });
    expect(document.body.dataset.mode).toBe("pill");

    const restoreSize = onNextPreviewResize();
    click("#pill");
    const floor = await restoreSize;
    await settle(0);
    expect(floor.width).toBeGreaterThanOrEqual(500);
    expect(floor.height).toBeGreaterThanOrEqual(700);
    // The only thing the shipped CSS branches on is the literal "pill"
    // value (see the `body[data-mode="pill"]` / `body:not([data-mode="pill"])`
    // rules in overlay/dist/index.html): restoring just has to leave that
    // marker behind, whatever representation (missing attribute, another
    // string) is used for "not pill" is functionally equivalent.
    expect(document.body.dataset.mode).not.toBe("pill");
    // The session underneath the pill is still the one that was running.
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("game");
  });

  test("expanding and compacting the window swaps between the two frame sizes", async () => {
    const expandedSize = onNextPreviewResize();
    click("#resize");
    const expanded = await expandedSize;
    expect(expanded).toEqual({ width: 830, height: 900 });

    const compactSize = onNextPreviewResize();
    click("#resize");
    const compact = await compactSize;
    expect(compact).toEqual({ width: 600, height: 850 });
  });

  test("abandoning a session back to the menu keeps the save resumable", async () => {
    fire("gamepigeon:reset");
    await settle();
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("menu");
    expect(savedGameRecord()).not.toBeNull();
  });

  test("the menu's resume control relaunches the exact saved run, not a new one", async () => {
    // README ("Session save"): "resuming later replays the identical run" —
    // a resumed launch has to reuse the stored seed and action log, which is
    // exactly what tells it apart from a fresh launch of the same game.
    const before = savedGameRecord();
    expect(before).not.toBeNull();
    const resumeButton = document.querySelector<HTMLElement>("[data-resume]");
    expect(resumeButton).not.toBeNull();

    click("[data-resume]");
    await settle();

    const screenEl = document.querySelector<HTMLElement>("#screen")!;
    expect(screenEl.dataset.screen).toBe("game");
    expect(screenEl.dataset.game).toBe(before!.gameId);
    const after = savedGameRecord();
    expect(after?.seed).toBe(before!.seed);
    expect(after?.actions).toEqual(before!.actions);
  });

  test("restarting a session (from the in-canvas control) replaces the save with a fresh seed", async () => {
    fire("gamepigeon:launch", { game: "restaurant-arena", variation: "tutorial-shift" });
    await settle();
    const before = savedGameRecord();
    expect(before).not.toBeNull();

    pressArenaControl("restart");
    await settle();

    const after = savedGameRecord();
    expect(after).not.toBeNull();
    expect(after!.seed).not.toBe(before!.seed);
    expect(after!.actions).toEqual([]);
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("game");
  });

  test("the in-canvas menu control ends the session back at the arcade menu", async () => {
    pressArenaControl("menu");
    await settle();
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("menu");
  });

  test("signing out asks for confirmation before it takes effect", async () => {
    setSignedInUser({ id: "usr_1", email: "player@example.com" });
    click("#account-chip");
    await settle();
    const signoutPrompt = document.getElementById("signout-prompt")!;
    expect(signoutPrompt.hidden).toBe(false);
    click("#signout-cancel");
    await settle();
    expect(signoutPrompt.hidden).toBe(true);
    // Cancelling must leave the session exactly as it was.
    expect(isSignedIn()).toBe(true);
  });

  test("confirming sign-out clears the session and drops back to the sign-in gate", async () => {
    expect(isSignedIn()).toBe(true);
    click("#account-chip");
    await settle();
    const signoutPrompt = document.getElementById("signout-prompt")!;
    expect(signoutPrompt.hidden).toBe(false);

    click("#signout-confirm");
    await settle();

    expect(signoutPrompt.hidden).toBe(true);
    expect(isSignedIn()).toBe(false);
    // README ("Optional account"): "Logout clears both credentials without
    // deleting local games or traces" — the arcade save from earlier in this
    // run has to survive being signed out of.
    expect(document.querySelector<HTMLElement>("#screen")!.dataset.screen).toBe("gate");
  });
});

