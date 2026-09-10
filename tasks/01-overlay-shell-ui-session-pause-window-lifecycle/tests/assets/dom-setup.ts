/**
 * Verifier-owned DOM harness for driving the real overlay/app.ts module the
 * same way a browser would: a live document built from the shipped shell
 * markup, window-level CustomEvents, and real button clicks. Nothing here is
 * shipped to the solver image; it exists only inside the trusted verifier run.
 */
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The arena's Phaser scene needs a real WebGL/canvas host; the verifier does
// not care how the canvas renders, only how app.ts manages sessions, prompts
// and the window frame around it, so both are swapped for inert doubles that
// remember the one thing app.ts hands them: the in-canvas menu/restart/how-to
// -play callback wired up in `renderGameScreen`.
let lastArenaActionCallback: ((action: string) => void) | undefined;

mock.module("phaser", () => ({ default: {} }));
mock.module("./restaurant-arena-scene.js", () => ({
  mountRestaurantArenaScene: (
    _mount: unknown,
    _view: unknown,
    _performAction: (action: string) => void,
    onArenaAction: (action: string) => void,
  ) => {
    lastArenaActionCallback = onArenaAction;
    return {
      destroy() {},
      render() {},
      setWorkerStatus() {},
    };
  },
}));

/** Fire the in-canvas menu/restart/how-to-play control the arena scene renders. */
export function pressArenaControl(action: "menu" | "restart" | "help"): void {
  if (!lastArenaActionCallback) throw new Error("verifier fixture: arena scene never mounted");
  lastArenaActionCallback(action);
}

const here = dirname(fileURLToPath(import.meta.url));
const bodyMarkup = readFileSync(join(here, "overlay-body.html"), "utf8").replace(/<script[\s\S]*?<\/script>/, "");

const win = new Window({ url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;
const bridged = [
  "window", "document", "navigator", "location", "localStorage", "sessionStorage",
  "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLHeadingElement",
  "HTMLTextAreaElement", "HTMLOListElement",
  "CustomEvent", "Event", "MouseEvent", "KeyboardEvent", "Element", "Node", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame",
] as const;
for (const key of bridged) g[key] = (win as unknown as Record<string, unknown>)[key];
g.window = win;
g.document = win.document;

win.document.body.innerHTML = bodyMarkup;

/** Boots the real overlay module fresh, exactly once per verifier process. */
export async function loadApp(): Promise<void> {
  await import("./app.js");
  // Let the microtask queue (settings load, auth check, initial render) settle.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

export function fire(type: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(type, detail === undefined ? undefined : { detail }));
}

export async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function click(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`verifier fixture: missing element ${selector}`);
  el.click();
}

/**
 * Dispatch a real, bubbling `keydown` — the same event the overlay's own
 * global shortcut listener binds on `window` for (arrow keys/WASD, Enter,
 * Esc, q — see the README's "In the overlay" line). Dispatched from
 * `document.body`, same as a real browser keystroke, so it bubbles up to the
 * `window` listener and `event.target` is a real element, not `window`
 * itself (the app's listener guards on `target?.matches(...)`).
 */
export function pressKey(key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
}

/**
 * The overlay's native-window façade reports every frame resize as a
 * `gamepigeon:preview-resize` window CustomEvent outside of a real Tauri
 * host (see tauri-bridge.ts, which this fixture does not touch). Resolves
 * with the next one so a test can assert the exact pixel size a control
 * asked for without caring how the source names its internal constants.
 */
export function onNextPreviewResize(timeoutMs = 2000): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("gamepigeon:preview-resize", handler);
      reject(new Error("verifier fixture: no gamepigeon:preview-resize event fired"));
    }, timeoutMs);
    const handler = (event: Event) => {
      clearTimeout(timer);
      window.removeEventListener("gamepigeon:preview-resize", handler);
      const detail = (event as CustomEvent<{ width: number; height: number }>).detail;
      resolve({ width: detail.width, height: detail.height });
    };
    window.addEventListener("gamepigeon:preview-resize", handler);
  });
}

