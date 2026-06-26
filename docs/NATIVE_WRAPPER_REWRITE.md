# Native wrapper rewrite — plan

Status: **draft for review** · Branch: `rewrite/native-wrapper` · Archive of
current Python impl: `archive/python-wrapper`

## 1. Why

On Windows the agent CLI runs as a **direct child sharing the same physical
console** as the Python wrapper, and the wrapper actively fights that shared
console (a 100 Hz `SetConsoleMode` keepalive, a 1 s full-screen
`ReadConsoleOutput` poll, and keystroke injection into the same input queue the
user types into). Two user-visible failures result:

1. **Codex input is janky / the input box stalls** — the VT keepalive races
   codex's own console-mode changes, and injected keystrokes interleave with the
   user's.
2. **After Claude exits, Ctrl+C is dead and the console looks frozen** — nothing
   ever restores the console input mode, so `ENABLE_PROCESSED_INPUT` stays
   cleared and Ctrl+C is delivered as a raw `0x03` byte instead of a signal.

macOS does not hit either: there the agent runs **inside a tmux PTY**, fully
isolated, and the wrapper only injects via `tmux send-keys`. The root cause is
the missing PTY isolation on Windows — not a tunable bug.

Upstream (`bcurts`) and the coworker fork (`gf-seanwang`) are both macOS-first
and have **no fix**; the VT keepalive is upstream's latest Windows state and is
itself the contention source.

## 2. Decision

Replace the platform-split wrapper with a **single cross-platform native
binary** that gives every agent its own pseudo-terminal — ConPTY on Windows,
`openpty` on Unix — through one code path. This mirrors what tmux gives macOS
today, on both platforms, and removes the shared-console class of bugs entirely.

- **Language / PTY library:** Rust + [`portable-pty`](https://crates.io/crates/portable-pty)
  (the wezterm PTY abstraction). Chosen over Node (`node-pty`) because it
  compiles to a **single self-contained binary** with no runtime to install and
  the lowest resident footprint, which the owner prioritised; chosen over Go
  because its cross-platform PTY library is more battle-tested. The owner does
  not maintain this by hand, so Rust's learning curve is not a blocker.
- **Scope:** rewrite the **interactive** wrapper only. The Python server and the
  API-agent path stay untouched (see §7).
- **tmux is dropped.** macOS moves to the same `openpty` path. The current tmux
  **detach / reattach** feature is **not** reimplemented in v1 — the owner does
  not use it — but the architecture leaves a seam to add it later (see §6.4).

## 3. Clean-architecture goals (not a 1:1 port)

The Python wrapper grew organically; the rewrite should improve structure, not
transcribe it:

- **Activity detection from the output stream, not the screen.** Because the new
  wrapper pumps every byte of PTY output, "is the agent working?" becomes "are
  output bytes flowing above a quiet threshold?" — no more per-second
  full-screen buffer reads. Cleaner and cheaper.
- **Terminal restore is structural, not best-effort.** A Rust RAII guard
  (`Drop` restores raw mode + console state) runs on **every** exit path. This
  is the structural fix for failure #2 — the thing the Python version never did.
- **One config loader, one HTTP client, one PTY path** — collapse the
  `config_loader.py` + template `_load.py` duplication and the
  `wrapper_unix.py` / `wrapper_windows.py` split.
- **Ctrl+C goes to the agent, not the wrapper.** The TUI wants Ctrl+C as a key;
  the wrapper forwards it into the PTY and never intercepts it for its own exit.

## 4. The seam that does NOT change — server HTTP contract

The wrapper talks to the Python server only over HTTP plus one flag file. The
rewrite reimplements the **client** side of exactly this contract; the server is
untouched. Capturing it here so nothing is missed in the port:

| Method / path | Auth | Body | Response / effect |
|---|---|---|---|
| `POST /api/register` | — | `{base, label}` | `{name, token, slot}` |
| `POST /api/heartbeat/{name}` | Bearer | optional `{active}` | `{name}` (may differ → rename); `409` → re-register |
| `POST /api/deregister/{name}` | Bearer | — | on exit |
| `GET /api/roles` | — | — | `{name: role}` |
| `GET /api/rules/active` | Bearer | — | `{epoch, rules[], refresh_interval}` |
| `POST /api/rules/agent_sync/{name}` | Bearer | `{epoch}` | mark rules seen |
| flag file `data/{name}_recovered` | — | — | wrapper writes; server broadcasts recovery |

Queue input: the server appends JSONL lines to `data/{name}_queue.jsonl`; the
wrapper drains and truncates it. Line shape (any of): `{channel}`, `{job_id}`,
`{prompt}`.

## 5. Behaviour to preserve (from the current wrapper)

Faithful behaviours the port must keep, independent of structure:

- **Registration → assigned name + token + slot**; `slot > 1` ⇒ multi-instance
  (appends the identity-reclaim hint on first mention).
- **Heartbeat every 5 s**; on `409` re-register, swap identity, write recovery
  flag. On name change from the server, adopt the new name + queue path.
- **Queue watcher (1 s poll)** builds the inject prompt:
  - custom `prompt` ▶ used verbatim; else `job_id` ▶ job-thread prompt; else
    `#channel` mention prompt.
  - appends `ROLE:` (from `/api/roles`) and, on first mention / epoch change /
    every `refresh_interval` triggers, `RULES:` (from `/api/rules/active`),
    reporting sync back.
  - **flattens newlines to spaces** before injecting (multi-line triggers paste
    detection in Claude Code).
- **Injection** = type text, scaled delay (`max(delay, len*0.001)`), then Enter.
- **MCP config injection**, five modes (§8).
- **Strip `CLAUDECODE`** (+ per-agent `strip_env`) from the agent's environment.
- **Restart-on-exit** with a 3 s delay unless `--no-restart`.
- **cwd resolution priority:** `--agent-cwd` > `config.cwd` > `.`.

## 6. Proposed module layout

A Rust crate in its own directory; the Python server stays at repo root
(folder-structure rationale in §10).

```
wrapper/                      # Rust crate (new)
  Cargo.toml
  src/
    main.rs                   # CLI parse, dispatch, top-level wiring
    config.rs                 # config.toml + config.local.toml + env/CLI overrides
                              #   (replaces config_loader.py AND template _load.py)
    server.rs                 # HTTP client for the §4 contract
    identity.rs               # shared name/token/queue state; rename + 409 handling
    watcher.rs                # queue-file poll → prompt build → inject
    prompt.rs                 # mention/job/custom + ROLE + RULES + identity hint
    mcp/
      inject.rs               # the five injection modes (§8)
      proxy.rs                # local HTTP+SSE identity proxy (codex) — see §8.1
    pty/
      mod.rs                  # PtyHost: spawn, pump, resize, raw-mode guard
      inject.rs               # type text + Enter into the PTY (replaces send-keys / WriteConsoleInput)
      activity.rs             # output-stream activity detector
```

Naming conventions (the owner asked for consistency):

- Rust modules: `snake_case.rs`, one responsibility each.
- Binary / crate: `agentchattr-wrapper` (kebab-case, discoverable). Invoked as
  `agentchattr-wrapper codex`.
- Docs: `UPPER_SNAKE.md` to match existing `AGENT_BOOTSTRAP.md` /
  `FORK_REMOTES.md`.

### 6.4 PTY host design + the detach seam

`pty::PtyHost` owns the `portable-pty` master/slave pair and the child. It pumps
between the PTY and a **`Frontend`** abstraction rather than hard-wiring stdio:

- **v1 `Frontend` = the local terminal** (real stdin/stdout, raw mode on attach,
  restored by `Drop`).
- **future `Frontend` = a detach socket** — the host runs as a background
  process; an `attach` subcommand connects a terminal to it. Adding detach later
  means adding a `Frontend` impl, not rearchitecting.

The injector and the activity detector both tap the host's PTY streams (a shared
locked writer for injection; a tee on the output reader for activity), so they
work identically regardless of which `Frontend` is attached.

