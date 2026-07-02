# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

agentchattr is a **local chat server that coordinates AI coding-agent CLIs and humans**.
Agents and humans share a multi-channel chat room; when someone `@mentions` an agent,
the server injects a wake prompt into that agent's terminal, the agent reads the chat
over MCP and replies, and the loop continues hands-free. Localhost-only by design.

Python 3.11+ (uses `tomllib`). Runtime deps: `fastapi`, `uvicorn`, `mcp` (see
`requirements.txt` — the only dependency manifest; there is no `pyproject.toml`/`setup.py`).

## Engine vs instance (read this first)

This repo is an **engine**, not an app you run directly. It runs chat-room **instances**,
where an instance is a `.agentchattr/` folder holding a `config.toml` that points `root`
at the engine and overrides ports / `data_dir` / agent `cwd`. An instance does **not**
define agents — the roster comes from the engine's `config/config.toml`. The repo even
runs *itself* this way via its committed `./.agentchattr/`.

The **stable launch contract** is the load-bearing rule here: an instance references
exactly one engine entry — `launch.sh <target>` / `launch.cmd <target>`, where `<target>`
is `open` | `server` | `<agent>` (e.g. `launch.sh codex`). Instances must call **only**
`launch.*`, never an engine-internal path under `launchers/`. This exists because a real
instance once broke when `launchers/` moved; keep internals reorganizable behind
`launch.*`. Full rationale: `docs/ENGINE_MODE.md`.

## The runtime (three cooperating processes)

1. **`bin/run.py`** — the server. Starts FastAPI (web UI, default `8300`) plus MCP
   streamable-HTTP (`8200`) and MCP SSE (`8201`) in background threads. Generates a
   random in-memory session token per boot, injected into `static/index.html`.
2. **`bin/wrapper.py <agent>`** — one per CLI agent. Registers with the server
   (`POST /api/register` → bearer token + slot), launches the real agent CLI in an
   interactive terminal, then runs background threads: a **queue watcher** that polls
   `data_dir/{name}_queue.jsonl` (~1s) and injects the wake prompt on a trigger, a
   **heartbeat** (5s) for presence, and an **activity monitor** that hashes the terminal
   screen to light the "working" pill.
3. **`bin/wrapper_api.py <agent>`** — same role for API-model agents (OpenAI-compatible
   endpoints); calls `/v1/chat/completions` instead of driving a terminal.

They coordinate **only through the shared `data_dir`** (JSONL message store, per-agent
queue files, cursors, roles) and the shared `AGENTCHATTR_*` overrides — there is no RPC
between wrapper and server beyond the register/heartbeat REST calls and the queue files.

**The @mention trigger loop:** server router (`src/server/router.py`) parses `@mention`
→ `src/server/agents.py` writes `{agent}_queue.jsonl` → the wrapper's queue watcher picks
it up → injects `use mcp to read #<channel> - you're mentioned, ...` via `tmux send-keys`
(Unix) or Win32 `WriteConsoleInput` (Windows) → the agent uses MCP tools to read/respond.
A per-channel **loop guard** (`routing.max_agent_hops`) pauses agent-to-agent chains;
human mentions always pass through; `/continue` resumes.

## Directory map (the "why", not the full listing)

- `src/` — the engine library (absolute `src.*` imports). Subpackages: `core` (config
  loader, `atomic_io`, version check), `state` (runtime singletons `app_state.state` /
  `mcp_state`), `storage` (per-feature JSON/JSONL stores), `session` (session
  orchestration), `mcp` (tool bridge + injection), `server` (FastAPI app, registry,
  router), `wrapper` (per-OS keystroke injection + identity).
- `bin/` — runtime entry scripts (`run.py`, `wrapper.py`, `wrapper_api.py`).
- `launchers/{windows,macos-linux}/` — OS launch scripts, **engine-internal** (reached
  only via `launch.*`). They auto-create `.venv` and `pip install -r requirements.txt`
  on first run.
- `config/` — engine defaults: `config.toml` (agent roster, ports, routing) +
  `config.local.toml.example`.
- `static/` — the browser UI (vanilla JS, WebSocket client). `session-presets/` — built-in
  session templates. `instance-template/` — copied into a project as `.agentchattr/`.
- `docs/` — living design docs: `ENGINE_MODE.md`, `DECISIONS.md` (standing decisions),
  `FORK_REMOTES.md`, `AGENT_BOOTSTRAP.md`.

The README's Architecture section has a per-file table; consult it rather than re-deriving.

## Config layering

