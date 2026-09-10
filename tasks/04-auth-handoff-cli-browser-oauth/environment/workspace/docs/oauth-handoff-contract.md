# CLI/browser OAuth handoff — API contract

This pins down the parts of the browser OAuth handoff (instruction.md) that
are exercised by direct, white-box tests against exported functions and JSON
error/success bodies, rather than by end-to-end behavior alone. Anything not
covered here is an implementation choice.

## `src/auth.ts`

### `startOAuthCallbackServer(port)`

Returns **synchronously** (not a `Promise`) an object of this shape:

```ts
interface OAuthCallbackServer {
  readonly port: number;   // may change from the requested port (see fallback below)
  ready: Promise<void>;    // resolves once the socket is bound and accepting requests
  token: Promise<string>;  // resolves with the raw token string, or rejects on error/cancel
  close(): void;
}
```

Callers do `const callback = startOAuthCallbackServer(0); await callback.ready;`
— i.e. the handle itself is available before the socket is guaranteed to be
bound; only `ready` tells you binding finished (and, on a fallback, that
`port` has its final value).

Behavior:

- Binds to `127.0.0.1` on `port`. If that port is already taken, retries once
  on an OS-assigned free port (`port` reflects the port actually bound).
- Serves `GET /auth/ping` → `200 ok`.
- Serves `GET /auth/callback`, reading `token`, `state`, `error`, and
  `error_description` from the query string with a parser that treats a
  literal `?` the same as `&` (so `?state=<nonce>?token=<value>` yields
  `token=<value>`, matching the redirect quirk some hosted login pages have).
- `token` resolves with the **raw, unverified** token string exactly as
  received in the query. This function does not call the auth backend and
  does not check `state` against anything: unlike the desktop overlay's
  equivalent Rust listener (`tauri/src/main.rs`, `handle_callback_connection`),
  which is handed an `expected_state` nonce it generated itself,
  `startOAuthCallbackServer` takes only a `port` — it has no nonce to compare
  against, so any `state` value is accepted and ignored at this layer.
  Verifying the token against the auth backend (if a caller wants that) is a
  separate, higher-level concern layered on top of the raw listener, not part
  of this function.
- `?error=access_denied` → `400`, body contains "cancelled" (case-insensitive),
  and `token` rejects with an `Error` matching `/cancelled/i`.
  Any other `?error=...` → `400`, using `error_description` (HTML-escaped in
  the body) when present, and `token` rejects with an `Error` whose message
  contains the raw, un-escaped description.
- Every `/auth/callback` response sets `Cache-Control: no-store`.

## `cloudflare/auth-worker/src/index.ts`

### `GET /cli/handoff`

- Validate `next` first: it must parse as a URL with `protocol === "http:"`
  and `hostname` of `127.0.0.1` or `localhost`. Reject anything else with
  `400` before touching the session.
- Decide "signed in" from `auth.api.getSession({ headers: request.headers })`
  — treat the browser as signed in when the result has a `user`. Read the
  literal token value to attach to `next` from the request's `Cookie` header,
  specifically the `better-auth.session_token` cookie (better-auth's default
  cookie name) — not from a field on the object `getSession` returns, since
  that object's shape (e.g. whether it nests a raw `token`) is not something
  callers should depend on here.
- No session or no cookie → `401`, with a body that (case-insensitively)
  contains "oauth" (e.g. point at `gamepigeon auth oauth google` / `github` as
  a next step).
- On success, append `token=<cookie token>` to `next`'s existing query
  (preserving anything already there, e.g. `state`) and respond `200` with an
  HTML page that redirects the browser to that URL. The response body must
  contain the literal, un-escaped resulting URL somewhere in it — e.g. inside
  an inline `<script>` performing the redirect (`location.replace(...)`), in
  addition to any HTML-escaped `<meta http-equiv="refresh">` copy kept for
  browsers with scripting disabled.

### `GET /cli/oauth`

- Reject any `provider` other than `google`/`github` with `400`.
- If the requested provider has no client id/secret configured in the
  environment, respond `503`.
- Validate `next` the same way `/cli/handoff` does, before starting sign-in.

