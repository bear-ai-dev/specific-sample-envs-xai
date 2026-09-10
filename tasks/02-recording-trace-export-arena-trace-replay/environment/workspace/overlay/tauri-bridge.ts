/**
 * Thin Tauri façade so the overlay boots in a plain browser (preview mode).
 * Production Tauri packaging is unchanged — real APIs are used when present.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize as TauriLogicalSize } from "@tauri-apps/api/window";

export const PREVIEW_RESIZE_MESSAGE = "gamepigeon:preview-resize";

export const COMPACT_SIZE = { width: 600, height: 850 } as const;
export const EXPANDED_SIZE = { width: 830, height: 900 } as const;
/** Collapsed handheld pill. The native frame matches it to avoid blocking the desktop. */
export const PILL_SIZE = { width: 144, height: 48 } as const;
/** The arcade's usable floor, restored whenever the pill expands again. */
export const MIN_SIZE = { width: 500, height: 700 } as const;

type TauriWindow = ReturnType<typeof getCurrentWindow>;

export type OverlayWindow = Pick<
  TauriWindow,
  "hide" | "setSize" | "setMinSize" | "center" | "startDragging"
>;

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export class LogicalSize {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

function sizeParts(size: LogicalSize | TauriLogicalSize | { width: number; height: number }): {
  width: number;
  height: number;
} {
  return { width: size.width, height: size.height };
}

function notifyPreviewResize(width: number, height: number): void {
  const detail = { type: PREVIEW_RESIZE_MESSAGE, width, height };
  window.parent?.postMessage(detail, window.location.origin);
  window.dispatchEvent(new CustomEvent(PREVIEW_RESIZE_MESSAGE, { detail }));
}

function browserWindow(): OverlayWindow {
  return {
    hide: async () => {
      console.info("[preview] hide");
    },
    setSize: async (size) => {
      const { width, height } = sizeParts(size as LogicalSize);
      notifyPreviewResize(width, height);
    },
    setMinSize: async () => {
      /* the preview iframe has no min size to enforce */
    },
    center: async () => {
      /* no-op in browser preview */
    },
    startDragging: async () => {
      /* no-op in browser preview */
    },
  };
}

let cachedWindow: OverlayWindow | undefined;

export function getOverlayWindow(): OverlayWindow {
  if (!cachedWindow) {
    cachedWindow = isTauri() ? getCurrentWindow() : browserWindow();
  }
  return cachedWindow;
}

async function previewInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const path = cmd === "read_worker_model_config"
    ? "/api/worker-model/config"
    : cmd === "complete_worker_model"
      ? "/api/worker-model/complete"
      : cmd === "cancel_worker_model"
        ? "/api/worker-model/cancel"
        : undefined;
  if (!path) {
    console.info(`[preview] invoke(${cmd})`, args ?? {});
    return undefined as T;
  }
  const response = await fetch(path, {
    method: cmd === "read_worker_model_config" ? "GET" : "POST",
    headers: cmd === "read_worker_model_config" ? undefined : { "Content-Type": "application/json" },
    body: cmd === "read_worker_model_config" ? undefined : JSON.stringify(args ?? {}),
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) return tauriInvoke<T>(cmd, args);
  return previewInvoke<T>(cmd, args);
}

/** Prefer the real Tauri LogicalSize under Tauri so setSize accepts it. */
export function overlayLogicalSize(width: number, height: number): LogicalSize | TauriLogicalSize {
  return isTauri() ? new TauriLogicalSize(width, height) : new LogicalSize(width, height);
}
