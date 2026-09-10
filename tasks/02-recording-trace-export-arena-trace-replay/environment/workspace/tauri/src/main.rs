#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

mod auth_pages;
use auth_pages::{escape_html, sign_in_failed_page, signed_in_page, stale_attempt_page};

const PLUGIN_KEY: &str = "tui-gamepigeon@tui-gamepigeon";

// The overlay binds an ephemeral localhost port (chosen by the OS) rather than
// the CLI's fixed 3210, so an overlay sign-in never collides with a terminal
// `gamepigeon auth login`. The chosen port is passed to the hosted login page in
// the `callback` param; the page probes /auth/ping then redirects to
// /auth/callback?token=... on that same port (same contract as src/auth.ts).
const DEFAULT_AUTH_BASE_URL: &str = "https://auth.runretroarcade.com";
const DEFAULT_LOGIN_URL: &str = "https://runretroarcade.com/login";
const DEFAULT_BACKEND_BASE_URL: &str = "https://api.runretroarcade.com";

fn analytics_queue_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join(".tui-gamepigeon/analytics-events.jsonl"))
}

fn arcade_settings_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".gamepigeon/settings.json"))
}

fn arcade_setting_enabled(name: &str, default: bool) -> bool {
    let Some(path) = arcade_settings_path() else { return default };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get(name).and_then(|value| value.as_bool()))
        .unwrap_or(default)
}

#[tauri::command]
fn record_analytics_event(event: String) {
    if !arcade_setting_enabled("productAnalytics", true) { return; }
    if event.len() > 4096 || !event.starts_with('{') || !event.ends_with('}') {
        return;
    }
    if let Some(path) = analytics_queue_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{}", event);
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum OverlayAction {
    Show,
    Enable,
    Pause,
    Hide,
    Reset,
    Quit,
}

// Mirrors `SHUTDOWN_FLAG` in scripts/overlay.ts: a temporary marker that
// suppresses `--show`/`--pause` for the rest of the session.
fn shutdown_flag_path() -> Option<std::path::PathBuf> {
    Some(std::env::temp_dir().join(".gamepigeon-overlay.off"))
}

fn clear_shutdown_flag() {
    if let Some(path) = shutdown_flag_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn overlay_lease_path() -> std::path::PathBuf {
    std::env::var_os("GAMEPIGEON_OVERLAY_LEASE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(".gamepigeon-overlay.alive"))
}

fn ensure_overlay_lease() {
    let path = overlay_lease_path();
    let _ = std::fs::write(path, b"");
}

fn clear_overlay_lease() {
    let _ = std::fs::remove_file(overlay_lease_path());
}

// Invoked by the overlay's "Shutdown" button: leave the flag so the launcher
// stops re-opening the window, then quit. SessionStart clears the flag.
#[tauri::command]
fn shutdown(app: AppHandle) {
    if let Some(path) = shutdown_flag_path() {
        let _ = std::fs::write(path, b"");
    }
    clear_overlay_lease();
    app.exit(0);
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[tauri::command]
fn read_settings() -> serde_json::Value {
    arcade_settings_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn write_settings(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let path = arcade_settings_path().ok_or_else(|| "Could not resolve home directory.".to_string())?;
    let parent = path.parent().ok_or_else(|| "Could not resolve settings directory.".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("Could not create settings directory: {error}"))?;
    let existing = read_settings();
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    if let Some(values) = settings.as_object() { merged.extend(values.clone()); }
    let temporary = parent.join(format!("settings.json.tmp-{}", std::process::id()));
    write_private(&temporary, &(serde_json::to_string_pretty(&serde_json::Value::Object(merged.clone())).unwrap() + "\n"))
        .map_err(|error| format!("Could not write settings: {error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| format!("Could not commit settings: {error}"))?;
    Ok(serde_json::Value::Object(merged))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModelConfig {
    provider: String,
    name: String,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModelRequest {
    system_prompt: String,
    turn_prompt: String,
}

fn worker_cancellations() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static CANCELLATIONS: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> = OnceLock::new();
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// This app's share of a metered account, not the account's own ceiling. The
// demo key is limited to 40 requests per minute and two callers draw on it:
// this app playing a live shift, and the benchmark harness in retro-backend.
// The shares have to sum to less than 40. A live shift gets the larger share
// because a person is sitting in front of it; the benchmark takes 10 and can
// wait. Changing this number without changing the harness' matching
// ESIM_NIM_MAX_STARTS_PER_WINDOW re-opens the overrun both exist to prevent.
const DEFAULT_MODEL_MAX_STARTS: usize = 20;
const MODEL_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
// A Retry-After naming an hour would strand a shift that is holding a
// simulation open, so longer waits are clamped and the request fails on its
// own timeout instead -- bounded and visible, rather than a silent stall.
const MAX_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(120);

/// Admits at most `max_starts` request starts per rolling 60 seconds.
///
/// A rolling window, not a token bucket: a bucket refilling at `N/60` per
/// second with a burst of `N` admits `N` immediately and then each refilled
/// permit as it arrives, which is up to `2N` starts inside one rolling minute.
/// What the account meters is the moment a request is *made*, so this keeps
/// the timestamp of every start still inside the window and refuses the
/// `N+1`-th until the oldest leaves it.
struct RequestBudget {
    starts: std::collections::VecDeque<std::time::Instant>,
    max_starts: usize,
    blocked_until: Option<std::time::Instant>,
}

impl RequestBudget {
    fn new(max_starts: usize) -> Self {
        Self { starts: std::collections::VecDeque::new(), max_starts: max_starts.max(1), blocked_until: None }
    }

    fn prune(&mut self, now: std::time::Instant) {
        while self.starts.front().is_some_and(|start| now.duration_since(*start) >= MODEL_WINDOW) {
            self.starts.pop_front();
        }
    }

    /// How long the caller must wait before its start is admissible, if at all.
    fn wait_for(&mut self, now: std::time::Instant) -> Option<std::time::Duration> {
        if let Some(until) = self.blocked_until {
            if until > now { return Some(until - now); }
            self.blocked_until = None;
        }
        self.prune(now);
        if self.starts.len() < self.max_starts { return None; }
        // The oldest start leaves the window at this moment, freeing its slot.
        self.starts.front().map(|oldest| MODEL_WINDOW - now.duration_since(*oldest))
    }

    fn record_start(&mut self, now: std::time::Instant) {
        self.starts.push_back(now);
    }

    /// Back every caller off after the provider said to.
    ///
    /// Applied to the whole budget rather than to the one request that saw the
    /// 429: the limit belongs to the account, so a refusal says what every
    /// caller may do next, not just that one. Otherwise the four workers
    /// queued behind the manager each spend a request rediscovering it.
    fn penalize(&mut self, now: std::time::Instant, retry_after: std::time::Duration) {
        let deadline = now + retry_after.min(MAX_RETRY_AFTER);
        self.blocked_until = Some(match self.blocked_until {
            Some(existing) if existing > deadline => existing,
            _ => deadline,
        });
    }
}

fn worker_budget() -> &'static tokio::sync::Mutex<RequestBudget> {
    static BUDGET: OnceLock<tokio::sync::Mutex<RequestBudget>> = OnceLock::new();
    BUDGET.get_or_init(|| {
        let max_starts = std::env::var("GAMEPIGEON_MODEL_MAX_STARTS_PER_WINDOW")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MODEL_MAX_STARTS);
        tokio::sync::Mutex::new(RequestBudget::new(max_starts))
    })
}

/// Wait until this request may start, then record it.
///
/// The lock is deliberately held across the sleep. Releasing it would let
/// every waiter wake against the same expired slot and admit itself, which is
/// the over-admission this exists to prevent; holding it makes waiters queue
/// and re-check one at a time. Cancellation still works while queued: the
/// caller races this against its cancel channel.
async fn admit_worker_request(app: &AppHandle) {
    let mut budget = worker_budget().lock().await;
    let mut waited = false;
    while let Some(wait) = budget.wait_for(std::time::Instant::now()) {
        // Say so before sleeping, not after: the whole point is to be visible
        // during the wait. A queued shift that reports nothing is
        // indistinguishable from a broken one (#281).
        dispatch_worker_budget_event(app, "waiting", wait.as_secs());
        waited = true;
        tokio::time::sleep(wait).await;
    }
    budget.record_start(std::time::Instant::now());
    if waited {
        dispatch_worker_budget_event(app, "ready", 0);
    }
}

/// Tell the overlay what the shared model account is doing to this request.
///
/// `state` is always one of our own literals, so it needs no escaping; the
/// only other value is a whole number of seconds.
fn dispatch_worker_budget_event(app: &AppHandle, state: &'static str, seconds: u64) {
    dispatch_overlay_event(
        app,
        "gamepigeon:worker-budget",
        &format!("{{ \"state\": \"{state}\", \"seconds\": {seconds} }}"),
    );
}

/// Read a Retry-After header as a duration, honoring only the delta-seconds
/// form. The HTTP-date form is legal but unobserved here; treating an
/// unparsable header as "no guidance" leaves our own window in charge, which
/// is the safe direction to fail.
fn parse_retry_after(value: Option<&str>) -> Option<std::time::Duration> {
    let seconds: f64 = value?.trim().parse().ok()?;
    // Clamped before the conversion, not after: Duration::from_secs_f64
    // panics on a value that is infinite or too large to represent, and Rust
    // parses an overflowing literal such as "1e999" as f64::INFINITY rather
    // than failing. A provider header would otherwise take down the request
    // path -- and with it the cancellation-registry cleanup that runs after
    // it. NaN is excluded by the comparison, which is false for NaN.
    if seconds > 0.0 {
        Some(std::time::Duration::from_secs_f64(
            seconds.min(MAX_RETRY_AFTER.as_secs_f64()),
        ))
    } else {
        None
    }
}

fn valid_worker_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn worker_model_credentials() -> Option<(String, String, WorkerModelConfig)> {
    let url = std::env::var("GAMEPIGEON_MODEL_URL").ok()?.trim().to_string();
    let key = std::env::var("GAMEPIGEON_MODEL_API_KEY").ok()?.trim().to_string();
    let name = std::env::var("GAMEPIGEON_MODEL_NAME").ok()?.trim().to_string();
    if url.is_empty() || key.is_empty() || name.is_empty() { return None; }
    Some((url, key, WorkerModelConfig {
        provider: std::env::var("GAMEPIGEON_MODEL_PROVIDER").unwrap_or_else(|_| "openai-compatible".to_string()),
        name,
        version: std::env::var("GAMEPIGEON_MODEL_VERSION").ok().filter(|value| !value.trim().is_empty()),
    }))
}

#[tauri::command]
fn read_worker_model_config() -> Option<WorkerModelConfig> {
    worker_model_credentials().map(|(_, _, config)| config)
}

fn worker_completion_text(body: &str) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.pointer("/choices/0/message/content")?.as_str().map(str::to_string))
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "The model response did not contain a completion.".to_string())
}

/// Usage and shape metadata a provider may include alongside the completion.
/// Every field is best-effort: a provider that omits `usage`, or serves a
/// non-OpenAI-compatible shape, leaves these `None` rather than failing the
/// request -- the completion text is what the worker needs to keep acting.
#[derive(Default)]
struct WorkerCompletionUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    finish_reason: Option<String>,
}

fn worker_completion_usage(body: &str) -> WorkerCompletionUsage {
    let Some(value) = serde_json::from_str::<serde_json::Value>(body).ok() else {
        return WorkerCompletionUsage::default();
    };
    WorkerCompletionUsage {
        input_tokens: value.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()),
        output_tokens: value.pointer("/usage/completion_tokens").and_then(|v| v.as_u64()),
        cached_tokens: value.pointer("/usage/prompt_tokens_details/cached_tokens").and_then(|v| v.as_u64()),
        finish_reason: value.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()).map(str::to_string),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModelResponse {
    text: String,
    /// Always known: measured locally around admission, not reported by the provider.
    queue_ms: u64,
    /// Always known: measured locally around the provider call itself.
    provider_ms: u64,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    finish_reason: Option<String>,
}

/// One client for every worker model request, not one per call.
///
/// A fresh `reqwest::Client` re-does TLS setup and opens a new connection on
/// every request; a shared client lets the underlying `hyper` pool reuse a
/// live connection to the same host across a shift's many requests. Built
/// without a client-level timeout so cancellation and the per-request 30s
/// bound below are unaffected -- `RequestBuilder::timeout` overrides it per
/// call exactly as the old per-call client did.
fn worker_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("reqwest client failed to build"))
}

async fn complete_worker_model_request(app: &AppHandle, request: WorkerModelRequest) -> Result<WorkerModelResponse, String> {
    if request.system_prompt.len() + request.turn_prompt.len() > 200_000 {
        return Err("The worker prompt is too large.".to_string());
    }
    let (url, key, config) = worker_model_credentials()
        .ok_or_else(|| "Live model transport is not configured.".to_string())?;
    // Admission comes before the client is built: queueing for the account's
    // share is not the provider being slow, and a request that never starts
    // costs the account nothing. Timed separately from the provider call so
    // the two never get blamed on each other.
    let queue_started = std::time::Instant::now();
    admit_worker_request(app).await;
    let queue_ms = queue_started.elapsed().as_millis() as u64;
    let provider_started = std::time::Instant::now();
    let response = worker_http_client()
        .post(url)
        .timeout(std::time::Duration::from_secs(30))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": config.name,
            "temperature": 0,
            "max_tokens": 256,
            "messages": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": request.turn_prompt }
            ]
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Model provider timed out.".to_string()
            } else {
                "Model provider request failed.".to_string()
            }
        })?;
    let provider_ms = provider_started.elapsed().as_millis() as u64;
    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 429 {
            // The account said stop. Hold every worker behind this shift back,
            // not just the one that asked, and say so in words the HUD can
            // show -- a throttled shift should not read as a broken one.
            let retry_after = parse_retry_after(
                response.headers().get("retry-after").and_then(|value| value.to_str().ok()),
            )
            .unwrap_or(MODEL_WINDOW);
            worker_budget().lock().await.penalize(std::time::Instant::now(), retry_after);
            // The error string reaches one worker turn and renders as that
            // turn's failure. The banner is what tells the player the shift
            // is throttled rather than broken.
            dispatch_worker_budget_event(app, "throttled", retry_after.min(MAX_RETRY_AFTER).as_secs());
            return Err(format!(
                "Model account is rate limited; waiting {}s before the next request.",
                retry_after.min(MAX_RETRY_AFTER).as_secs()
            ));
        }
        return Err(format!("Model provider returned HTTP {status}."));
    }
    let body = response.text().await
        .map_err(|_| "Could not read the model response.".to_string())?;
    if body.len() > 1_000_000 { return Err("The model response was too large.".to_string()); }
    let text = worker_completion_text(&body)?;
    let usage = worker_completion_usage(&body);
    Ok(WorkerModelResponse {
        text,
        queue_ms,
        provider_ms,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_tokens,
        finish_reason: usage.finish_reason,
    })
}

