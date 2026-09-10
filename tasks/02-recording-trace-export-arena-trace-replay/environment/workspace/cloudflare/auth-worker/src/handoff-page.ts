// Browser-facing pages for the CLI/overlay OAuth handoff. These Worker
// responses are the only ones a person ever looks at, so they carry Tui
// branding and always say what to do next.
//
// The same design is rendered by the two localhost listeners that finish the
// handoff — `src/auth.ts` (CLI) and `tauri/src/main.rs` (overlay). The three
// copies exist because they run in three different runtimes; keep the copy and
// palette in sync when changing one.

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:radial-gradient(900px 500px at 50% -20%,#fff 0%,#eef2f8 60%,#e3eaf4 100%);color:#0f172a;
font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
.card{position:relative;overflow:hidden;width:min(100%,420px);padding:34px 28px 30px;text-align:center;
background:#fff;border:1px solid #e2e8f0;border-radius:16px;
box-shadow:0 20px 50px rgba(15,23,42,.12),0 8px 20px rgba(15,23,42,.06)}
.card::before{content:"";position:absolute;top:0;left:0;right:0;height:4px;
background:linear-gradient(90deg,#2955c9 0%,#3772ff 38%,#3bb273 72%,#e6a830 100%)}
.badge{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 auto 16px;border-radius:999px}
.badge svg{width:22px;height:22px}
[data-tone=ok] .badge{background:rgba(59,178,115,.14);color:#2e8f5c}
[data-tone=warn] .badge{background:rgba(223,41,53,.12);color:#b81f2a}
.eyebrow{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#2955c9}
h1{margin:0 0 10px;font-size:23px;line-height:1.25;letter-spacing:-.01em}
.lead{margin:0;color:#475569}
.steps{margin:18px 0 0;padding:0;list-style:none;text-align:left;border-top:1px solid #e2e8f0}
.steps li{position:relative;margin:0;padding:10px 0 0 18px;font-size:13.5px;color:#475569}
.steps li:first-child{padding-top:14px}
.steps li::before{content:"";position:absolute;left:2px;top:18px;width:5px;height:5px;border-radius:999px;background:#cbd5e1}
.steps li:first-child::before{top:22px}
.action{display:inline-block;margin-top:20px;padding:10px 22px;border:1px solid #e6a830;border-radius:999px;
background:#ffc857;color:#3d2e00;font-weight:700;font-size:13px;line-height:1;text-decoration:none}
.action:hover,.action:focus-visible{background:#e6a830}
.hint{margin:16px 0 0;font-size:12.5px;color:#64748b}
code{font:600 12.5px/1.4 ui-monospace,"SF Mono",Menlo,monospace;background:#f3f6fb;border:1px solid #e2e8f0;border-radius:5px;padding:2px 5px;overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}
@media (max-width:400px){.card{padding:28px 20px 24px}h1{font-size:21px}}
`.trim();

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ALERT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

// `lead` and `steps` are interpolated as trusted HTML so copy can carry <code>
// spans; everything else is escaped. Never pass request-supplied text through
// them — escape it with `escapeHtml` at the call site first.
interface PageOptions {
  tone: "ok" | "warn";
  /** Browser tab title; also the page heading unless `heading` overrides it. */
  title: string;
  heading?: string;
  lead: string;
  /** What to do next — rendered as a short list. */
  steps?: string[];
  action?: { href: string; label: string };
  hint?: string;
  /** Localhost URL to hand the session back to, once the page has rendered. */
  redirectTo?: string;
}

/** Renders one self-contained Tui page — no external CSS, fonts, or images. */
export function arcadePage(options: PageOptions): string {
  const heading = options.heading ?? options.title;
  const steps = options.steps?.length
    ? `<ul class="steps">${options.steps.map((step) => `<li>${step}</li>`).join("")}</ul>`
    : "";
  const action = options.action
    ? `<a class="action" href="${escapeHtml(options.action.href)}">${escapeHtml(options.action.label)}</a>`
    : "";
  const hint = options.hint ? `<p class="hint">${options.hint}</p>` : "";
  // Redirect from a rendered page rather than a bare 302 so the confirmation is
  // visible, and so a blocked redirect leaves the user on a page that explains
  // itself instead of a dead tab. `location.replace` keeps the token-bearing URL
  // out of history; the meta refresh covers browsers with scripting disabled.
  const redirect = options.redirectTo
    ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(options.redirectTo)}">` +
      `<script>location.replace(${JSON.stringify(options.redirectTo).replace(/</g, "\\u003c")})</script>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tui — ${escapeHtml(options.title)}</title>
${redirect}
<style>${STYLE}</style>
</head>
<body>
<main class="card" data-tone="${options.tone}">
<span class="badge">${options.tone === "ok" ? CHECK_ICON : ALERT_ICON}</span>
<p class="eyebrow">Tui</p>
<h1>${escapeHtml(heading)}</h1>
<p class="lead">${options.lead}</p>
${steps}
${action}
${hint}
</main>
</body>
</html>`;
}

/** Pages carry session tokens in their URL — keep them out of caches and referrers. */
export function pageResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Success: hands the session token back to the waiting localhost listener. */
export function handoffSuccessPage(redirectTo: string): string {
  return arcadePage({
    tone: "ok",
    title: "Signed in",
    lead: "Handing you back to Tui now. You can close this tab once it does.",
    action: { href: redirectTo, label: "Continue to Tui" },
    hint: "Not moving? Use the button above, or return to Tui and sign in again.",
    redirectTo,
  });
}

export function handoffErrorPage(options: {
  title: string;
  lead: string;
  steps?: string[];
}): string {
  return arcadePage({ tone: "warn", ...options });
}
