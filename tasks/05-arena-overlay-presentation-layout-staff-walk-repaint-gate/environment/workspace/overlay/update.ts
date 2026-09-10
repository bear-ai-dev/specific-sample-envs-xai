import { invoke } from "./tauri-bridge.js";

export interface UpdateAvailable {
  fromVersion: string;
  toVersion: string;
}

/** Mirrors `UpdatePlan` in tauri/src/main.rs (from ~/.gamepigeon/install-context.json). */
export interface UpdatePlan {
  canSelfUpdate: boolean;
  manualCommand: string;
  method: string;
  harness: string;
}

/**
 * Used when the backend cannot answer (browser preview, or a command that is
 * missing on an older binary). Attempting the update is the safer default there:
 * the old Claude-only path still runs, and a failure reports itself in-line
 * along with the command to run by hand.
 */
const FALLBACK_PLAN: UpdatePlan = {
  canSelfUpdate: true,
  manualCommand: "npx -y bun x @tui-games/tui@latest install",
  method: "unknown",
  harness: "unknown",
};

export type UpdateLoadingElements = {
  loading: HTMLElement;
  version: HTMLElement;
  note: HTMLElement;
  manual: HTMLElement | null;
  command: HTMLElement | null;
  copy: HTMLButtonElement | null;
};

function loadingElements(): UpdateLoadingElements | null {
  const loading = document.querySelector<HTMLElement>("#update-loading");
  const version = document.querySelector<HTMLElement>("#update-loading-version");
  const note = document.querySelector<HTMLElement>("#update-loading-note");
  if (!loading || !version) return null;
  return {
    loading,
    version,
    note: note ?? version,
    manual: document.querySelector<HTMLElement>("#update-manual"),
    command: document.querySelector<HTMLElement>("#update-command"),
    copy: document.querySelector<HTMLButtonElement>("#update-copy-command"),
  };
}

let isAutoUpdating = false;

export function setUpdateLoading(visible: boolean, version = "", noteText = ""): void {
  const elements = loadingElements();
  if (!elements) return;
  elements.version.textContent = version ? `Installing v${version}…` : "Updating Tui…";
  if (noteText) {
    elements.note.textContent = noteText;
  } else {
    elements.note.textContent = "Keep Tui open — your game will restart automatically when finished.";
  }
  // Each new state starts without a command; only a plan that needs one shows it.
  if (elements.manual) elements.manual.hidden = true;
  elements.loading.hidden = !visible;
  document.querySelector<HTMLElement>(".app")?.setAttribute("aria-busy", String(visible));
}

/**
 * Only a Claude marketplace install, a copied adapter, or a global npm install
 * can be upgraded from in here. Everything else (a dev checkout, an install we
 * cannot identify) gets the command to run instead of an automatic attempt that
 * would only ever fail — the "Tui plugin install path not found." dead end of
 * issue #176.
 */
export function applyUpdatePlan(
  elements: UpdateLoadingElements,
  plan: UpdatePlan,
  options: { alsoShowCommand?: boolean } = {},
): void {
  elements.loading.dataset.method = plan.method;
  if (!elements.manual || !elements.command || !elements.copy) return;
  elements.manual.hidden = plan.canSelfUpdate && !options.alsoShowCommand;
  if (elements.manual.hidden) return;
  elements.command.textContent = plan.manualCommand;
  elements.copy.textContent = "Copy";
}

async function readUpdatePlan(): Promise<UpdatePlan> {
  try {
    return (await invoke<UpdatePlan | null>("read_update_plan")) ?? FALLBACK_PLAN;
  } catch {
    return FALLBACK_PLAN;
  }
}

export async function checkAndAutoUpdate(): Promise<void> {
  if (isAutoUpdating) return;

  try {
    const flag = await invoke<UpdateAvailable | null>("read_update_flag");
    if (!flag?.fromVersion || !flag?.toVersion) return;

    const elements = loadingElements();
    if (!elements) return;
    const plan = await readUpdatePlan();

    // An install the overlay cannot upgrade never starts a spinner it could not
    // finish: it shows the version and the one command that does the job.
    if (!plan.canSelfUpdate) {
      setUpdateLoading(true, flag.toVersion, "Update from your terminal:");
      applyUpdatePlan(elements, plan);
      return;
    }

    isAutoUpdating = true;
    setUpdateLoading(true, flag.toVersion);

    try {
      const message = await invoke<string>("run_plugin_update");
      setUpdateLoading(true, flag.toVersion, message || "Restarting Tui…");
    } catch (error) {
      isAutoUpdating = false;
      const errorMsg = error instanceof Error ? error.message : String(error);
      setUpdateLoading(true, flag.toVersion, `Update note: ${errorMsg}`);
      // A failed self-update leaves the terminal command as the way out, so the
      // screen stays up rather than timing out on a dead end.
      applyUpdatePlan(elements, plan, { alsoShowCommand: true });
    }
  } catch {
    // Flag read failed or non-Tauri environment
  }
}

/** Legacy banner refresh alias for screen transitions, now runs auto-update check */
export async function refreshUpdateBanner(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("update") === "true") {
    setUpdateLoading(true, "0.2.14");
    return;
  }
  await checkAndAutoUpdate();
}

/** Copies the command; falls back to selecting it when the webview blocks the clipboard. */
async function copyManualCommand(elements: UpdateLoadingElements): Promise<void> {
  if (!elements.command || !elements.copy) return;
  const copy = elements.copy;
  const command = elements.command.textContent ?? "";
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    copy.textContent = "Copied";
    window.setTimeout(() => {
      copy.textContent = "Copy";
    }, 2000);
  } catch {
    // Last resort: select the text so ⌘C/Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(elements.command);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    copy.textContent = "Press ⌘C";
  }
}

/** Auto-updates run on their own; only the manual-command copy needs a handler. */
export function bindUpdateBanner(): void {
  const elements = loadingElements();
  if (!elements?.copy) return;
  elements.copy.addEventListener("click", () => {
    void copyManualCommand(elements);
  });
}