#[tauri::command]
async fn complete_worker_model(app: AppHandle, request_id: String, request: WorkerModelRequest) -> Result<WorkerModelResponse, String> {
    if !valid_worker_request_id(&request_id) { return Err("Model request id is invalid.".to_string()); }
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    worker_cancellations().lock().expect("worker cancellation registry poisoned").insert(request_id.clone(), cancel);
    let result = tokio::select! {
        result = complete_worker_model_request(&app, request) => result,
        _ = cancelled => Err("Model request canceled.".to_string()),
    };
    worker_cancellations().lock().expect("worker cancellation registry poisoned").remove(&request_id);
    result
}

#[tauri::command]
fn cancel_worker_model(request_id: String) {
    if !valid_worker_request_id(&request_id) { return; }
    if let Some(cancel) = worker_cancellations().lock().expect("worker cancellation registry poisoned").remove(&request_id) {
        let _ = cancel.send(());
    }
}

fn gamepigeon_home() -> Option<PathBuf> {
    std::env::var_os("GAMEPIGEON_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".gamepigeon")))
}

fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")))
}

#[derive(Serialize, Deserialize)]
struct UpdateFlag {
    #[serde(rename = "fromVersion")]
    from_version: String,
    #[serde(rename = "toVersion")]
    to_version: String,
}

/// Mirrors `InstallContext` in scripts/plugin-update.ts, rewritten by the
/// launcher on every overlay start. `update_command` is the argv to run for a
/// one-click update; when it is absent the overlay shows `manual_command`
/// instead of a button that cannot work.
#[derive(Clone, Deserialize)]
struct InstallContext {
    #[serde(default = "unknown_field")]
    harness: String,
    #[serde(rename = "launcherRoot")]
    launcher_root: PathBuf,
    #[serde(rename = "updateMethod", default = "unknown_field")]
    update_method: String,
    #[serde(rename = "updateCommand", default)]
    update_command: Option<Vec<String>>,
    #[serde(rename = "manualCommand", default)]
    manual_command: Option<String>,
}

fn unknown_field() -> String {
    "unknown".to_string()
}

const GENERIC_UPDATE_COMMAND: &str = "npx -y bun x @tui-games/tui@latest install";

#[derive(Serialize)]
struct UpdatePlan {
    #[serde(rename = "canSelfUpdate")]
    can_self_update: bool,
    #[serde(rename = "manualCommand")]
    manual_command: String,
    method: String,
    harness: String,
}

