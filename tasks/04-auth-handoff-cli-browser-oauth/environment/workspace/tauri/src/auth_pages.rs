//! The pages the browser lands on at the end of an overlay sign-in, served by
//! the localhost listener in `main.rs`. This is the hand-back point between the
//! hosted login page and the overlay, so it confirms the outcome and says
//! whether to close the tab.
//!
//! The same design is rendered by `cloudflare/auth-worker/src/handoff-page.ts`
//! and `src/auth-pages.ts`; the three copies exist because they run in three
//! different runtimes. Keep the copy and palette in sync when changing one.

const STYLE: &str = r#":root{color-scheme:light}
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
@media (max-width:400px){.card{padding:28px 20px 24px}h1{font-size:21px}}"#;

const CHECK_ICON: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>"#;
const ALERT_ICON: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>"#;

pub fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(character),
        }
    }
    out
}

/// Renders one self-contained Tui page — no external CSS, fonts, or images.
///
/// `lead`, `steps`, and `hint` are trusted HTML so copy can carry `<code>`
/// spans; the title is escaped. Escape request-derived text at the call site.
fn arcade_page(tone: &str, title: &str, lead: &str, steps: &[&str], hint: &str) -> String {
    let list = if steps.is_empty() {
        String::new()
    } else {
        format!(
            "<ul class=\"steps\">{}</ul>",
            steps
                .iter()
                .map(|step| format!("<li>{step}</li>"))
                .collect::<Vec<_>>()
                .join(""),
        )
    };
    let hint = if hint.is_empty() {
        String::new()
    } else {
        format!("<p class=\"hint\">{hint}</p>")
    };
    let icon = if tone == "ok" { CHECK_ICON } else { ALERT_ICON };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Tui — {title_text}</title>
<style>{STYLE}</style>
</head>
<body>
<main class="card" data-tone="{tone}">
<span class="badge">{icon}</span>
<p class="eyebrow">Tui</p>
<h1>{title_text}</h1>
<p class="lead">{lead}</p>
{list}
{hint}
</main>
</body>
</html>"#,
        title_text = escape_html(title),
    )
}

/// Success: the overlay has the token and is leaving the sign-in gate.
pub fn signed_in_page() -> String {
    arcade_page(
        "ok",
        "You're signed in",
        "Tui is unlocking now. You can close this tab and go back to the overlay.",
        &[],
        "Your session is saved on this machine, so Tui opens straight to the games next time.",
    )
}

/// The handoff reached us but carried no usable session.
pub fn sign_in_failed_page(reason: &str) -> String {
    arcade_page(
        "warn",
        "Sign-in didn't finish",
        reason,
        &[
            "Go back to Tui and choose <b>Sign in</b> again.",
            "If your browser blocked the redirect back to Tui, allow pop-ups for the login page.",
            "Signing in with Google or GitHub? Approve the consent screen rather than closing it.",
        ],
        "Prefer the terminal? <code>gamepigeon auth login</code> signs in the same account.",
    )
}

/// A redirect arrived for a sign-in attempt the overlay is no longer waiting on
/// — usually a stale tab from a cancelled or superseded attempt.
pub fn stale_attempt_page() -> String {
    arcade_page(
        "warn",
        "This sign-in link is out of date",
        "Tui is waiting on a newer sign-in, so this tab can't be used to finish it.",
        &[
            "Close this tab and finish in the most recent Tui sign-in tab.",
            "No other tab open? Go back to Tui and choose <b>Sign in</b> again.",
        ],
        "",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_html_in_page_titles_and_text() {
        assert_eq!(escape_html("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&#39;");
    }

    #[test]
    fn success_page_is_a_branded_standalone_document() {
        let page = signed_in_page();
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("You&#39;re signed in"));
        assert!(page.contains("close this tab"));
        assert!(page.contains("Tui"));
        // Self-contained: nothing to fetch from the network.
        assert!(!page.contains("http://"));
        assert!(!page.contains("https://"));
    }

    #[test]
    fn failure_pages_say_what_to_do_next() {
        let failed = sign_in_failed_page("The login page came back without a session token.");
        assert!(failed.contains("without a session token"));
        assert!(failed.contains("Sign in</b> again"));

        let stale = stale_attempt_page();
        assert!(stale.contains("out of date"));
        assert!(stale.contains("Sign in</b> again"));
    }

    #[test]
    fn failure_reason_is_escaped_by_the_caller_not_injected_raw() {
        // Callers escape request-derived text; the page must carry it verbatim
        // so already-escaped entities are not double-escaped.
        let page = sign_in_failed_page(&escape_html("<script>alert(1)</script>"));
        assert!(!page.contains("<script>"));
        assert!(page.contains("&lt;script&gt;"));
    }
}
