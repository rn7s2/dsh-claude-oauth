# dsh-claude-oauth

A self-contained DeepSeek Harness plugin that signs in with a **Claude account**
(Claude Pro/Max OAuth) and registers **Claude models** as a Harness provider
route. It is the Harness port of the
[Evo lisp extension `020-claude-oauth-provider.lisp`](https://github.com/rn7s2/evo-agent/blob/main/extensions/020-claude-oauth-provider.lisp), with the OAuth
flow hardened and the request shape brought closer to Claude Code.

There is no settings form to fill in and no background traffic. The only UI is
one small section in **Settings → Claude**:

- **Sign in** — opens Claude's first-party OAuth page (authorization code +
  PKCE, loopback callback); the Host also opens the system browser.
- **Sign out** — deletes the local session; registered models disappear.
- **Refresh models** — manually asks `GET /v1/models` and registers what the
  account can use. Disabled while signed out. An initial refresh runs once
  right after a successful login; nothing refreshes in the background. The
  registered catalog is shown as a scrollable, display-only table (model id,
  context window, max output, input types, and reasoning efforts).
- **Network route** — shows the outbound proxy the Harness fetch dispatcher
  will actually use for `api.anthropic.com` / `platform.claude.com`, or a
  warning when the connection is direct.

## Requirements

- DeepSeek Harness with the `llm` service and the Web GUI (the settings route
  uses the Harness browser connection, so it is authenticated and same-origin).
- Node 22.21+ / 24 (the Harness runtime already provides this).
- No npm dependencies; no build step.

## Install

Install the published bundle into the Desktop profile:

```sh
dsh plugin --profile desktop add github:rn7s2/dsh-claude-oauth
```

The command installs and selects the bundle, whose patch inserts one Host row
(`claude-oauth`). With HMR the plugin is live immediately; otherwise restart
the Harness. The settings section appears after a page reload, and its display
metadata itself is localized (`locale/en.json`, `locale/zh.json`).

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-claude-oauth
```

The private data directory is left in place; delete `~/.dsh/claude-oauth/` to
forget the account by hand.

## How it works

### Sign-in

1. PKCE S256 (32 random bytes for the verifier, a separate 32-byte `state`).
2. A dual-stack loopback listener on `127.0.0.1` and `[::1]` (port 53692 when
   free, otherwise an OS-assigned loopback port), redirect URI
   `http://localhost:<port>/callback`.
3. The callback handler accepts only `GET /callback` on the expected Host, checks
   `state` in constant time, surfaces `error` / `error_description`, keeps
   serving so favicon/preconnect requests cannot steal the callback, and times
   out after 120 s.
4. The authorization code is exchanged at
   `https://platform.claude.com/v1/oauth/token` with
   `anthropic-beta: oauth-2025-04-20` and a `claude-cli/… (external, cli)`
   User-Agent — the one protocol gap the lisp extension had.
5. Tokens are written atomically to `~/.dsh/claude-oauth/token.json` (0600, dir
   0700). One refresh token is rotated under an exclusive lock that is
   re-read before use, so two processes cannot spend the single-use refresh
   token twice.

### Requests

The provider route is `claude-oauth` (display name `Claude`). Chat requests go
to `https://api.anthropic.com/v1/messages` with:

- `Authorization: Bearer <access token>`,
  `anthropic-version: 2023-06-01`,
  `anthropic-beta: oauth-2025-04-20,claude-code-20250219`;
- `user-agent: claude-cli/2.1.284 (external, sdk-cli)`, `x-app: cli`, and
  `x-claude-code-session-id` from the Harness session;
- Claude Code's identity system block followed by the
  `x-anthropic-billing-header: …` attribution line and the Harness system
  prompt — with the Harness's own fixed opener
  `You are an AI agent powered by DeepSeek Harness.` suppressed for this route
  only (stored sessions and other providers are unchanged);
- tool declarations in Claude Code's canonical casing (`Read`, `Bash`,
  `TodoWrite`, …), with streamed tool calls mapped back to the exact declared
  Harness names so execution is unaffected;
- adaptive thinking (`thinking: {type: 'adaptive'}` +
  `output_config.effort`) for models that support it;
- explicit prompt-caching breakpoints so repeated prefixes are billed at
  Anthropic's cache rates instead of full input price.

Prompt caching is prefix-based and opt-in. The request carries three
`cache_control` markers — the last system block (which caches the Claude Code
identity block before it), the last tool declaration, and the final block of
the conversation prefix — all with the extended one-hour ephemeral TTL
(`{"type": "ephemeral", "ttl": "1h"}`). The one-hour TTL is documented for the
Claude API without a beta header and is the right choice for thinking-heavy,
multistep work: a cache entry lives from the start of its writing request, so a
single long thinking turn could otherwise expire a five-minute entry before
the next step. The identity block, billing line, system prompt, and tool list
are emitted in the same byte order on every turn, so continued conversations
hit the cache; three markers stay below the API's four-breakpoint limit.

Assistant thinking signatures are kept in the Harness replay envelope and
replayed, so multi-turn tool use keeps reasoning continuity.

### Catalog

Before any refresh the plugin advertises the lisp extension's static model set
(1M context, 128K output, adaptive thinking, vision). After login the plugin
fetches `/v1/models` once and replaces it with the account's live catalog,
merged with a versioned capability table (context/output/vision/adaptive
thinking). A model that appears upstream but is unknown to the capability table
is still registered with the metadata the listing reports; it gets no reasoning
menu rather than an incorrect one.

## Data and privacy

Only `~/.dsh/claude-oauth/` is written:

| File | Mode | Content |
| --- | --- | --- |
| `token.json` | 0600 | access/refresh tokens, expiries |
| `account.json` | 0600 | cached email/plan for the Account row |
| `models.json` | 0600 | last `/v1/models` catalog |
| `token.lock` | 0600 | transient refresh lock |

The plugin never reads or writes `~/.claude/` (no Claude Code credential
interop), never fetches a profile except once after login, never logs tokens,
and never returns token material from the settings route. The route is served
through DSH's `/api` bridge, which applies the Host/Origin trust fence and
owner-browser authentication; the handler additionally requires `POST`,
`application/json`, a ≤ 8 KiB body, and a known action.

## Limits

- One Claude account at a time.
- No background refresh: models change only after login or a manual refresh.
- Older budget-thinking Claude models are advertised without a reasoning menu
  (the adapter only encodes adaptive thinking, rather than guessing budgets).
- Only the fixed Harness identity opener is suppressed on this route; persona,
  instructions, tool descriptions, and environment prompt sections are still
  sent as the Harness composed them.
- The settings page needs the Web GUI transport; a file:// shell has no
  same-origin `/api` fetch.

## Tests

```sh
node --test test/
```

All suites are offline: loopback mock servers for the token and Messages
endpoints, temp `DSH_HOME` directories, and no real Claude traffic.

## Layout

```text
lib/index.js      Host plugin: state, settings route, login/logout, catalog
lib/tokens.js     token file, lock, refresh
lib/oauth.js      PKCE login flow, loopback callback, code exchange
lib/adapter.js    Anthropic Messages adapter and Claude Code request shaping
lib/catalog.js    /v1/models refresh, account profile, persistence
lib/client.js     settings.section React component (browser bundle)
```