`load_config()` (`src/core/config_loader.py`) merges, in order:
1. `config/config.toml` — engine defaults (agent roster).
2. `config/config.local.toml` (gitignored) — **`[agents]` only**, added alongside; a local
   agent that collides with an existing name is ignored (protects claude/codex/gemini).
3. `AGENTCHATTR_*` env vars — `PORT`, `MCP_HTTP_PORT`, `MCP_SSE_PORT`, `DATA_DIR`,
   `UPLOAD_DIR`. Equivalent CLI flags (`--port`, `--data-dir`, …) are hoisted into these
   env vars by `apply_cli_overrides()`, which **must run before `load_config()`** — all
   three entry points do this. Relative override paths anchor at the shell CWD, **not** the
   install dir, so `--data-dir ./.agentchattr` lands inside the invoking project.

Per-instance isolation = give the server and every wrapper the **same** `AGENTCHATTR_*`
values (different ports + `data_dir` per project). The `instance-template/` thin wrappers
+ `_load.{py,sh}` do exactly this from a `config.toml`.

## Common commands

```sh
# Run the server directly (dev). Add --port/--mcp-http-port/--data-dir to isolate.
python bin/run.py

# Run one agent wrapper (agent name must exist in config/config.toml, be on PATH).
python bin/wrapper.py claude
python bin/wrapper.py claude -- --dangerously-skip-permissions   # flags after -- go to the CLI

# Deps (launchers do this automatically on first run):
python -m venv .venv && .venv/bin/pip install -r requirements.txt

# Launch this repo's own instance (Mac/Linux; auto-starts server if needed):
sh .agentchattr/start.sh
sh .agentchattr/start_codex.sh

# Build a release bundle:
python tools/build_release.py
```

Mac/Linux auto-trigger needs `tmux` (`brew install tmux`). Windows needs no extra deps.

## Tests

Tests are **`unittest`-based** (not pytest; no pytest config, pytest is not a dependency).
Each file inserts the repo root on `sys.path`, so run from the repo root.

```sh
python -m unittest tests.test_router                 # single module
python -m unittest tests.test_router.RouterMentionTests.test_hyphenated_agent_name_is_parsed_as_full_mention  # single test
python -m unittest discover -s tests -p 'test_*.py'  # full suite
```

The full suite needs the runtime deps installed — modules importing `src.server.*` /
`src.mcp.*` fail with `ModuleNotFoundError: fastapi` / `mcp` if you run bare system Python.
Use the `.venv` (or `pip install -r requirements.txt`) first. Pure-logic modules (router,
naming, identity, atomic_io, …) pass with stdlib alone. No linter/formatter is configured.

## Deliberate decisions — do not "fix" these

From `docs/DECISIONS.md` — these look like omissions or duplication but are intentional:

- **No `StoragePort` abstraction.** The ~7 stores under `src/storage/` hand-roll
  `_load`/`_save`; durability is covered by `src/core/atomic_io.py`. YAGNI until a second
  backend is scheduled.
- **No MCP identity proxy.** Agents direct-connect to MCP with a per-agent bearer token
  (token in env, never argv); the server derives identity from the token. Do not
  reintroduce a proxy for identity stamping.
- **The `@mention` send-gate asymmetry is intentional.** `@all` is gated by `reachable()`
  (active ∧ present); an explicit `@mention` of an offline agent is instead **queued**.
  Different predicates on purpose — do not unify them.
- **`instance-template/_load.py` duplicates the path-resolve rule** from
  `src/core/config_loader.py` on purpose: it runs before the engine install dir is known,
  so it can't import `src/`. Guarded by `tests/test_config_resolve_drift.py`. Keep the dup.

## Launcher file modes (git)

The launch chain uses `exec` (not `sh <file>`), so entry points need the exec bit. When
adding or syncing launcher scripts, preserve these git modes:
- entry wrappers (`launch.sh`, `launchers/macos-linux/*.sh`, each instance's
  `start.sh` / `start_*.sh` / `open.sh`) → **`100755`** (missing `+x` → `Permission denied`);
- source-only `_load.sh` → **`100644`** (sourced via `.`, never executed);
- Windows `*.cmd` / `*.bat` → **`100644`** (CRLF forced via `.gitattributes`).

## Repo / git notes

- Commits follow Conventional Commits with a scope, e.g. `fix(engine): …`, `docs(bootstrap): …`.
- This is a personal **fork**. `origin` is the push target; `upstream` and `coworker` have
  their push URL set to `DISABLED` as a safety gate. Check all remotes with
  `git fetch --all --dry-run`. Details + sync strategy: `docs/FORK_REMOTES.md`.
- `.gitignore` lists `tests/` and `docs/`, but both are already **force-tracked**. New
  files added under them will not be staged unless you `git add -f`.