## 7. Scope boundary — what stays Python

Unchanged by this rewrite:

- The **server**: `app.py`, `run.py`, `router.py`, `registry.py`, `store.py`,
  `session_*`, `mcp_bridge.py`, `schedules.py`, `rules.py`, `archive.py`, the web
  UI under `static/`.
- **`wrapper_api.py`** — API-model agents (`type = "api"`, e.g. `minimax`). These
  have **no terminal / no PTY**; they are a different path and remain Python.
- **`config_loader.py`** — still used by `run.py` and `wrapper_api.py`, so it
  stays. The Rust binary has its own `config.rs` reading the same `config.toml`
  schema. This is a deliberate, low-cost duplication (same documented format).

Replaced (→ archived on `archive/python-wrapper`): `wrapper.py`,
`wrapper_unix.py`, `wrapper_windows.py`, the wrapper's use of `mcp_proxy.py`, and
the template `_load.py`.

## 8. MCP injection — the five modes

Per-agent, resolved as explicit `agents.<x>.mcp_*` > built-in default > none:

| Mode | Used by | Action |
|---|---|---|
| `flag` | claude, kimi | write a `--mcp-config` JSON file (bearer token, optional project `.mcp.json` merge), pass as a flag |
| `env` | gemini | write a settings JSON, point an env var at it; ensure Gemini folder trust |
| `settings_file` | qwen, codebuddy, copilot | write/merge a JSON settings file at a configured path |
| `env_content` | kilo | put JSON config directly in an env var |
| `proxy_flag` | codex | start a local identity proxy, pass its URL as a `-c` flag |

### 8.1 Open decision — the MCP identity proxy

`mcp_proxy.py` (~330 lines) is a local HTTP+SSE proxy that **stamps the agent's
`sender`/`name` into MCP tool-call arguments** and forwards the bearer token, so
codex never needs to know its own identity. Two ways forward:

- **Option A — port it to Rust.** Faithful: an HTTP+SSE proxy (e.g. `hyper`)
  with the same sender-stamping. Keeps the server untouched. Cost: it is the
  single heaviest component to port (streaming, SSE endpoint rewriting).