fn read_update_flag_file() -> Option<UpdateFlag> {
    let path = gamepigeon_home()?.join("update-available.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn read_install_context_file() -> Option<InstallContext> {
    let path = gamepigeon_home()?.join("install-context.json");
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Installs from before the launcher wrote an install context — and overlays
/// started outside the launcher — still resolve through the Claude marketplace
/// record when one exists.
fn legacy_claude_context() -> Option<InstallContext> {
    let launcher_root = resolve_plugin_install_path().ok()?;
    Some(InstallContext {
        harness: "claude".to_string(),
        update_command: Some(vec![
            "bun".to_string(),
            launcher_root
                .join("scripts")
                .join("run-plugin-update.ts")
                .to_string_lossy()
                .into_owned(),
        ]),
        manual_command: Some("/tui-gamepigeon:arcade-update".to_string()),
        update_method: "claude-marketplace".to_string(),
        launcher_root,
    })
}

fn read_install_context() -> Option<InstallContext> {
    read_install_context_file().or_else(legacy_claude_context)
}

fn manual_command_of(context: Option<&InstallContext>) -> String {
    context
        .and_then(|context| context.manual_command.clone())
        .filter(|command| !command.is_empty())
        .unwrap_or_else(|| GENERIC_UPDATE_COMMAND.to_string())
}

/// What the banner should offer: a one-click update, or the command to run.
fn update_plan_for(context: Option<&InstallContext>) -> UpdatePlan {
    let runnable = context
        .and_then(|context| context.update_command.as_ref())
        .is_some_and(|command| !command.is_empty());
    UpdatePlan {
        can_self_update: runnable,
        manual_command: manual_command_of(context),
        method: context.map_or_else(unknown_field, |context| context.update_method.clone()),
        harness: context.map_or_else(unknown_field, |context| context.harness.clone()),
    }
}

#[tauri::command]
fn read_update_plan() -> UpdatePlan {
    update_plan_for(read_install_context().as_ref())
}

#[tauri::command]
fn read_update_flag() -> Option<UpdateFlag> {
    read_update_flag_file()
}

fn parse_plugin_install_path(content: &str) -> Result<PathBuf, String> {
    let parsed: serde_json::Value = serde_json::from_str(content)
        .map_err(|_| "Could not parse installed plugin metadata.".to_string())?;
    let install_path = parsed
        .pointer(&format!("/plugins/{PLUGIN_KEY}/0/installPath"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Tui plugin install path not found.".to_string())?;
    Ok(PathBuf::from(install_path))
}

fn resolve_plugin_install_path() -> Result<PathBuf, String> {
    let installed_plugins = claude_config_dir()
        .ok_or_else(|| "Could not resolve Claude config directory.".to_string())?
        .join("plugins")
        .join("installed_plugins.json");
    let content = std::fs::read_to_string(&installed_plugins)
        .map_err(|_| "Tui plugin install record not found.".to_string())?;
    parse_plugin_install_path(&content)
}

fn resolve_bun_command() -> PathBuf {
    let candidates = [
        std::env::var_os("BUN_INSTALL").map(|root| PathBuf::from(root).join("bin").join("bun")),
        home_dir().map(|home| home.join(".bun").join("bin").join("bun")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("bun")
}

/// The launcher always installs a Bun of its own, so `bun` is resolved to that
/// absolute path rather than trusting whatever PATH the overlay inherited.
fn resolve_update_program(program: &str) -> PathBuf {
    if program == "bun" {
        resolve_bun_command()
    } else {
        PathBuf::from(program)
    }
}

fn run_plugin_update_process() -> Result<String, String> {
    let context = read_install_context();
    let manual = manual_command_of(context.as_ref());
    let Some((program, args, cwd)) = context.as_ref().and_then(|context| {
        let command = context.update_command.as_ref()?;
        let (program, args) = command.split_first()?;
        // Claude's updater is a script inside the install and expects to run
        // there. The others *replace* that directory — an installer resolving
        // packages from inside the tree it is overwriting is asking for a
        // half-updated checkout (and a locked directory on Windows), so they
        // run from home instead.
        let cwd = if context.update_method == "claude-marketplace" {
            context.launcher_root.clone()
        } else {
            home_dir().unwrap_or_else(|| context.launcher_root.clone())
        };
        Some((resolve_update_program(program), args.to_vec(), cwd))
    }) else {
        return Err(format!("Tui can't update itself from this install. Run: {manual}"));
    };

    let mut command = Command::new(&program);
    command.args(&args);
    if cwd.is_dir() {
        command.current_dir(&cwd);
    }
    let method = context
        .as_ref()
        .map_or_else(unknown_field, |context| context.update_method.clone());
    let output = command
        .output()
        .map_err(|error| format!("Could not run the Tui updater ({error}). Run: {manual}"))?;
    finish_update_output(
        output,
        update_success_message(&method),
        method == "claude-marketplace",
    )
    .map_err(|failure| {
        if failure.is_empty() {
            format!("The update did not finish. Run: {manual}")
        } else {
            format!("{failure}\n\nRun: {manual}")
        }
    })
}

/// Claude's updater prints the sentence the banner should show; every other
/// install method prints installer chatter (download progress, target paths)
/// that would only confuse the banner, so it gets a fixed line instead.
fn update_success_message(method: &str) -> &'static str {
    if method == "claude-marketplace" {
        "Tui updated. Run /reload-plugins or restart Claude Code."
    } else {
        "Tui updated to the latest version."
    }
}

fn update_output_message(
    succeeded: bool,
    stdout: &str,
    stderr: &str,
    success: &str,
    verbose: bool,
) -> Result<String, String> {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    if succeeded {
        Ok(if verbose && !stdout.is_empty() { stdout.to_string() } else { success.to_string() })
    } else {
        Err(if stderr.is_empty() { stdout.to_string() } else { stderr.to_string() })
    }
}

fn finish_update_output(output: std::process::Output, success: &str, verbose: bool) -> Result<String, String> {
    if output.status.success() {
        if let Some(path) = gamepigeon_home().map(|home| home.join("update-available.json")) {
            let _ = std::fs::remove_file(path);
        }
    }
    update_output_message(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        success,
        verbose,
    )
}

// The plugin update can replace the install directory containing this source.
// Resolve it again afterwards, then let the updated launcher obtain the current
// overlay binary and open its window before this old process exits.
fn relaunch_updated_overlay(previous_root: Option<PathBuf>) -> Result<(), String> {
    // Re-read the context first: an adapter reinstall runs from a fresh npx
    // checkout and rewrites the file to point at the launcher it just installed.
    let install_path = read_install_context()
        .map(|context| context.launcher_root)
        .or(previous_root)
        .ok_or_else(|| "Tui updated. Restart your agent to reopen Tui.".to_string())?;
    let script = install_path.join("scripts").join("overlay.ts");
    if !script.is_file() {
        return Err("Tui updated, but its launcher was not installed. Restart Claude Code and open Tui again.".to_string());
    }
    Command::new(resolve_bun_command())
        .arg(script)
        .arg("--show")
        .current_dir(install_path)
        .spawn()
        .map_err(|error| format!("Tui updated, but could not reopen its window: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn run_plugin_update(app: AppHandle) -> Result<String, String> {
    let previous_root = read_install_context().map(|context| context.launcher_root);
    let message = tauri::async_runtime::spawn_blocking(run_plugin_update_process)
        .await
        .map_err(|error| format!("Could not run the Tui updater: {error}"))??;
    // The update itself already landed, so a relaunch failure is a note on a
    // success, not a failure: reporting it as an error would send the user back
    // to a button that has nothing left to do.
    match relaunch_updated_overlay(previous_root) {
        Ok(()) => {
            app.exit(0);
            Ok(message)
        }
        Err(reason) => Ok(format!("{message} {reason}")),
    }
}

// ── Auth ──────────────────────────────────────────────────────────────────
// Mirrors the CLI browser-handoff flow in src/auth.ts so a user can sign in
// from inside the overlay window instead of dropping to a terminal.

#[derive(Clone, Serialize)]
struct AuthUser {
    id: String,
    email: String,
}

// Guards against concurrent sign-in attempts: a second `start_auth_login` while
// one is already listening is rejected rather than spawning a competing browser
// tab + listener. Reset by AuthInProgress's Drop when the attempt finishes.
static AUTH_IN_PROGRESS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// Lets the overlay abandon a pending sign-in (e.g. the user closed the
// browser tab) instead of waiting out the 300s timeout. Set by
// `cancel_auth_login`, checked by the listener loop, reset per attempt.
static AUTH_CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// The login URL of the in-flight attempt, so the overlay can offer a working
// fallback link (and an "open in browser" retry) when the OS opener fails
// silently. Set when an attempt starts, cleared when it ends — a link is only
// ever handed out while its listener port and nonce are still live.
static PENDING_LOGIN_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static RECORDING_DRAIN: std::sync::Mutex<()> = std::sync::Mutex::new(());
static SYNC_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

struct AuthInProgress;

impl AuthInProgress {
    /// Returns None if a sign-in is already running.
    fn acquire() -> Option<Self> {
        use std::sync::atomic::Ordering;
        match AUTH_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => Some(AuthInProgress),
            Err(_) => None,
        }
    }
}

impl Drop for AuthInProgress {
    fn drop(&mut self) {
        // Every exit path — success, failure, cancel, timeout — retires the
        // attempt's fallback link along with its listener.
        set_pending_login_url(None);
        AUTH_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

fn set_pending_login_url(url: Option<String>) {
    if let Ok(mut pending) = PENDING_LOGIN_URL.lock() {
        *pending = url;
    }
}

// A 128-bit random nonce (hex) that binds a callback to the attempt that started
// it, so another local client racing to our listener can't inject its own token.
fn generate_nonce() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS RNG unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn auth_base_url() -> String {
    std::env::var("GAMEPIGEON_AUTH_URL")
        .ok()
        .or_else(|| std::env::var("CLOUDFLARE_AUTH_URL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_AUTH_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn login_base_url() -> String {
    std::env::var("GAMEPIGEON_LOGIN_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LOGIN_URL.to_string())
}

fn backend_base_url() -> String {
    std::env::var("GAMEPIGEON_BACKEND_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_BACKEND_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn tui_gamepigeon_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".tui-gamepigeon"))
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct LocalScoreInput {
    game_id: String,
    game_type: String,
    variation_id: String,
    score: i64,
    success: bool,
    completed_at: String,
    duration_ms: u64,
    platform: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct LocalScoreEntry {
    schema_version: u8,
    #[serde(flatten)]
    score: LocalScoreInput,
    personal_best: i64,
    high_score_updated: bool,
}

#[derive(Debug, PartialEq, Serialize)]
struct LocalScoreBest {
    game_type: String,
    score: i64,
}

#[derive(Serialize)]
struct LocalScores {
    personal_bests: Vec<LocalScoreBest>,
    recent: Vec<LocalScoreEntry>,
    top_scores: Vec<LocalScoreEntry>,
}

fn read_local_scores_from(path: &std::path::Path) -> Result<LocalScores, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Could not read the score log: {error}")),
    };
    let entries = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<LocalScoreEntry>(line).ok())
        .collect::<Vec<_>>();
    let mut personal_bests = std::collections::BTreeMap::<String, i64>::new();
    for entry in &entries {
        personal_bests
            .entry(entry.score.game_type.clone())
            .and_modify(|best| *best = (*best).max(entry.score.score))
            .or_insert(entry.score.score);
    }
    let mut recent = entries.clone();
    recent.sort_by(|a, b| b.score.completed_at.cmp(&a.score.completed_at));
    let mut top_scores = entries;
    top_scores.sort_by(|a, b| {
        b.score
            .score
            .cmp(&a.score.score)
            .then_with(|| b.score.completed_at.cmp(&a.score.completed_at))
    });
    top_scores.truncate(10);
    Ok(LocalScores {
        personal_bests: personal_bests
            .into_iter()
            .map(|(game_type, score)| LocalScoreBest { game_type, score })
            .collect(),
        recent,
        top_scores,
    })
}

fn append_local_score_to(
    path: &std::path::Path,
    score: LocalScoreInput,
) -> Result<LocalScoreEntry, String> {
    if !safe_recording_id(&score.game_id, "game_")
        || score.game_type.is_empty()
        || score.game_type.len() > 80
        || score.variation_id.is_empty()
        || score.variation_id.len() > 80
        || score.score < 0
        || score.completed_at.len() > 40
        || !score.completed_at.ends_with('Z')
        || !matches!(score.platform.as_str(), "terminal" | "overlay")
    {
        return Err("Completed-game score is invalid.".to_string());
    }
    let directory = path
        .parent()
        .ok_or_else(|| "Score log path is invalid.".to_string())?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the score log: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the score log: {error}"))?;
    }

    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Could not read the score log: {error}")),
    };
    let entries = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<LocalScoreEntry>(line).ok())
        .collect::<Vec<_>>();
    if let Some(existing) = entries
        .iter()
        .find(|entry| entry.score.game_id == score.game_id)
    {
        if existing.score != score {
            return Err(format!(
                "Score {} conflicts with its local record.",
                score.game_id
            ));
        }
        return Ok(existing.clone());
    }

    // ponytail: scan JSONL on append; add an index only if real score histories make this slow.
    let previous_best = entries
        .iter()
        .filter(|entry| entry.score.game_type == score.game_type)
        .map(|entry| entry.score.score)
        .max();
    let high_score_updated = previous_best.map_or(true, |best| score.score > best);
    let entry = LocalScoreEntry {
        schema_version: 1,
        personal_best: previous_best.map_or(score.score, |best| best.max(score.score)),
        high_score_updated,
        score,
    };
    let line = serde_json::to_string(&entry)
        .map_err(|error| format!("Could not serialize the score: {error}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not open the score log: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not secure the score log: {error}"))?;
    }
    if !contents.is_empty() && !contents.ends_with('\n') {
        writeln!(file).map_err(|error| format!("Could not repair the score log: {error}"))?;
    }
    writeln!(file, "{line}").map_err(|error| format!("Could not append the score: {error}"))?;
    file.sync_data()
        .map_err(|error| format!("Could not flush the score log: {error}"))?;
    Ok(entry)
}

#[tauri::command]
fn append_local_score(score: LocalScoreInput) -> Result<LocalScoreEntry, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("scores")
        .join("history.jsonl");
    append_local_score_to(&path, score)
}

#[tauri::command]
fn read_local_scores() -> Result<LocalScores, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("scores")
        .join("history.jsonl");
    read_local_scores_from(&path)
}

fn auth_session_path() -> Option<PathBuf> {
    tui_gamepigeon_dir().map(|dir| dir.join("auth.json"))
}

#[derive(Deserialize)]
struct StoredSessionUser {
    id: String,
    email: String,
}

#[derive(Deserialize)]
struct StoredSession {
    #[serde(rename = "sessionToken")]
    session_token: String,
    user: StoredSessionUser,
}

fn read_stored_session() -> Option<StoredSession> {
    let path = auth_session_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    let session: StoredSession = serde_json::from_str(&content).ok()?;
    if session.session_token.is_empty()
        || session.user.id.is_empty()
        || session.user.email.is_empty()
    {
        return None;
    }
    Some(session)
}

#[tauri::command]
fn read_auth_session() -> Option<AuthUser> {
    read_stored_session().map(|session| AuthUser {
        id: session.user.id,
        email: session.user.email,
    })
}

// Deletes a credential file, treating "already gone" as success but surfacing
// any real failure (e.g. permissions) so sign-out never falsely claims success.
fn remove_credential(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove {}: {error}", path.display())),
    }
}

#[tauri::command]
fn sign_out() -> Result<(), String> {
    let dir =
        tui_gamepigeon_dir().ok_or_else(|| "Could not resolve home directory.".to_string())?;
    // Attempt both, but report failure if either credential is left behind.
    let auth = remove_credential(&dir.join("auth.json"));
    let backend = remove_credential(&dir.join("backend.conf"));
    auth.and(backend)
}

fn recording_pending_dir() -> Result<PathBuf, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("recordings")
        .join("overlay-pending");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the recording queue: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the recording queue: {error}"))?;
    }
    Ok(path)
}

fn recording_completed_dir() -> Result<PathBuf, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("recordings")
        .join("overlay-completed");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the recording archive: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the recording archive: {error}"))?;
    }
    Ok(path)
}

// Chunks the backend refuses outright land here so the rest of the queue can
// still drain. Nothing deletes them: they stay on disk for later inspection.
fn recording_failed_dir() -> Result<PathBuf, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("recordings")
        .join("overlay-failed");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the recording quarantine: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the recording quarantine: {error}"))?;
    }
    Ok(path)
}

fn recording_results_dir(state: &str) -> Result<PathBuf, String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("recordings")
        .join("results")
        .join(format!("overlay-{state}"));
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not create the result queue: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the result queue: {error}"))?;
    }
    Ok(path)
}

fn archive_uploaded_recording_to(
    path: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| "Uploaded recording path is invalid.".to_string())?;
    let destination = directory.join(name);
    if destination.exists() {
        let pending = std::fs::read(path)
            .map_err(|error| format!("Could not verify an uploaded recording: {error}"))?;
        let archived = std::fs::read(&destination)
            .map_err(|error| format!("Could not verify the recording archive: {error}"))?;
        if pending != archived {
            return Err("Uploaded recording conflicts with its local archive.".to_string());
        }
        std::fs::remove_file(path)
            .map_err(|error| format!("Could not clear the duplicate recording: {error}"))?;
        return Ok(());
    }
    std::fs::rename(path, destination)
        .map_err(|error| format!("Could not archive an uploaded recording: {error}"))
}

// Unlike archiving, this must always clear the queue slot — a rejected chunk
// that stays behind would block the drain again on the next pass — so an
// existing quarantine entry with the same name is simply replaced.
fn quarantine_rejected_recording(
    path: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| "Rejected recording path is invalid.".to_string())?;
    std::fs::rename(path, directory.join(name))
        .map_err(|error| format!("Could not quarantine a rejected recording: {error}"))
}

fn recording_backend_credentials() -> Result<(String, String), String> {
    let path = tui_gamepigeon_dir()
        .ok_or_else(|| "Could not resolve home directory.".to_string())?
        .join("backend.conf");
    if let Ok(contents) = std::fs::read_to_string(path) {
        let mut lines = contents.lines();
        if let (Some(base), Some(token)) = (lines.next(), lines.next()) {
            if !base.trim().is_empty() && !token.trim().is_empty() {
                return Ok((
                    base.trim().trim_end_matches('/').to_string(),
                    token.trim().to_string(),
                ));
            }
        }
    }
    let session =
        read_stored_session().ok_or_else(|| "Sign in before recording gameplay.".to_string())?;
    Ok((backend_base_url(), session.session_token))
}

fn resolve_recording_user(base: &str, token: &str) -> Result<String, String> {
    let url = format!("{base}/v1/me");
    let response = recording_request_with_backoff(
        || {
            ureq::get(&url)
                .set("authorization", &format!("Bearer {token}"))
                .call()
        },
        RECORDING_RETRY_DELAYS_MS,
    )
    .map_err(|_| "Could not verify the recording account.".to_string())?;
    let body: serde_json::Value = response
        .into_json()
        .map_err(|_| "The recording account response was malformed.".to_string())?;
    body.get("user_id")
        .and_then(|value| value.as_str())
        .filter(|value| safe_recording_id(value, "usr_"))
        .map(str::to_string)
        .ok_or_else(|| "The recording account response was malformed.".to_string())
}

