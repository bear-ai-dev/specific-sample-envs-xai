import { invoke } from "./tauri-bridge.js";

export interface AuthUser {
  id: string;
  email: string;
}

let currentUser: AuthUser | null = null;
let syncError: string | null = null;

export function signedInUser(): AuthUser | null {
  return currentUser;
}

export function isSignedIn(): boolean {
  return currentUser !== null;
}

/** Reads the persisted session (written by an earlier overlay or CLI sign-in). */
export async function loadAuthSession(): Promise<AuthUser | null> {
  try {
    currentUser = (await invoke<AuthUser | null>("read_auth_session")) ?? null;
  } catch {
    currentUser = null;
  }
  return currentUser;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/** The welcome body shown before anyone has signed in. */
export function gateMarkup(): string {
  return `<section class="arcade-menu gate-screen">
    <header class="menu-heading gate-heading"><div><p>Welcome</p><h1>Tui</h1></div></header>
    <div class="gate-welcome">
      <p>Sign in to play a familiar game and keep your scores between sessions.</p>
    </div>
    <div class="gate-actions">
      <span id="auth-signin-status" class="auth-signin-status" data-state="idle"></span>
      <button id="auth-signin" type="button" class="auth-signin-button">Sign in</button>
      <button id="auth-signin-cancel" type="button" class="auth-signin-cancel" hidden>Cancel</button>
      <div id="auth-fallback" class="auth-fallback" hidden>
        <button id="auth-copy-link" type="button" class="auth-fallback-button">Copy link</button>
        <code id="auth-fallback-url" class="auth-fallback-url"></code>
      </div>
    </div>
  </section>`;
}

/** Persistent account indicator, top-left in the titlebar across every screen. */
export function renderAccountChip(): void {
  const chip = document.querySelector<HTMLButtonElement>("#account-chip");
  if (!chip) return;
  if (currentUser) {
    chip.hidden = false;
    chip.dataset.state = "in";
    chip.dataset.sync = syncError ? "error" : "ready";
    chip.title = syncError ?? "Click to sign out";
    chip.setAttribute(
      "aria-label",
      syncError
        ? `Signed in as ${currentUser.email}. ${syncError}`
        : `Signed in as ${currentUser.email}. Click to sign out.`,
    );
    chip.setAttribute("aria-haspopup", "dialog");
    // The chip is the only place the signed-in identity shows, so a paused sync
    // recolors it rather than overwriting the address — the state still reads
    // from the red dot/border and the tooltip.
    chip.innerHTML = `<span class="account-dot" aria-hidden="true"></span><span class="account-email">${
      escapeHtml(currentUser.email)
    }</span>`;
  } else {
    // Signed out: sign-in lives on the welcome gate; hide the titlebar chip.
    chip.hidden = true;
    chip.dataset.state = "out";
    delete chip.dataset.sync;
    chip.title = "";
    chip.removeAttribute("aria-label");
    chip.removeAttribute("aria-haspopup");
    chip.innerHTML = "";  }
}

/**
 * Resets gate sign-in UI; controls live in {@link gateMarkup}, not the footer.
 * A pending attempt survives a gate re-render — its listener is still up, so
 * the fallback link has to come back with it rather than vanishing.
 */
export function renderSignInBar(): void {
  const status = document.querySelector<HTMLElement>("#auth-signin-status");
  if (currentUser) return;
  if (signInPending && pendingLoginUrl) {
    setSignInStatus("pending", pendingStatusMessage);
    showFallbackLink(pendingLoginUrl, pendingFallbackState);
    return;
  }
  if (status) {
    status.dataset.state = "idle";
    status.textContent = "";
  }
  hideFallbackLink();
}

export function setSignInStatus(
  state: "idle" | "pending" | "error",
  message = "",
): void {
  const status = document.querySelector<HTMLElement>("#auth-signin-status");
  const button = document.querySelector<HTMLButtonElement>("#auth-signin");
  const cancelButton = document.querySelector<HTMLButtonElement>("#auth-signin-cancel");
  if (status) {
    status.dataset.state = state;
    status.textContent = message;
  }
  if (button) button.disabled = state === "pending";
  // The cancel button only makes sense while a browser handoff is pending —
  // it's how the user recovers if they closed that tab instead of finishing.
  if (cancelButton) cancelButton.hidden = state !== "pending";
}

let signInPending = false;
/** The live attempt's login URL — same listener port and nonce Rust opened. */
let pendingLoginUrl: string | null = null;
let pendingBrowserOpened = true;
let pendingStatusMessage = "";
let pendingFallbackState: FallbackState = "backup";

interface LoginHandoff {
  url: string;
  browserOpened: boolean;
}

export interface SignInStart {
  started: boolean;
  /** False when every OS opener failed — the gate then stays put so the link is readable. */
  browserOpened: boolean;
}

/** The URL of the attempt in flight, or null when nothing is pending. */
export function pendingSignInUrl(): string | null {
  return pendingLoginUrl;
}

/** `failed` tints the fallback border when every browser opener failed. */
type FallbackState = "backup" | "failed";

function showFallbackLink(url: string, state: FallbackState): void {
  const fallback = document.querySelector<HTMLElement>("#auth-fallback");
  const link = document.querySelector<HTMLElement>("#auth-fallback-url");
  if (!fallback) return;
  fallback.hidden = false;
  fallback.dataset.state = state;
  if (link) link.textContent = url;
}

function hideFallbackLink(): void {
  const fallback = document.querySelector<HTMLElement>("#auth-fallback");
  if (!fallback) return;
  fallback.hidden = true;
  delete fallback.dataset.state;
  const link = document.querySelector<HTMLElement>("#auth-fallback-url");
  if (link) link.textContent = "";
  const copy = document.querySelector<HTMLButtonElement>("#auth-copy-link");
  if (copy) copy.textContent = "Copy link";
}

/** Kicks off the browser sign-in handoff via the Rust command. */
export async function beginSignIn(): Promise<SignInStart> {
  if (signInPending) return { started: false, browserOpened: pendingBrowserOpened }; // one attempt at a time
  signInPending = true;
  setSignInStatus("pending", "Opening your browser...");
  try {
    // Older overlay binaries returned nothing; treat that as "browser opened"
    // so the gate keeps its previous behaviour instead of crying failure.
    const handoff = (await invoke<LoginHandoff | null>("start_auth_login")) ?? null;
    pendingLoginUrl = handoff?.url ?? null;
    pendingBrowserOpened = handoff?.browserOpened !== false;
    pendingStatusMessage = pendingBrowserOpened
      ? "Waiting for you to finish signing in..."
      : "Waiting for you to finish signing in in your browser.";
    setSignInStatus("pending", pendingStatusMessage);
    pendingFallbackState = pendingBrowserOpened ? "backup" : "failed";
    if (pendingLoginUrl) showFallbackLink(pendingLoginUrl, pendingFallbackState);
    return { started: true, browserOpened: pendingBrowserOpened };
  } catch (error) {
    signInPending = false;
    pendingLoginUrl = null;
    const message = error instanceof Error ? error.message : String(error);
    setSignInStatus("error", message || "Could not start sign-in. Try again.");
    return { started: false, browserOpened: false };
  }
}

/** Copies the pending login URL; falls back to selecting it when the webview blocks the clipboard. */
export async function copySignInUrl(): Promise<boolean> {
  const url = pendingLoginUrl;
  if (!url) return false;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    const link = document.querySelector<HTMLElement>("#auth-fallback-url");
    if (!link) return false;
    // Last resort: select the text so ⌘C/Ctrl+C works.
    const range = document.createRange();
    range.selectNodeContents(link);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return false;
  }
}

/**
 * Abandons a pending sign-in — e.g. the user closed the browser tab instead
 * of finishing. Resets the gate immediately rather than waiting out the
 * backend's 300s timeout, and tells the backend to stop listening so a fresh
 * attempt isn't rejected as "already in progress."
 */
export async function cancelSignIn(): Promise<void> {
  if (!signInPending) return;
  signInPending = false;
  pendingLoginUrl = null;
  hideFallbackLink();
  setSignInStatus("idle", "");
  await invoke("cancel_auth_login");
}

/** Clears the in-flight flag once an attempt resolves (success or failure). */
export function clearSignInPending(): void {
  signInPending = false;
  // The listener behind this URL is gone; a stale link would 404 or, worse,
  // look like it should still work.
  pendingLoginUrl = null;
  hideFallbackLink();
}

/**
 * Removes the persisted session. Throws (leaving currentUser intact) if the
 * native deletion fails, so callers never report sign-out on retained
 * credentials.
 */
export async function signOut(): Promise<void> {
  await invoke("sign_out");
  currentUser = null;
  syncError = null;
}

export function setSignedInUser(user: AuthUser): void {
  currentUser = user;
  syncError = null;
}

export function setSyncError(message: string | null): void {
  syncError = message;
  renderAccountChip();
}
