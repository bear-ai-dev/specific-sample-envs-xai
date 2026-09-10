import { describe, expect, test } from "bun:test";
import { gateMarkup } from "./auth.js";

describe("welcome gate sign-in", () => {
  test("ships a fallback link block for when the browser never opens", () => {
    const markup = gateMarkup();
    // The browser handoff can fail silently (a broken default handler, or Arc
    // routing the link into a Little Arc window that drops the redirect), so
    // the gate always carries its own recovery controls.
    expect(markup).toContain('id="auth-fallback"');
    expect(markup).toContain('id="auth-copy-link"');
    expect(markup).toContain('id="auth-fallback-url"');
  });

  test("keeps the fallback hidden until a sign-in is pending", () => {
    // A link is only valid while its listener port and nonce are live, so it
    // must not be on screen before an attempt starts.
    expect(gateMarkup()).toContain('class="auth-fallback" hidden');
  });
});