fn safe_recording_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn canonicalize_recording_chunk(
    chunk: &mut serde_json::Value,
    user_id: &str,
) -> Result<(), String> {
    if chunk.get("schema_version").and_then(|value| value.as_u64()) != Some(2) {
        return Err("Only interaction trace schema v2 is accepted.".to_string());
    }
    let game_id = chunk
        .get("game_id")
        .and_then(|value| value.as_str())
        .filter(|value| safe_recording_id(value, "game_"))
        .ok_or_else(|| "Recording game_id is invalid.".to_string())?
        .to_string();
    let chunk_id = chunk
        .get("chunk_id")
        .and_then(|value| value.as_str())
        .filter(|value| safe_recording_id(value, "chk_"))
        .ok_or_else(|| "Recording chunk_id is invalid.".to_string())?
        .to_string();
    let chunk_sequence = chunk
        .get("chunk_sequence")
        .and_then(|value| value.as_u64())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Recording chunk_sequence is invalid.".to_string())?;
    let first = chunk
        .get("first_event_sequence")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "Recording event range is invalid.".to_string())?;
    let last = chunk
        .get("last_event_sequence")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "Recording event range is invalid.".to_string())?;
    if chunk
        .get("client")
        .and_then(|value| value.get("platform"))
        .and_then(|value| value.as_str())
        != Some("tui")
    {
        return Err("Recording client platform is invalid.".to_string());
    }

    let declared_event_count = chunk.get("event_count").and_then(|value| value.as_u64());
    let events = chunk
        .get_mut("events")
        .and_then(|value| value.as_array_mut())
        .ok_or_else(|| "Recording events are invalid.".to_string())?;
    if events.is_empty() || events.len() > 50 || chunk_sequence > 10_000 {
        return Err("Recording event count is invalid.".to_string());
    }
    if declared_event_count != Some(events.len() as u64) {
        return Err("Recording event count does not match.".to_string());
    }
    for (index, event) in events.iter_mut().enumerate() {
        let sequence = event
            .get("event_sequence")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "Recording event sequence is invalid.".to_string())?;
        if sequence != first + index as u64
            || event.get("game_id").and_then(|value| value.as_str()) != Some(&game_id)
            || event.get("chunk_id").and_then(|value| value.as_str()) != Some(&chunk_id)
        {
            return Err("Recording event envelope does not match its chunk.".to_string());
        }
        event["user_id"] = serde_json::Value::String(user_id.to_string());
    }
    if last != first + events.len() as u64 - 1 {
        return Err("Recording event range does not match.".to_string());
    }
    chunk["user_id"] = serde_json::Value::String(user_id.to_string());
    let bytes =
        serde_json::to_vec(chunk).map_err(|_| "Could not serialize the recording.".to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("Recording chunk exceeds 128 KiB.".to_string());
    }
    Ok(())
}

fn recording_ack_matches(chunk: &serde_json::Value, ack: &serde_json::Value) -> bool {
    ack.get("accepted").and_then(|value| value.as_bool()) == Some(true)
        && ack.get("queued").and_then(|value| value.as_bool()) == Some(true)
        && ack.get("game_id") == chunk.get("game_id")
        && ack.get("chunk_id") == chunk.get("chunk_id")
        && ack.get("chunk_sequence") == chunk.get("chunk_sequence")
        && ack.pointer("/accepted_event_range/first") == chunk.get("first_event_sequence")
        && ack.pointer("/accepted_event_range/last") == chunk.get("last_event_sequence")
}

fn result_upload_succeeded(status: u16) -> bool {
    matches!(status, 200 | 202)
}

fn retryable_recording_error(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Status(status, _) => matches!(status, 408 | 425 | 429) || *status >= 500,
        ureq::Error::Transport(_) => true,
    }
}

const RECORDING_RETRY_DELAYS_MS: &[u64] = &[1_000, 2_000, 4_000, 8_000, 30_000, 60_000];

// A stale token, a revoked session, or a misconfigured backend URL rejects every
// upload with the same status no matter what the payload is. Quarantining on
// those would empty the queue for a reason the user can fix by signing in again,
// so they stay queued and pause the drain instead.
fn recoverable_recording_status(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 405 | 407)
}

// Separates "this upload will never succeed" from "the network, the session, or
// the server is having a moment". Only the former quarantines a chunk; transport
// failures, exhausted retries, and the statuses above leave it queued for the
// next drain.
fn recording_rejection_reason(error: &ureq::Error) -> Option<String> {
    match error {
        ureq::Error::Status(status, _)
            if !retryable_recording_error(error) && !recoverable_recording_status(*status) =>
        {
            Some(format!("the server rejected it with HTTP {status}"))
        }
        _ => None,
    }
}

fn recording_request_with_backoff(
    mut request: impl FnMut() -> Result<ureq::Response, ureq::Error>,
    delays_ms: &[u64],
) -> Result<ureq::Response, Box<ureq::Error>> {
    let mut attempt = 0;
    loop {
        match request() {
            Ok(response) => return Ok(response),
            Err(error) if retryable_recording_error(&error) && attempt < delays_ms.len() => {
                std::thread::sleep(std::time::Duration::from_millis(delays_ms[attempt]));
                attempt += 1;
            }
            Err(error) => return Err(Box::new(error)),
        }
    }
}

fn post_recording_json(
    url: &str,
    token: &str,
    body: &str,
) -> Result<ureq::Response, Box<ureq::Error>> {
    recording_request_with_backoff(
        || {
            ureq::post(url)
                .set("authorization", &format!("Bearer {token}"))
                .set("content-type", "application/json")
                .send_string(body)
        },
        RECORDING_RETRY_DELAYS_MS,
    )
}

fn validate_recording_result(result: &serde_json::Value) -> Result<(), String> {
    result
        .get("result_id")
        .and_then(|value| value.as_str())
        .filter(|value| safe_recording_id(value, "res_"))
        .ok_or_else(|| "Recording result_id is invalid.".to_string())?;
    result
        .get("game_id")
        .and_then(|value| value.as_str())
        .filter(|value| safe_recording_id(value, "game_"))
        .ok_or_else(|| "Recording result game_id is invalid.".to_string())?;
    result
        .get("game_type")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .ok_or_else(|| "Recording result game_type is invalid.".to_string())?;
    result
        .get("score")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "Recording result score is invalid.".to_string())?;
    result
        .get("completed_at")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .ok_or_else(|| "Recording result completion time is invalid.".to_string())?;
    if serde_json::to_vec(result)
        .map_err(|_| "Could not serialize the result.".to_string())?
        .len()
        > 16 * 1024
    {
        return Err("Recording result exceeds 16 KiB.".to_string());
    }
    Ok(())
}

fn canonicalize_recording_result(result: &mut serde_json::Value) -> Result<(), String> {
    if let Some(suffix) = result
        .get("result_id")
        .and_then(|value| value.as_str())
        .and_then(|value| value.strip_prefix("result_"))
    {
        result["result_id"] = serde_json::Value::String(format!("res_{suffix}"));
    }
    validate_recording_result(result)
}

fn persist_recording_result_to(
    result: &serde_json::Value,
    pending: &std::path::Path,
    completed: &std::path::Path,
) -> Result<(), String> {
    validate_recording_result(result)?;
    let result_id = result["result_id"].as_str().unwrap();
    let name = format!("{result_id}.json");
    let bytes =
        serde_json::to_vec(result).map_err(|_| "Could not serialize the result.".to_string())?;
    for path in [pending.join(&name), completed.join(&name)] {
        if !path.exists() {
            continue;
        }
        let existing = std::fs::read(&path)
            .map_err(|error| format!("Could not verify a queued result: {error}"))?;
        return if existing == bytes {
            Ok(())
        } else {
            Err(format!(
                "Recording result {result_id} has conflicting bytes."
            ))
        };
    }
    let path = pending.join(name);
    let temporary = path.with_extension(format!("tmp-{}", generate_nonce()));
    write_private(&temporary, std::str::from_utf8(&bytes).unwrap())
        .map_err(|error| format!("Could not queue the result: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not commit the result queue: {error}"))
}

fn persist_recording_result(result: &serde_json::Value) -> Result<(), String> {
    persist_recording_result_to(
        result,
        &recording_results_dir("pending")?,
        &recording_results_dir("completed")?,
    )
}

