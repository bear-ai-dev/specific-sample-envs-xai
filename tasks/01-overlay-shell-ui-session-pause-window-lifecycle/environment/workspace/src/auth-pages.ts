// The pages the browser lands on at the end of a sign-in handoff, served by the
// localhost listener in `auth.ts`. This is the last thing a user sees before
// returning to the terminal, so it confirms the outcome instead of leaving a
// bare sentence on a white page.
//
// The same design is rendered by `cloudflare/auth-worker/src/handoff-page.ts`
// and `tauri/src/main.rs`; the three copies exist because they run in three
// different runtimes. Keep the copy and palette in sync when changing one.

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
// spans; the title is escaped. Escape anything request-derived at the call site.
interface PageOptions {
  tone: "ok" | "warn";
  title: string;
  lead: string;
  steps?: string[];
  hint?: string;
}

/** Renders one self-contained Tui page — no external CSS, fonts, or images. */
function arcadePage({ tone, title, lead, steps, hint }: PageOptions): string {
  const list = steps?.length
    ? `<ul class="steps">${steps.map((step) => `<li>${step}</li>`).join("")}</ul>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tui — ${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card" data-tone="${tone}">
<span class="badge">${tone === "ok" ? CHECK_ICON : ALERT_ICON}</span>
<p class="eyebrow">Tui</p>
<h1>${escapeHtml(title)}</h1>
<p class="lead">${lead}</p>
${list}
${hint ? `<p class="hint">${hint}</p>` : ""}
</main>
</body>
</html>`;
}

export function signedInPage(): string {
  return arcadePage({
    tone: "ok",
    title: "You're signed in",
    lead: "Tui has your session. You can close this tab and return to your terminal.",
    hint: "Your session is saved in <code>~/.tui-gamepigeon/auth.json</code>, so you stay signed in next time.",
  });
}

/** `reason` is shown verbatim — pass short, already-escaped copy. */
export function signInFailedPage(reason: string): string {
  return arcadePage({
    tone: "warn",
    title: "Sign-in didn't finish",
    lead: reason,
    steps: [
      "Return to your terminal and run <code>gamepigeon auth login</code> again.",
      "If the browser blocked the redirect back, allow pop-ups for the Tui login page.",
      "Signing in with Google or GitHub? Approve the consent screen rather than closing it.",
    ],
  });
}