- **Option B — eliminate it (a later cleanup).** The server already
  authenticates each instance by bearer token, so it *could* derive `sender`
  from the token and ignore the client-supplied value. Then codex connects
  directly with its token like Claude does, and the proxy + `proxy_flag` mode
  disappear from the wrapper entirely. Cost / blockers: a **server-side** change
  (Python, widening this rewrite's scope) + an audit that no flow relies on a
  client-spoofable `sender` + **verifying codex can attach its own bearer token**
  (if it cannot — likely the original reason the proxy exists — the proxy still
  has a job and B does not fully remove it).

**Decision: A for v1**, B revisited as a standalone cleanup once codex's
bearer-token support is verified. Rationale: B couples the wrapper rewrite to a
server refactor plus an unverified codex capability; A keeps v1's scope clean and
unblocked.

## 9. External invocation — how projects launch an agent

Today (per-project, Windows): `start_codex.cmd` → `_load.py` (parse project
`config.toml` → env) → main `start_codex.bat` → `python wrapper.py codex`. The
native binary collapses this:

- The binary **reads `config.toml` itself** (it is just TOML), applies
  `AGENTCHATTR_*` / `--port` / `--agent-cwd` overrides, and discovers config from
  (in order) `--config`, `.agentchattr/config.toml` in cwd, or `AGENTCHATTR_ROOT`
  — so **`_load.py` is gone**.
- Thin launcher scripts shrink to one line: ensure the server is up, then
  `agentchattr-wrapper codex "$@"`. The binary checks whether `server.port` is
  listening and, if not, starts the Python server (`python run.py` with resolved
  flags) — preserving today's auto-start.
- **Distribution:** ship prebuilt binaries (macOS arm64/x64, Windows x64) so no
  Rust toolchain is needed on the user's machine. The per-project template ships
  `config.toml` + a one-line launcher that points at the binary.

Open: keep the server auto-start in the binary, or require the user to start the
server separately? (Recommend keep — it matches current UX.)

## 10. Folder structure — evaluation

The repo root is currently a flat pile of Python modules. Two options:

- **Option A (recommended now): add `wrapper/` alongside the flat root.** The
  Python server stays exactly where it is; the Rust crate lives in its own
  directory. Minimal churn, the working server is untouched, the rewrite stays
  scoped.
- **Option B (later, optional): reorganise into `server/` (Python) + `wrapper/`
  (Rust).** Cleanest separation, but it rewrites every import path and every
  launcher script — multiplying the rewrite's risk for a cosmetic gain.

Recommendation: **A now, revisit B as a separate task** once the wrapper has
landed. Don't churn a working server mid-rewrite.

## 11. Risks / things the prototype must prove

1. `portable-pty` cleanly drives **codex (Rust TUI)** and **claude (Node TUI)**
   under ConPTY on Windows and `openpty` on macOS — rendering, resize, colours.
2. Host terminal raw-mode enter/restore on **all** exit paths (the Ctrl+C fix).
3. Injection timing into the PTY (scaled delay before Enter) behaves like
   `send-keys` for long prompts.
4. Bytes pass through untranscoded (PTY VT stream is UTF-8 both ways).
5. Output-stream activity thresholds map sensibly to the server's active/idle UI.
6. MCP proxy: Option A feasible in Rust, or Option B chosen (§8.1).

## 12. Milestones

- **M0 — Prototype (validates §11.1–2).** `portable-pty` hosts codex on Windows
  + macOS; bidirectional pump; manual text injection lands; Ctrl+C reaches the
  agent; exit restores the terminal. Go/no-go gate for the whole plan.
- **M1 — Server contract.** config loading, register, heartbeat (+409/rename),
  deregister, recovery flag.
- **M2 — Queue + prompt + injection.** watcher, prompt build (role/rules),
  newline flattening, inject into PTY.
- **M3 — MCP injection.** the five modes; resolve §8.1.
- **M4 — Activity detection.** output-stream hysteresis → heartbeat `active`.
- **M5 — Identity edge cases.** rename, 409 recovery, multi-instance hint.
- **M6 — Invocation + distribution.** config discovery, server auto-start, thin
  launchers, prebuilt binaries, per-project template.
- **M7 — Cut over.** delete the Python wrapper trio on this branch, update
  `templates/`, `windows/`, `macos-linux/`, README; merge to `main`.

## 13. Decisions

1. **MCP proxy** (§8.1) — **A (port) for v1**; B (server-side elimination) is a
   later standalone cleanup, pending verification that codex can attach its own
   bearer token.
2. **Server auto-start inside the binary** (§9) — **yes** (matches current UX).
3. **Folder structure** (§10) — **A**: add `wrapper/` alongside the flat root;
   don't reorganise the working server now.
4. **Binary name** (§6) — **`agentchattr-wrapper`**.
5. **Detach** (§6.4) — **out of v1**; architecture leaves a `Frontend` seam to
   add it later.