fn persist_recording_chunk_to(
    chunk: &mut serde_json::Value,
    pending: &std::path::Path,
    completed: &std::path::Path,
) -> Result<(), String> {
    let game_id = chunk["game_id"].as_str().unwrap().to_string();
    let chunk_id = chunk["chunk_id"].as_str().unwrap().to_string();
    let sequence = chunk["chunk_sequence"].as_u64().unwrap();
    let name = format!("{game_id}-{sequence:06}-{chunk_id}.json");
    for path in [pending.join(&name), completed.join(&name)] {
        if !path.exists() {
            continue;
        }
        let existing_bytes = std::fs::read(&path)
            .map_err(|error| format!("Could not verify a queued recording: {error}"))?;
        let existing: serde_json::Value = serde_json::from_slice(&existing_bytes)
            .map_err(|_| "A queued recording is malformed.".to_string())?;
        let existing_user = existing
            .get("user_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "A queued recording has no user.".to_string())?;
        canonicalize_recording_chunk(chunk, existing_user)?;
        let bytes = serde_json::to_vec(chunk)
            .map_err(|_| "Could not serialize the recording.".to_string())?;
        if bytes == existing_bytes {
            return Ok(());
        }
        return Err(format!("Recording chunk {chunk_id} has conflicting bytes."));
    }
    let path = pending.join(name);
    let temporary = path.with_extension(format!("tmp-{}", generate_nonce()));
    let bytes =
        serde_json::to_vec(chunk).map_err(|_| "Could not serialize the recording.".to_string())?;
    write_private(&temporary, std::str::from_utf8(&bytes).unwrap())
        .map_err(|error| format!("Could not queue the recording: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not commit the recording queue: {error}"))
}

fn persist_recording_chunk(chunk: &mut serde_json::Value) -> Result<(), String> {
    persist_recording_chunk_to(
        chunk,
        &recording_pending_dir()?,
        &recording_completed_dir()?,
    )
}

// What happened to one queued item. `Rejected` carries the reason the chunk is
// hopeless, so the drain can quarantine it and keep going; anything that could
// succeed later is reported as an `Err` from the upload helpers instead, which
// aborts the drain and leaves the whole queue intact.
enum RecordingUpload {
    Uploaded,
    Rejected(String),
}

fn upload_pending_chunk(
    path: &std::path::Path,
    base: &str,
    token: &str,
    user_id: &str,
) -> Result<RecordingUpload, String> {
    let queued = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read a queued recording: {error}"))?;
    let Ok(mut chunk) = serde_json::from_str::<serde_json::Value>(&queued) else {
        return Ok(RecordingUpload::Rejected(
            "it is malformed JSON".to_string(),
        ));
    };
    if let Err(reason) = canonicalize_recording_chunk(&mut chunk, user_id) {
        return Ok(RecordingUpload::Rejected(reason));
    }
    let Ok(bytes) = serde_json::to_string(&chunk) else {
        return Ok(RecordingUpload::Rejected(
            "it could not be serialized".to_string(),
        ));
    };
    let stamped = path.with_extension(format!("tmp-{}", generate_nonce()));
    write_private(&stamped, &bytes)
        .map_err(|error| format!("Could not stamp the recording identity: {error}"))?;
    std::fs::rename(&stamped, path)
        .map_err(|error| format!("Could not commit the recording identity: {error}"))?;
    let response = match post_recording_json(&format!("{base}/v1/game-event-chunks"), token, &bytes)
    {
        Ok(response) => response,
        Err(error) => {
            return match recording_rejection_reason(&error) {
                Some(reason) => Ok(RecordingUpload::Rejected(reason)),
                None => Err(format!("Recording upload failed: {error}")),
            };
        }
    };
    if response.status() != 202 {
        return Ok(RecordingUpload::Rejected(format!(
            "the upload returned HTTP {}",
            response.status()
        )));
    }
    let Ok(ack) = response.into_json::<serde_json::Value>() else {
        return Ok(RecordingUpload::Rejected(
            "the acknowledgment was malformed".to_string(),
        ));
    };
    if !recording_ack_matches(&chunk, &ack) {
        return Ok(RecordingUpload::Rejected(
            "the acknowledgment did not match".to_string(),
        ));
    }
    Ok(RecordingUpload::Uploaded)
}

fn upload_pending_result(
    path: &std::path::Path,
    base: &str,
    token: &str,
) -> Result<RecordingUpload, String> {
    let queued = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read a queued result: {error}"))?;
    let Ok(mut result) = serde_json::from_str::<serde_json::Value>(&queued) else {
        return Ok(RecordingUpload::Rejected(
            "it is malformed JSON".to_string(),
        ));
    };
    if let Err(reason) = canonicalize_recording_result(&mut result) {
        return Ok(RecordingUpload::Rejected(reason));
    }
    let Ok(bytes) = serde_json::to_string(&result) else {
        return Ok(RecordingUpload::Rejected(
            "it could not be serialized".to_string(),
        ));
    };
    let stamped = path.with_extension(format!("tmp-{}", generate_nonce()));
    write_private(&stamped, &bytes)
        .map_err(|error| format!("Could not migrate the queued result: {error}"))?;
    std::fs::rename(&stamped, path)
        .map_err(|error| format!("Could not commit the queued result: {error}"))?;
    let response = match post_recording_json(&format!("{base}/v1/game-results"), token, &bytes) {
        Ok(response) => response,
        Err(error) => {
            return match recording_rejection_reason(&error) {
                Some(reason) => Ok(RecordingUpload::Rejected(reason)),
                None => Err(format!("Result upload failed: {error}")),
            };
        }
    };
    if !result_upload_succeeded(response.status()) {
        return Ok(RecordingUpload::Rejected(format!(
            "the upload returned HTTP {}",
            response.status()
        )));
    }
    let Ok(ack) = response.into_json::<serde_json::Value>() else {
        return Ok(RecordingUpload::Rejected(
            "the acknowledgment was malformed".to_string(),
        ));
    };
    if ack.get("accepted").and_then(|value| value.as_bool()) != Some(true)
        || ack
            .get("personal_best")
            .and_then(|value| value.as_i64())
            .is_none()
        || ack
            .get("high_score_updated")
            .and_then(|value| value.as_bool())
            .is_none()
    {
        return Ok(RecordingUpload::Rejected(
            "the acknowledgment did not match".to_string(),
        ));
    }
    Ok(RecordingUpload::Uploaded)
}

fn queued_json_paths(directory: &std::path::Path, label: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = std::fs::read_dir(directory)
        .map_err(|error| format!("Could not read the {label}: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

// What one drain pass did. `rejected` is why the caller cannot treat a pass as a
// clean sync: quarantining empties the queue without anything reaching the cloud.
struct RecordingDrain {
    uploaded: usize,
    rejected: usize,
}

fn drain_pending_recordings() -> Result<RecordingDrain, String> {
    if !arcade_setting_enabled("cloudGameplaySync", true) {
        return Ok(RecordingDrain { uploaded: 0, rejected: 0 });
    }
    let _drain = RECORDING_DRAIN
        .try_lock()
        .map_err(|_| "Recording sync is already running.".to_string())?;
    let (base, token) = recording_backend_credentials()?;
    let user_id = resolve_recording_user(&base, &token)?;
    let completed = recording_completed_dir()?;
    let failed = recording_failed_dir()?;
    let mut uploaded = 0;
    let mut rejected = 0;
    for path in queued_json_paths(&recording_pending_dir()?, "recording queue")? {
        match upload_pending_chunk(&path, &base, &token, &user_id)? {
            RecordingUpload::Uploaded => {
                archive_uploaded_recording_to(&path, &completed)?;
                uploaded += 1;
            }
            RecordingUpload::Rejected(reason) => {
                quarantine_rejected_recording(&path, &failed)?;
                rejected += 1;
                eprintln!(
                    "Quarantined recording {} because {reason}.",
                    path.file_name().unwrap_or_default().to_string_lossy()
                );
            }
        }
    }
    let results_pending = recording_results_dir("pending")?;
    let results_completed = recording_results_dir("completed")?;
    let results_failed = recording_results_dir("failed")?;
    for path in queued_json_paths(&results_pending, "result queue")? {
        match upload_pending_result(&path, &base, &token)? {
            RecordingUpload::Uploaded => {
                archive_uploaded_recording_to(&path, &results_completed)?;
                uploaded += 1;
            }
            RecordingUpload::Rejected(reason) => {
                quarantine_rejected_recording(&path, &results_failed)?;
                rejected += 1;
                eprintln!(
                    "Quarantined result {} because {reason}.",
                    path.file_name().unwrap_or_default().to_string_lossy()
                );
            }
        }
    }
    Ok(RecordingDrain { uploaded, rejected })
}

#[derive(Serialize)]
struct RecordingQueueResult {
    queued: usize,
    results_queued: usize,
    uploaded: usize,
}

fn queue_recording_chunks_blocking(
    mut chunks: Vec<serde_json::Value>,
    result: Option<serde_json::Value>,
) -> Result<RecordingQueueResult, String> {
    if chunks.is_empty() || chunks.len() > 256 {
        return Err("Recording chunk batch size is invalid.".to_string());
    }
    for chunk in &mut chunks {
        canonicalize_recording_chunk(chunk, "usr_pending")?;
    }
    if let Some(result) = &result {
        validate_recording_result(result)?;
    }
    for chunk in &mut chunks {
        persist_recording_chunk(chunk)?;
    }
    if let Some(result) = &result {
        persist_recording_result(result)?;
    }
    Ok(RecordingQueueResult {
        queued: chunks.len(),
        results_queued: usize::from(result.is_some()),
        uploaded: 0,
    })
}

#[tauri::command]
async fn queue_recording_chunks(
    app: AppHandle,
    chunks: Vec<serde_json::Value>,
    result: Option<serde_json::Value>,
) -> Result<RecordingQueueResult, String> {
    let queued = tauri::async_runtime::spawn_blocking(move || {
        queue_recording_chunks_blocking(chunks, result)
    })
    .await
    .map_err(|error| format!("Recording queue task failed: {error}"))??;
    std::thread::spawn(move || {
        drain_recordings_and_notify(&app);
    });
    Ok(queued)
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
}

#[cfg(unix)]
fn write_private_atomic(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", generate_nonce()));
    if let Err(error) =
        write_private(&temporary, contents).and_then(|_| std::fs::rename(&temporary, path))
    {
        let _ = std::fs::remove_file(temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_private_atomic(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    write_private(path, contents)
}

// Writes both auth.json and backend.conf exactly like the CLI's saveSession, so
// an overlay sign-in leaves sync/recording authenticated too.
fn store_session_to(
    dir: &std::path::Path,
    backend_base: &str,
    token: &str,
    user: &AuthUser,
) -> Result<(), String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create config directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not secure config directory: {e}"))?;
    }

    let auth_json = serde_json::json!({
        "sessionToken": token,
        "user": { "id": user.id, "email": user.email },
    })
    .to_string();

    // Commit backend auth first: a visible signed-in session must never point
    // recording at an older bearer after a crash or failed write.
    let backend_conf = format!("{backend_base}\n{token}\n");
    write_private_atomic(&dir.join("backend.conf"), &backend_conf)
        .map_err(|e| format!("Could not save the backend session: {e}"))?;
    write_private_atomic(&dir.join("auth.json"), &auth_json)
        .map_err(|e| format!("Could not save the session: {e}"))?;
    Ok(())
}

fn store_session(token: &str, user: &AuthUser) -> Result<(), String> {
    let dir =
        tui_gamepigeon_dir().ok_or_else(|| "Could not resolve home directory.".to_string())?;
    store_session_to(&dir, &backend_base_url(), token, user)
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn build_login_url(callback_port: u16, nonce: &str) -> String {
    let base = login_base_url();
    let separator = if base.contains('?') { '&' } else { '?' };
    // The nonce rides on the callback URL so the hosted page hands it back to us.
    let callback = format!("http://127.0.0.1:{callback_port}/auth/callback?state={nonce}");
    format!(
        "{base}{separator}auth_url={}&callback={}&plugin=1",
        percent_encode(&auth_base_url()),
        percent_encode(&callback),
    )
}

/// Runs an opener and reports whether it actually succeeded. `spawn` alone
/// can't tell us that — `xdg-open` with no handler and `open` with a broken
/// default browser both fail *after* the spawn — so we wait for the exit
/// status. Every opener returns promptly (it hands the URL to the browser and
/// exits), so this doesn't block the sign-in click for any noticeable time.
fn run_opener(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The bundle id macOS would hand an `https` URL to, read from LaunchServices.
/// Used only to detect Arc (see `open_in_arc`); any parse failure just means we
/// take the ordinary `open` path.
#[cfg(target_os = "macos")]
fn default_https_handler() -> Option<String> {
    let output = Command::new("defaults")
        .args([
            "read",
            "com.apple.LaunchServices/com.apple.launchservices.secure",
        ])
        .output()
        .ok()?;
    parse_default_https_handler(&String::from_utf8_lossy(&output.stdout))
}

/// `defaults read` prints one dict per registered handler; the role and the
/// scheme are separate lines inside the same `{ ... }` block, so we scan block
/// by block for the one claiming `https`.
fn parse_default_https_handler(plist: &str) -> Option<String> {
    for block in plist.split('{') {
        if !block.contains("LSHandlerURLScheme = https;") {
            continue;
        }
        let line = block
            .lines()
            .find(|line| line.trim_start().starts_with("LSHandlerRoleAll = "))?;
        let value = line.trim().trim_start_matches("LSHandlerRoleAll = ");
        let value = value.trim_end_matches(';').trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Arc (and Dia, same vendor) route links from other apps into a "Little Arc"
/// window, which drops the hosted login page's redirect chain — the tab either
/// never appears or dies mid-handoff, so sign-in silently never completes.
/// Asking Arc for a real tab in a real window over AppleScript bypasses Little
/// Arc entirely.
fn is_arc_bundle(bundle_id: &str) -> bool {
    let id = bundle_id.to_ascii_lowercase();
    id == "company.thebrowser.browser" || id == "company.thebrowser.dia"
}

#[cfg(target_os = "macos")]
fn open_in_arc(bundle_id: &str, url: &str) -> bool {
    let script = format!(
        r#"tell application id "{}"
    activate
    if (count of windows) is 0 then
        make new window
    end if
    tell front window to make new tab with properties {{URL:"{}"}}
end tell"#,
        applescript_escape(bundle_id),
        applescript_escape(url),
    );
    run_opener("osascript", &["-e", &script])
}

/// Hands the login URL to the user's browser. Returns false when every opener
/// we know about failed — the overlay then leads with the fallback link
/// instead of claiming a browser is opening.
fn open_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle_id) = default_https_handler() {
            if is_arc_bundle(&bundle_id) && open_in_arc(&bundle_id, url) {
                return true;
            }
        }
        // Safari is the last resort: it is always present, so a broken or
        // missing default handler still gets the user to the login page.
        run_opener("open", &[url]) || run_opener("open", &["-a", "Safari", url])
    }
    #[cfg(target_os = "windows")]
    {
        run_opener("cmd", &["/c", "start", "", url])
            || run_opener("rundll32", &["url.dll,FileProtocolHandler", url])
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        run_opener("xdg-open", &[url])
            || run_opener("gio", &["open", url])
            || run_opener("x-www-browser", &[url])
    }
}

enum CallbackOutcome {
    Pending,
    Token(String),
    Failed(String),
}

// Tolerant of both `&` and `?` separators: some hosted redirects append `?token`
// onto a callback that already carried `?state`, yielding `state=..?token=..`.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split(['&', '?']) {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(key) {
            return parts.next().map(|value| value.replace('+', " "));
        }
    }
    None
}

// Percent-decoding for human-readable query text (OAuth error descriptions).
// Tokens deliberately skip this: they round-trip through the listener verbatim.
fn percent_decode(value: &str) -> String {
    // Byte-wise on purpose: slicing `value` by byte offsets would panic on a
    // `%` that lands mid-character in malformed input.
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match (bytes[index], bytes.get(index + 1), bytes.get(index + 2)) {
            (b'%', Some(&high), Some(&low)) => match (hex(high), hex(low)) {
                (Some(high), Some(low)) => {
                    out.push(high * 16 + low);
                    index += 3;
                }
                _ => {
                    out.push(b'%');
                    index += 1;
                }
            },
            (byte, _, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// Turns a failed handoff (`?error=...`) into a sentence worth showing. Capped
// because it lands in both the browser page and the overlay's status line.
fn callback_failure(query: &str) -> Option<String> {
    let error = query_param(query, "error").filter(|error| !error.is_empty())?;
    if error == "access_denied" {
        return Some("Sign-in was cancelled before it finished.".to_string());
    }
    let message = match query_param(query, "error_description")
        .map(|description| percent_decode(&description))
        .filter(|description| !description.is_empty())
    {
        Some(description) => description,
        None => format!(
            "The login page reported an error: {}",
            percent_decode(&error)
        ),
    };
    Some(message.chars().take(200).collect())
}

// Handles one localhost connection using a minimal HTTP/1.1 response. Replies to
// /auth/ping so the hosted login page's readiness probe passes, and extracts the
// session token from /auth/callback?state=<nonce>&token=... — only when the state
// matches the nonce this attempt issued.
fn handle_callback_connection(
    mut stream: std::net::TcpStream,
    expected_state: &str,
) -> CallbackOutcome {
    let mut buffer = [0u8; 4096];
    let read = match stream.read(&mut buffer) {
        Ok(read) => read,
        Err(_) => return CallbackOutcome::Pending,
    };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let mut reply = |status: &str, content_type: &str, body: &str| {
        let response = format!(
            // Pages carry a session token in their URL — keep them out of
            // caches and out of the Referer sent to anything they link to.
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    };

    if path == "/auth/ping" {
        reply("200 OK", "text/plain; charset=utf-8", "ok");
        return CallbackOutcome::Pending;
    }
    if path != "/auth/callback" {
        reply("404 Not Found", "text/plain; charset=utf-8", "not found");
        return CallbackOutcome::Pending;
    }
    // Reject any callback whose state doesn't match this attempt's nonce, so a
    // racing local client cannot substitute its own account via our listener.
    // A stale tab from a cancelled attempt lands here too, so the page explains
    // itself rather than showing a bare "forbidden".
    let state = query_param(query, "state").unwrap_or_default();
    if state != expected_state {
        reply(
            "403 Forbidden",
            "text/html; charset=utf-8",
            &stale_attempt_page(),
        );
        return CallbackOutcome::Pending;
    }
    // A login page that gave up hands back `error` instead of `token`; saying
    // why beats the generic "did not return a session token".
    if let Some(reason) = callback_failure(query) {
        reply(
            "400 Bad Request",
            "text/html; charset=utf-8",
            &sign_in_failed_page(&escape_html(&reason)),
        );
        return CallbackOutcome::Failed(reason);
    }
    match query_param(query, "token").filter(|token| !token.is_empty()) {
        Some(token) => {
            reply("200 OK", "text/html; charset=utf-8", &signed_in_page());
            CallbackOutcome::Token(token)
        }
        None => {
            let reason = "The login page came back without a session token.".to_string();
            reply(
                "400 Bad Request",
                "text/html; charset=utf-8",
                &sign_in_failed_page(&escape_html(&reason)),
            );
            CallbackOutcome::Failed(reason)
        }
    }
}

fn resolve_user(token: &str) -> Result<AuthUser, String> {
    let url = format!("{}/api/auth/get-session", auth_base_url());
    let response = ureq::get(&url)
        .set("authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|_| "Could not verify the sign-in. Try again.".to_string())?;
    let json: serde_json::Value = response
        .into_json()
        .map_err(|_| "Unexpected sign-in response.".to_string())?;
    let id = json.pointer("/user/id").and_then(|value| value.as_str());
    let email = json.pointer("/user/email").and_then(|value| value.as_str());
    match (id, email) {
        (Some(id), Some(email)) if !id.is_empty() && !email.is_empty() => Ok(AuthUser {
            id: id.to_string(),
            email: email.to_string(),
        }),
        _ => Err("Sign-in did not return an account.".to_string()),
    }
}

fn dispatch_overlay_event(app: &AppHandle, event: &str, detail: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script =
            format!("window.dispatchEvent(new CustomEvent('{event}', {{ detail: {detail} }}))",);
        let _ = window.eval(&script);
    }
}

#[tauri::command]
fn read_sync_error() -> Option<String> {
    SYNC_ERROR.lock().ok().and_then(|message| message.clone())
}

fn recording_sync_has_pending() -> bool {
    for directory in [recording_pending_dir(), recording_results_dir("pending")] {
        let Ok(directory) = directory else {
            continue;
        };
        if std::fs::read_dir(directory).is_ok_and(|mut entries| {
            entries.any(|entry| {
                entry.is_ok_and(|entry| {
                    entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                })
            })
        }) {
            return true;
        }
    }
    false
}

fn drain_recordings_and_notify(app: &AppHandle) {
    loop {
        match drain_pending_recordings() {
            Ok(drain) if drain.rejected == 0 && recording_sync_has_pending() => continue,
            // Quarantining clears the queue, so a pass that only quarantined would
            // otherwise look identical to a clean sync. Say what was dropped.
            Ok(drain) if drain.rejected > 0 => {
                let detail = format!(
                    "Cloud sync uploaded {} recording(s) but the backend rejected {}. The rejected ones are kept in ~/.tui-gamepigeon/recordings/overlay-failed/ and results/overlay-failed/ — nothing was deleted.",
                    drain.uploaded, drain.rejected
                );
                eprintln!("{detail}");
                if let Ok(mut sync_error) = SYNC_ERROR.lock() {
                    *sync_error = Some(detail.clone());
                }
                dispatch_overlay_event(app, "gamepigeon:sync-error", &js_string(&detail));
                break;
            }
            Ok(_) => {
                if let Ok(mut sync_error) = SYNC_ERROR.lock() {
                    *sync_error = None;
                }
                dispatch_overlay_event(app, "gamepigeon:sync-success", "null");
                break;
            }
            Err(message) if message == "Recording sync is already running." => break,
            Err(message) => {
                let detail = format!(
                    "Cloud sync is paused: {message} Your game is saved locally. Check your connection or sign in again."
                );
                eprintln!("{detail}");
                if let Ok(mut sync_error) = SYNC_ERROR.lock() {
                    *sync_error = Some(detail.clone());
                }
                dispatch_overlay_event(app, "gamepigeon:sync-error", &js_string(&detail));
                break;
            }
        }
    }
}

/// What the overlay needs to render its own recovery path: the exact URL the
/// browser was sent to, and whether that send actually worked.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginHandoff {
    url: String,
    browser_opened: bool,
}

#[tauri::command]
fn start_auth_login(app: AppHandle) -> Result<LoginHandoff, String> {
    // Reject a second attempt while one is already in flight.
    let guard = AuthInProgress::acquire().ok_or_else(|| {
        "A sign-in is already in progress. Finish it in your browser.".to_string()
    })?;

    // Port 0 lets the OS pick any free port, so we never fight the CLI over 3210.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not start the sign-in listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not start the sign-in listener: {e}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not start the sign-in listener: {e}"))?;

    let nonce = generate_nonce();
    let url = build_login_url(port, &nonce);
    // Published before the opener runs so the fallback link is available even
    // if `open` hangs or fails outright.
    set_pending_login_url(Some(url.clone()));
    let browser_opened = open_browser(&url);

    AUTH_CANCELLED.store(false, std::sync::atomic::Ordering::SeqCst);

    let app = app.clone();
    std::thread::spawn(move || {
        // Held for the attempt's lifetime; Drop clears AUTH_IN_PROGRESS on every exit.
        let _guard = guard;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            if AUTH_CANCELLED.load(std::sync::atomic::Ordering::SeqCst) {
                // User-initiated: the overlay has already reset its own UI, so
                // no event needs dispatching here.
                return;
            }
            if std::time::Instant::now() > deadline {
                dispatch_overlay_event(
                    &app,
                    "gamepigeon:auth-error",
                    &js_string("Sign-in timed out. Try again."),
                );
                return;
            }
            match listener.accept() {
                Ok((stream, _)) => match handle_callback_connection(stream, &nonce) {
                    CallbackOutcome::Pending => continue,
                    CallbackOutcome::Failed(message) => {
                        dispatch_overlay_event(&app, "gamepigeon:auth-error", &js_string(&message));
                        return;
                    }
                    CallbackOutcome::Token(token) => {
                        match resolve_user(&token)
                            .and_then(|user| store_session(&token, &user).map(|_| user))
                        {
                            Ok(user) => {
                                let detail = format!("{{ email: {} }}", js_string(&user.email));
                                dispatch_overlay_event(&app, "gamepigeon:auth-success", &detail);
                                std::thread::spawn(move || {
                                    drain_recordings_and_notify(&app);
                                });
                            }
                            Err(message) => {
                                dispatch_overlay_event(
                                    &app,
                                    "gamepigeon:auth-error",
                                    &js_string(&message),
                                );
                            }
                        }
                        return;
                    }
                },
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                Err(error) => {
                    dispatch_overlay_event(
                        &app,
                        "gamepigeon:auth-error",
                        &js_string(&format!("Sign-in listener failed: {error}")),
                    );
                    return;
                }
            }
        }
    });
    Ok(LoginHandoff {
        url,
        browser_opened,
    })
}

/// Re-opens the *current* attempt's login URL. Deliberately not
/// `start_auth_login`: the listener, port and nonce stay as they are, so the
/// user can retry the browser handoff (or click through from the fallback
/// link) without racing a second sign-in against the first.
#[tauri::command]
fn open_login_url() -> Result<(), String> {
    let url = PENDING_LOGIN_URL
        .lock()
        .ok()
        .and_then(|pending| pending.clone())
        .ok_or_else(|| "That sign-in link has expired. Start sign-in again.".to_string())?;
    if open_browser(&url) {
        Ok(())
    } else {
        Err("Could not open your browser. Copy the link instead.".to_string())
    }
}

// Lets the overlay abandon a pending sign-in immediately (e.g. the user
// closed the browser tab) rather than sitting on the 300s timeout. The
// listener thread notices on its next poll (within ~120ms) and exits,
// dropping its AuthInProgress guard so a fresh attempt can start right away.
#[tauri::command]
fn cancel_auth_login() {
    AUTH_CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
    // The listener thread's guard would clear this on its next poll anyway;
    // doing it here means the fallback link stops working the moment the user
    // cancels, not ~120ms later.
    set_pending_login_url(None);
}

#[cfg(test)]
mod worker_model_tests {
    use super::*;

    #[test]
    fn extracts_only_a_non_empty_chat_completion() {
        assert_eq!(
            worker_completion_text(r#"{"choices":[{"message":{"content":"{\"tool\":\"inspect\"}"}}]}"#),
            Ok(r#"{"tool":"inspect"}"#.to_string()),
        );
        assert!(worker_completion_text(r#"{"choices":[]}"#).is_err());
        assert!(worker_completion_text(r#"{"choices":[{"message":{"content":" "}}]}"#).is_err());
    }

    #[test]
    fn worker_http_client_is_reused_across_calls() {
        // A `&'static` pointing at the same address on repeated calls means
        // the OnceLock initializer ran once, not once per request.
        assert!(std::ptr::eq(worker_http_client(), worker_http_client()));
    }

    #[test]
    fn reads_usage_and_finish_reason_when_the_provider_reports_them() {
        let usage = worker_completion_usage(
            r#"{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":80}}}"#,
        );
        assert_eq!(usage.input_tokens, Some(120));
        assert_eq!(usage.output_tokens, Some(40));
        assert_eq!(usage.cached_tokens, Some(80));
        assert_eq!(usage.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn leaves_usage_absent_rather_than_guessing_at_a_missing_field() {
        let usage = worker_completion_usage(r#"{"choices":[{"message":{"content":"hi"}}]}"#);
        assert_eq!(usage.input_tokens, None);
        assert_eq!(usage.output_tokens, None);
        assert_eq!(usage.cached_tokens, None);
        assert_eq!(usage.finish_reason, None);
    }

    #[test]
    fn accepts_only_browser_generated_worker_request_ids() {
        assert!(valid_worker_request_id("d989e6dd-98d8-4e55-a6a4-59a97f2a6345"));
        assert!(!valid_worker_request_id(""));
        assert!(!valid_worker_request_id("request id"));
    }

    use std::time::{Duration, Instant};

    /// The window is driven by the `now` these methods are handed, so a full
    /// minute of budget costs the test no real time.
    fn at(base: Instant, seconds: u64) -> Instant {
        base + Duration::from_secs(seconds)
    }

    #[test]
    fn admits_a_full_window_then_holds_the_next_start() {
        let base = Instant::now();
        let mut budget = RequestBudget::new(20);
        for _ in 0..20 {
            assert_eq!(budget.wait_for(base), None);
            budget.record_start(base);
        }
        // The 21st start waits for the first to leave the window at t=60.
        assert_eq!(budget.wait_for(base), Some(Duration::from_secs(60)));
        assert_eq!(budget.wait_for(at(base, 45)), Some(Duration::from_secs(15)));
        assert_eq!(budget.wait_for(at(base, 60)), None);
    }

    #[test]
    fn a_start_only_occupies_its_own_window() {
        let base = Instant::now();
        let mut budget = RequestBudget::new(2);
        budget.record_start(base);
        budget.record_start(at(base, 30));

        // The first start expires at t=60, the second at t=90.
        assert_eq!(budget.wait_for(at(base, 10)), Some(Duration::from_secs(50)));
        assert_eq!(budget.wait_for(at(base, 60)), None);
        budget.record_start(at(base, 60));
        assert_eq!(budget.wait_for(at(base, 60)), Some(Duration::from_secs(30)));
    }

    #[test]
    fn a_rolling_window_never_admits_more_than_the_budget() {
        // Walk a whole shift's worth of starts through the window one second
        // at a time and check the invariant the account actually enforces.
        let base = Instant::now();
        let mut budget = RequestBudget::new(20);
        let mut admitted: Vec<u64> = Vec::new();
        for second in 0..600u64 {
            let now = at(base, second);
            if budget.wait_for(now).is_none() {
                budget.record_start(now);
                admitted.push(second);
            }
        }
        assert!(!admitted.is_empty());
        for start in &admitted {
            let in_window = admitted.iter().filter(|other| **other >= *start && **other < start + 60).count();
            assert!(in_window <= 20, "{in_window} starts in the window opening at {start}s");
        }
    }

    #[test]
    fn retry_after_holds_back_every_caller_and_is_capped() {
        let base = Instant::now();
        let mut budget = RequestBudget::new(20);
        budget.penalize(base, Duration::from_secs(30));
        // Nothing is in the window, yet the next start still waits.
        let wait = budget.wait_for(base).expect("a penalized budget must hold callers back");
        assert_eq!(wait, Duration::from_secs(30));

        budget.penalize(base, Duration::from_secs(3_600));
        let capped = budget.wait_for(base).expect("a penalized budget must hold callers back");
        assert_eq!(capped, MAX_RETRY_AFTER);
    }

    #[test]
    fn reads_only_the_delta_seconds_retry_after_form() {
        assert_eq!(parse_retry_after(Some("12")), Some(Duration::from_secs(12)));
        assert_eq!(parse_retry_after(Some(" 3 ")), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after(Some("0")), None);
        assert_eq!(parse_retry_after(Some("-1")), None);
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn an_absurd_retry_after_is_clamped_rather_than_fatal() {
        // Rust parses an overflowing literal as f64::INFINITY instead of
        // failing, and Duration::from_secs_f64 panics on it -- so a provider
        // header could take down the request path, skipping the cancellation
        // cleanup that runs after it.
        assert_eq!(parse_retry_after(Some("1e999")), Some(MAX_RETRY_AFTER));
        assert_eq!(parse_retry_after(Some("1e30")), Some(MAX_RETRY_AFTER));
        assert_eq!(parse_retry_after(Some("NaN")), None);
        assert_eq!(parse_retry_after(Some("-1e999")), None);
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;

    fn context(json: &str) -> InstallContext {
        serde_json::from_str(json).expect("install context should parse")
    }

    #[test]
    fn reads_the_launcher_written_install_context() {
        let parsed = context(
            r#"{
                "harness": "antigravity",
                "launcherRoot": "/tmp/checkout",
                "updateMethod": "copied-adapter",
                "updateCommand": ["bun", "x", "@tui-games/tui@latest", "install", "--antigravity"],
                "manualCommand": "npx -y bun x @tui-games/tui@latest install --antigravity"
            }"#,
        );
        assert_eq!(parsed.launcher_root, PathBuf::from("/tmp/checkout"));
        assert_eq!(parsed.update_method, "copied-adapter");
        assert_eq!(parsed.update_command.as_ref().unwrap()[0], "bun");
    }

    #[test]
    fn tolerates_a_context_written_by_an_older_launcher() {
        // An overlay binary can outlive the launcher that wrote the file: a
        // missing updateCommand must degrade to instructions, not a parse error
        // that sends every install back to the Claude-only path.
        let parsed = context(r#"{"launcherRoot": "/tmp/checkout"}"#);
        assert_eq!(parsed.harness, "unknown");
        assert!(parsed.update_command.is_none());
        let plan = update_plan_for(Some(&parsed));
        assert!(!plan.can_self_update);
        assert_eq!(plan.manual_command, GENERIC_UPDATE_COMMAND);
    }

    #[test]
    fn offers_one_click_updates_only_when_a_command_exists() {
        let adapter = context(
            r#"{"harness":"codex","launcherRoot":"/tmp/c","updateMethod":"copied-adapter",
                "updateCommand":["bun","x","@tui-games/tui@latest","install","--codex"],
                "manualCommand":"npx -y bun x @tui-games/tui@latest install --codex"}"#,
        );
        let plan = update_plan_for(Some(&adapter));
        assert!(plan.can_self_update);
        assert_eq!(plan.harness, "codex");
        assert_eq!(plan.method, "copied-adapter");

        // A dev checkout is never pulled from under the user.
        let dev = context(
            r#"{"harness":"claude","launcherRoot":"/tmp/d","updateMethod":"dev",
                "updateCommand":null,"manualCommand":"git -C /tmp/d pull --ff-only"}"#,
        );
        let plan = update_plan_for(Some(&dev));
        assert!(!plan.can_self_update);
        assert_eq!(plan.manual_command, "git -C /tmp/d pull --ff-only");
    }

    #[test]
    fn falls_back_to_instructions_with_no_context_at_all() {
        let plan = update_plan_for(None);
        assert!(!plan.can_self_update);
        assert_eq!(plan.manual_command, GENERIC_UPDATE_COMMAND);
        assert_eq!(plan.method, "unknown");
    }

    #[test]
    fn resolves_bun_to_the_launcher_copy_and_leaves_others_alone() {
        assert!(resolve_update_program("bun").ends_with("bun"));
        assert_eq!(resolve_update_program("npm"), PathBuf::from("npm"));
    }

    #[test]
    fn reads_the_claude_marketplace_install_path_and_its_failures() {
        assert_eq!(
            parse_plugin_install_path(
                r#"{"plugins":{"tui-gamepigeon@tui-gamepigeon":[{"installPath":"/tmp/plugin"}]}}"#
            ),
            Ok(PathBuf::from("/tmp/plugin")),
        );
        // The exact failure users hit in issue #176: a record with no path.
        assert!(parse_plugin_install_path(
            r#"{"plugins":{"tui-gamepigeon@tui-gamepigeon":[{"version":"0.2.11"}]}}"#
        )
        .is_err());
        assert!(parse_plugin_install_path(r#"{"plugins":{}}"#).is_err());
        assert!(parse_plugin_install_path("not json").is_err());
    }

    #[test]
    fn reports_the_updater_outcome_per_install_method() {
        // Claude's updater prints the sentence to show; installers print chatter.
        assert_eq!(
            update_output_message(true, "Tui updated. Run /reload-plugins.\n", "", update_success_message("claude-marketplace"), true),
            Ok("Tui updated. Run /reload-plugins.".to_string()),
        );
        assert_eq!(
            update_output_message(true, "Installed Tui skill at /Users/x/.agents/skills/arcade\n", "", update_success_message("copied-adapter"), false),
            Ok("Tui updated to the latest version.".to_string()),
        );
        assert_eq!(
            update_output_message(false, "some output", "boom", update_success_message("copied-adapter"), false),
            Err("boom".to_string()),
        );
        assert_eq!(
            update_output_message(false, "only stdout", "", update_success_message("dev"), false),
            Err("only stdout".to_string()),
        );
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    fn local_score(game_id: &str, score: i64) -> LocalScoreInput {
        LocalScoreInput {
            game_id: game_id.to_string(),
            game_type: "2048".to_string(),
            variation_id: "classic".to_string(),
            score,
            success: false,
            completed_at: "2026-07-26T12:00:00.000Z".to_string(),
            duration_ms: 1_500,
            platform: "overlay".to_string(),
        }
    }

    fn recording_chunk() -> serde_json::Value {
        serde_json::json!({
            "schema_version": 2,
            "user_id": "usr_pending",
            "game_id": "game_test",
            "game_type": "2048",
            "game_version": "1",
            "chunk_id": "chk_test",
            "chunk_sequence": 1,
            "first_event_sequence": 1,
            "last_event_sequence": 1,
            "event_count": 1,
            "created_at_ms": 1,
            "client": {
                "platform": "tui",
                "application_version": "test",
                "recording_sdk_version": "2"
            },
            "events": [{
                "schema_version": 2,
                "user_id": "usr_pending",
                "game_id": "game_test",
                "chunk_id": "chk_test",
                "event_id": "evt_test",
                "event_sequence": 1,
                "event_type": "episode_ended",
                "event_version": 1,
                "visibility": "policy",
                "client_time_ms": 1,
                "monotonic_time_us": 0,
                "payload": {
                    "reason": "client_closed",
                    "final_event_sequence": 1,
                    "final_score": 0,
                    "duration_us": 0,
                    "completed": false
                }
            }]
        })
    }

    fn recording_result() -> serde_json::Value {
        serde_json::json!({
            "result_id": "res_test",
            "game_id": "game_test",
            "game_type": "2048",
            "score": 4,
            "completed_at": "2026-07-26T00:00:00.000Z"
        })
    }

    #[test]
    fn overlay_sign_in_rotates_private_credentials() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-auth-session-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let user = AuthUser {
            id: "usr_test".to_string(),
            email: "person@example.com".to_string(),
        };

        store_session_to(&root, "https://api.example", "first-token", &user).unwrap();
        store_session_to(&root, "https://api.example", "rotated-token", &user).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("backend.conf")).unwrap(),
            "https://api.example\nrotated-token\n"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &std::fs::read_to_string(root.join("auth.json")).unwrap()
            )
            .unwrap()["sessionToken"],
            "rotated-token"
        );
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            for name in ["auth.json", "backend.conf"] {
                assert_eq!(
                    std::fs::metadata(root.join(name))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn query_param_reads_standard_pairs() {
        assert_eq!(
            query_param("state=abc&token=xyz", "state").as_deref(),
            Some("abc")
        );
        assert_eq!(
            query_param("state=abc&token=xyz", "token").as_deref(),
            Some("xyz")
        );
    }

    #[test]
    fn query_param_tolerates_double_question_mark() {
        // Some hosted redirects append `?token` onto a callback already carrying `?state`.
        assert_eq!(
            query_param("state=abc?token=xyz", "token").as_deref(),
            Some("xyz")
        );
        assert_eq!(
            query_param("state=abc?token=xyz", "state").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn signed_in_recordings_resolve_identity_through_v1_me() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0; 2048];
            let length = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..length]).to_ascii_lowercase();
            assert!(request.starts_with("get /v1/me "));
            assert!(request.contains("\r\nauthorization: bearer session-token\r\n"));

            let body = r#"{"user_id":"usr_canonical"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len(),
            )
            .unwrap();
        });

        let user_id =
            resolve_recording_user(&format!("http://{address}"), "session-token").unwrap();
        let mut chunk = recording_chunk();
        canonicalize_recording_chunk(&mut chunk, &user_id).unwrap();
        assert_eq!(chunk["user_id"], user_id);
        assert_eq!(chunk["events"][0]["user_id"], user_id);
        server.join().unwrap();
    }

    #[test]
    fn recording_acknowledgments_must_match_the_exact_chunk() {
        let chunk = recording_chunk();
        let ack = serde_json::json!({
            "accepted": true,
            "duplicate": false,
            "game_id": "game_test",
            "chunk_id": "chk_test",
            "chunk_sequence": 1,
            "accepted_event_range": { "first": 1, "last": 1 },
            "queued": true,
            "server_received_at_ms": 1
        });
        assert!(recording_ack_matches(&chunk, &ack));
        assert!(!recording_ack_matches(
            &chunk,
            &serde_json::json!({ "accepted": true, "queued": true })
        ));
    }

    #[test]
    fn result_upload_accepts_ok_and_accepted() {
        assert!(result_upload_succeeded(200));
        assert!(result_upload_succeeded(202));
        assert!(!result_upload_succeeded(204));
    }

    #[test]
    fn recording_upload_retries_only_transient_http_errors() {
        let unavailable =
            ureq::Error::Status(503, ureq::Response::new(503, "Unavailable", "").unwrap());
        let invalid = ureq::Error::Status(400, ureq::Response::new(400, "Invalid", "").unwrap());
        assert!(retryable_recording_error(&unavailable));
        assert!(!retryable_recording_error(&invalid));
    }

    #[test]
    fn only_permanent_http_rejections_quarantine_a_chunk() {
        let rejected = ureq::Error::Status(400, ureq::Response::new(400, "Invalid", "").unwrap());
        let unavailable =
            ureq::Error::Status(503, ureq::Response::new(503, "Unavailable", "").unwrap());
        let expired =
            ureq::Error::Status(401, ureq::Response::new(401, "Unauthorized", "").unwrap());
        let missing = ureq::Error::Status(404, ureq::Response::new(404, "Not Found", "").unwrap());
        assert!(recording_rejection_reason(&rejected).is_some_and(|reason| reason.contains("400")));
        // Retryable statuses only reach the caller once retries are exhausted,
        // and a server that is still down is not a reason to drop the chunk.
        assert!(recording_rejection_reason(&unavailable).is_none());
        // A stale session or a wrong backend URL rejects every chunk equally;
        // signing in again must not find an emptied queue.
        assert!(recording_rejection_reason(&expired).is_none());
        assert!(recording_rejection_reason(&missing).is_none());
    }

    #[test]
    fn a_rejected_chunk_leaves_the_queue_so_later_chunks_can_upload() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-recording-quarantine-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let pending = root.join("pending");
        let failed = root.join("failed");
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::create_dir_all(&failed).unwrap();
        let name = "game_test-000001-chk_test.json";
        let source = pending.join(name);
        std::fs::write(&source, br#"{"schema_version":2,"game_id":"game_test"}"#).unwrap();
        // A stale quarantine entry must not keep the chunk in the queue.
        std::fs::write(failed.join(name), b"{}").unwrap();

        quarantine_rejected_recording(&source, &failed).unwrap();

        assert!(!source.exists());
        assert_eq!(std::fs::read_dir(&pending).unwrap().count(), 0);
        assert_eq!(
            std::fs::read(failed.join(name)).unwrap(),
            br#"{"schema_version":2,"game_id":"game_test"}"#
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_result_ids_are_migrated_to_the_backend_contract() {
        let mut result = recording_result();
        result["result_id"] = serde_json::Value::String("result_test".to_string());
        canonicalize_recording_result(&mut result).unwrap();
        assert_eq!(result["result_id"], "res_test");
    }

    #[test]
    fn cloud_acknowledged_recordings_keep_the_exact_uploaded_bytes() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-recording-archive-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let pending = root.join("pending");
        let completed = root.join("completed");
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::create_dir_all(&completed).unwrap();
        let source = pending.join("game_test-000001-chk_test.json");
        let bytes = br#"{"schema_version":2,"game_id":"game_test"}"#;
        std::fs::write(&source, bytes).unwrap();

        archive_uploaded_recording_to(&source, &completed).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(completed.join("game_test-000001-chk_test.json")).unwrap(),
            bytes
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overlay_recording_and_result_persist_without_backend_access() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-recording-outbox-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let pending = root.join("pending");
        let completed = root.join("completed");
        let result_pending = root.join("result-pending");
        let result_completed = root.join("result-completed");
        for directory in [&pending, &completed, &result_pending, &result_completed] {
            std::fs::create_dir_all(directory).unwrap();
        }

        let mut chunk = recording_chunk();
        canonicalize_recording_chunk(&mut chunk, "usr_pending").unwrap();
        persist_recording_chunk_to(&mut chunk, &pending, &completed).unwrap();
        let chunk_path = std::fs::read_dir(&pending)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        canonicalize_recording_chunk(&mut chunk, "usr_canonical").unwrap();
        std::fs::write(&chunk_path, serde_json::to_vec(&chunk).unwrap()).unwrap();
        let mut retried = recording_chunk();
        canonicalize_recording_chunk(&mut retried, "usr_pending").unwrap();
        persist_recording_chunk_to(&mut retried, &pending, &completed).unwrap();
        let result = recording_result();
        persist_recording_result_to(&result, &result_pending, &result_completed).unwrap();
        persist_recording_result_to(&result, &result_pending, &result_completed).unwrap();

        assert_eq!(std::fs::read_dir(pending).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(result_pending).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_scores_append_once_and_track_personal_best() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-scores-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let path = root.join("scores").join("history.jsonl");

        let first = append_local_score_to(&path, local_score("game_first", 512)).unwrap();
        let second = append_local_score_to(&path, local_score("game_second", 256)).unwrap();
        let third = append_local_score_to(&path, local_score("game_third", 1024)).unwrap();
        append_local_score_to(&path, local_score("game_second", 256)).unwrap();

        assert_eq!(first.personal_best, 512);
        assert!(first.high_score_updated);
        assert_eq!(second.personal_best, 512);
        assert!(!second.high_score_updated);
        assert_eq!(third.personal_best, 1024);
        assert!(third.high_score_updated);
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_scores_ignore_bad_lines_and_limit_each_list_to_ten() {
        let root = std::env::temp_dir().join(format!(
            "tui-gamepigeon-scores-read-{}-{}",
            std::process::id(),
            generate_nonce()
        ));
        let path = root.join("scores").join("history.jsonl");
        for score in 0..12 {
            append_local_score_to(&path, local_score(&format!("game_{score}"), score)).unwrap();
        }
        let mut contents = std::fs::read_to_string(&path).unwrap();
        contents.push_str("not json\n");
        std::fs::write(&path, contents).unwrap();

        let scores = read_local_scores_from(&path).unwrap();
        assert_eq!(scores.recent.len(), 12);
        assert_eq!(scores.top_scores.len(), 10);
        assert_eq!(scores.top_scores[0].score.score, 11);
        assert_eq!(
            scores.personal_bests,
            vec![LocalScoreBest {
                game_type: "2048".to_string(),
                score: 11,
            }]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn query_param_missing_key_is_none() {
        assert_eq!(query_param("token=xyz", "state"), None);
    }

    #[test]
    fn build_login_url_carries_port_and_nonce() {
        let url = build_login_url(54321, "deadbeef");
        assert!(url.contains("callback="));
        // The callback (percent-encoded) must include the ephemeral port and nonce.
        assert!(url.contains("54321"));
        assert!(url.contains("state%3Ddeadbeef"));
        assert!(url.contains("plugin=1"));
    }

    #[test]
    fn default_https_handler_is_read_from_the_https_block() {
        let plist = r#"{
    LSHandlers =     (
                {
            LSHandlerContentType = "public.mp3";
            LSHandlerRoleAll = "com.apple.music";
        },
                {
            LSHandlerRoleAll = "company.thebrowser.Browser";
            LSHandlerURLScheme = https;
        },
                {
            LSHandlerRoleAll = "com.apple.mail";
            LSHandlerURLScheme = mailto;
        }
    );
}"#;
        assert_eq!(
            parse_default_https_handler(plist).as_deref(),
            Some("company.thebrowser.Browser"),
        );
        // No https handler registered: fall back to plain `open`.
        assert_eq!(parse_default_https_handler("{ LSHandlers = ( ); }"), None);
    }

    #[test]
    fn arc_and_dia_bundles_take_the_applescript_path() {
        assert!(is_arc_bundle("company.thebrowser.Browser"));
        assert!(is_arc_bundle("company.thebrowser.dia"));
        assert!(!is_arc_bundle("com.google.Chrome"));
        assert!(!is_arc_bundle("com.apple.Safari"));
    }

    #[test]
    fn applescript_strings_escape_quotes_and_backslashes() {
        assert_eq!(
            applescript_escape(r#"https://x/?q="a\b""#),
            r#"https://x/?q=\"a\\b\""#,
        );
    }

    #[test]
    fn pending_login_url_is_retired_with_the_attempt() {
        set_pending_login_url(Some("https://example.test/login".to_string()));
        {
            let guard = AuthInProgress::acquire().expect("no attempt in flight");
            drop(guard);
        }
        assert_eq!(
            PENDING_LOGIN_URL.lock().unwrap().clone(),
            None,
            "a finished attempt must not leave a live fallback link behind",
        );
    }

    #[test]
    fn percent_decode_reads_escapes_without_panicking_on_bad_input() {
        assert_eq!(percent_decode("caf%C3%A9%20shop"), "café shop");
        // Truncated and non-hex escapes are kept literally rather than panicking.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%C3"), "\u{fffd}");
    }

    #[test]
    fn callback_failure_explains_why_the_handoff_stopped() {
        assert_eq!(callback_failure("state=abc&token=xyz"), None);
        assert_eq!(
            callback_failure("state=abc&error=access_denied").as_deref(),
            Some("Sign-in was cancelled before it finished."),
        );
        assert_eq!(
            callback_failure("error=server_error&error_description=Session%20expired").as_deref(),
            Some("Session expired"),
        );
        assert_eq!(
            callback_failure("error=server_error").as_deref(),
            Some("The login page reported an error: server_error"),
        );
    }

    #[test]
    fn callback_failure_caps_a_hostile_description() {
        let query = format!("error=x&error_description={}", "A".repeat(5000));
        assert_eq!(callback_failure(&query).unwrap().chars().count(), 200);
    }

    #[test]
    fn generate_nonce_is_128_bit_hex_and_unique() {
        let a = generate_nonce();
        let b = generate_nonce();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}

fn requested_action(args: &[String]) -> OverlayAction {
    if args.iter().any(|arg| arg == "--quit" || arg == "--stop") {
        OverlayAction::Quit
    } else if args.iter().any(|arg| arg == "--enable") {
        OverlayAction::Enable
    } else if args.iter().any(|arg| arg == "--pause") {
        OverlayAction::Pause
    } else if args.iter().any(|arg| arg == "--hide") {
        OverlayAction::Hide
    } else if args.iter().any(|arg| arg == "--reset") {
        OverlayAction::Reset
    } else {
        OverlayAction::Show
    }
}

fn launch_request(args: &[String]) -> Option<(String, String)> {
    let mut game: Option<String> = None;
    let mut variation: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--game" if index + 1 < args.len() => {
                game = Some(args[index + 1].clone());
                index += 2;
            }
            "--variation" if index + 1 < args.len() => {
                variation = Some(args[index + 1].clone());
                index += 2;
            }
            _ => index += 1,
        }
    }
    game.map(|id| (id, variation.unwrap_or_else(|| "classic".to_string())))
}

fn js_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn dispatch_launch(window: &WebviewWindow, game: &str, variation: &str) {
    let script = format!(
        "window.dispatchEvent(new CustomEvent('gamepigeon:launch', {{ detail: {{ game: {}, variation: {} }} }}))",
        js_string(game),
        js_string(variation),
    );
    let _ = window.eval(&script);
}

fn apply_action(app: &AppHandle, action: OverlayAction, args: &[String]) {
    match action {
        OverlayAction::Show | OverlayAction::Enable => {
            ensure_overlay_lease();
            if action == OverlayAction::Enable {
                clear_shutdown_flag();
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Some((game, variation)) = launch_request(args) {
                    dispatch_launch(&window, &game, &variation);
                }
                let _ = window.eval("window.dispatchEvent(new Event('gamepigeon:resume'))");
                let _ = window.center();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        OverlayAction::Pause => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.dispatchEvent(new Event('gamepigeon:pause'))");
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        OverlayAction::Hide => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        OverlayAction::Reset => {
            clear_shutdown_flag();
            // Snap a stale, still-running overlay back to the menu at the start of a
            // new session without popping the (possibly hidden) window into view.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.dispatchEvent(new Event('gamepigeon:reset'))");
            }
        }
        OverlayAction::Quit => {
            clear_overlay_lease();
            app.exit(0);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let initial_action = requested_action(&args);
    if matches!(initial_action, OverlayAction::Show | OverlayAction::Enable) {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !overlay_lease_path().exists() {
                std::process::exit(0);
            }
        });
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            shutdown,
            read_settings,
            write_settings,
            read_worker_model_config,
            complete_worker_model,
            cancel_worker_model,
            record_analytics_event,
            append_local_score,
            read_local_scores,
            queue_recording_chunks,
            read_update_flag,
            read_update_plan,
            run_plugin_update,
            read_auth_session,
            read_sync_error,
            start_auth_login,
            open_login_url,
            cancel_auth_login,
            sign_out
        ])
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            apply_action(app, requested_action(&args), &args);
        }))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                app.handle()
                    .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
                app.handle().set_dock_visibility(false)?;
            }

            if initial_action == OverlayAction::Reset {
                clear_shutdown_flag();
            }
            if !matches!(initial_action, OverlayAction::Show | OverlayAction::Enable) {
                std::process::exit(0);
            }
            if initial_action == OverlayAction::Enable {
                clear_shutdown_flag();
            }
            ensure_overlay_lease();
            let app_for_drain = app.handle().clone();
            std::thread::spawn(move || {
                drain_recordings_and_notify(&app_for_drain);
            });

            // The window is undecorated and skips the taskbar, and its drag
            // and resize affordances live in the custom titlebar — so a
            // window taller than the display is not just ugly, it is
            // unrecoverable: there is nothing left on screen to grab. Clamp
            // the preferred size to what the monitor actually offers before
            // centering, leaving a margin for the menu bar and dock.
            let (window_width, window_height) = {
                const PREFERRED: (f64, f64) = (820.0, 1060.0);
                const MIN: (f64, f64) = (430.0, 610.0);
                match app.primary_monitor() {
                    Ok(Some(monitor)) => {
                        let scale = monitor.scale_factor();
                        let size = monitor.size();
                        let usable_w = (size.width as f64 / scale) * 0.92;
                        let usable_h = (size.height as f64 / scale) * 0.92;
                        (
                            PREFERRED.0.min(usable_w).max(MIN.0),
                            PREFERRED.1.min(usable_h).max(MIN.1),
                        )
                    }
                    // No monitor to measure: the preferred size is no worse a
                    // guess than anything else, and min_inner_size still holds.
                    _ => PREFERRED,
                }
            };

            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Tui")
                    .inner_size(window_width, window_height)
                    .min_inner_size(430.0, 610.0)
                    .center()
                    .always_on_top(true)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .resizable(true)
                    .skip_taskbar(true)
                    .visible(true)
                    .focused(true);

            #[cfg(target_os = "macos")]
            let builder = builder.visible_on_all_workspaces(true);

            let window = builder.build()?;

            #[cfg(target_os = "macos")]
            unsafe {
                use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
                let ns_window = window.ns_window()? as *mut NSWindow;
                if let Some(ns_window) = ns_window.as_ref() {
                    ns_window.setCollectionBehavior(
                        ns_window.collectionBehavior()
                            | NSWindowCollectionBehavior::CanJoinAllSpaces
                            | NSWindowCollectionBehavior::FullScreenAuxiliary,
                    );
                }
            }

            let close_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });

            window.show()?;
            window.set_focus()?;
            if let Some((game, variation)) = launch_request(&args) {
                dispatch_launch(&window, &game, &variation);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Tui overlay");
}
