# Project layout reorganization — plan

Status: **DONE — all four stages executed, verified, and committed.** Every
stage carried an explicit `Decision (定案)` line; nothing was left to owner
decision. The goal was folder-structure readability ("group what is related,
name folders for their purpose") while preserving the run-from-source +
wrapper-launch model exactly. Evaluated from a clean-architecture angle, scoped
to **this branch only** (`refactor/arch-backlog`); the `rewrite/native-wrapper`
Rust effort was **not** factored in. Date 2026-06-27 · Branch: `refactor/arch-backlog`.

**Execution outcome (commits):** S1 `822fd4a` · S2 `70639ce` · S3 `9226e57` ·
S4 `d4be9af`. Two refinements made during execution vs. the original plan:
(1) S4 uses **absolute `agentchattr.*` imports uniformly** (including
intra-subpackage), not relative-intra as first sketched — simpler to apply
mechanically and equally clean. (2) S4 surfaced a `__file__`-anchored repo-root
bug: `app.py` (session_templates dir), `config_loader.ROOT`, and
`version_check._ROOT` each computed the root as `Path(__file__).parent`, which
broke when the modules moved 2 levels deep — fixed to `parents[2]`. Final
verification: 228 tests green, server boots (templates + config + 9 agents
resolve), headless UI renders with zero static 404s, and a real codex agent
registers + heartbeats through the refactored wrapper stack.

## 0. Scope and non-goals

In scope (the user's five questions):

1. Folder names should self-document their purpose.
2. `templates/` vs `session_templates/` — what differs, merge or not.
3. `windows/` + `macos-linux/` — common prefix / wrap in one folder.
4. `static/` — the flat frontend dir, organize it.
5. The 34 root `.py` files scattered at the repo root.

**Non-goal — this is NOT packaging.** The project stays a *run-from-source*
app. No `pyproject.toml`, no `setup.py`, no `pip install`, no console
entry-points, no `src/` distribution layout. "External use" means the model in
`project-template/README.md`: an external project copies the per-project
template into its repo as `.agentchattr/`, points it at this install, and calls
the **wrapper** scripts — it never imports this project as a library. Stage 4
introduces an *internal* Python package purely for code organization; that is
folder grouping, not distribution.

## 1. Invariants — must hold after every stage (verification contract)

These are the acceptance gates re-checked at each stage's end:

- `python run.py` (from repo root) boots the web UI (8300) + MCP (8200/8201).
- `python wrapper.py <agent>` and `python wrapper_api.py <agent>` launch agents.
- The OS launchers still (a) auto-create `.venv`, (b) auto-start the server if
  the port is free, (c) launch the agent wrapper — from their new location.
- The per-project external template still resolves `$AGENTCHATTR_ROOT/...` and
  hands off to the install's launchers.
- `static/index.html` loads every JS/CSS in the same order with cache-busting
  `?v=` intact; sounds/favicon/logo resolve.
- The 228-test suite is green (`python -m unittest discover -s tests`).
- Runtime smoke: headless Chrome via `chrome-devtools` CLI against
  `.venv/Scripts/python.exe run.py` renders the chat UI and a real agent
  (codex) joins and answers — per `memory/project_runtime_verification`.

## 2. Decisions summary

| # | Stage | Decision (定案) |
|---|---|---|
| S1 | Disambiguate templates | Rename `templates/project/` → root `project-template/` (drop the redundant single-child `templates/` wrapper). **Keep** `session_templates/` as-is. **Do not merge** — unrelated concepts. |
| S2 | Group OS launchers | Move `windows/` → `launchers/windows/`, `macos-linux/` → `launchers/macos-linux/`. Rewrite the repo-root `cd` in all 31 scripts (`..` → `../..`). |
| S3 | Organize static/ | `static/{js,css,assets}/`; `index.html` stays at `static/` root; `sounds/`,`favicon.ico`,`logo.png` → `assets/`. Update index.html paths + `sounds.js` 3 URLs. |
| S4 | Group root modules | Move 30 library modules into an internal `agentchattr/` package (7 subpackages). Keep the 4 entry scripts (`run.py`,`wrapper.py`,`wrapper_api.py`,`build_release.py`) at repo root. Rewrite internal imports to absolute `agentchattr.*`. |

Execution order: **S1 → S2 → S3 → S4** (lowest blast-radius first; S4 is the
largest and is committed last so a regression is isolated). One commit per
stage; verification gate (§1) before each commit.

---

## Stage 1 — Disambiguate the two "templates" directories

**Problem.** Two dirs share the word *template* but are unrelated concepts:

- `templates/` contains exactly one child, `project/` — the **deployment
  scaffold** an external project copies to `.agentchattr/` (README, config.toml,
  `_load.{py,sh}`, `start_*.{cmd,sh}` thin wrappers). The `templates/` wrapper
  layer is redundant (single child).
- `session_templates/*.json` are **chat-session presets** (`code-review`,
  `debate`, `design-critique`, `planning`) loaded by the server at startup
  (`app.py:229` → `SessionStore(templates_dir=ROOT/"session_templates")`).

**Decision (定案).**
- Rename `templates/project/` → **`project-template/`** at repo root; delete the
  empty `templates/` wrapper.
- **Keep `session_templates/` unchanged.** It is already self-qualifying
  ("session" distinguishes it from "project"), it matches the domain term the
  code uses ("session template"), and it is referenced as a path string in
  `app.py` + the `SessionStore` loader. Renaming it would be churn on a working
  loader for no clarity gain (it does not collide once `templates/` →
  `project-template/`). The minor hyphen/underscore inconsistency
  (`project-template` vs `session_templates`) is a deliberate accept.
- **Do not merge.** Deployment scaffold ≠ session presets; merging would
  conflate a copied-out per-project directory with server-loaded JSON config.

**Reference updates.**
- `build_release.py:52` — `"templates"` → `"project-template"` in `INCLUDE_DIRS`.
- `config_loader.py:84` — comment `templates/project/_load.py` →
  `project-template/_load.py`.
- `README.md` — any `templates/project` mention (copy-out instructions).
- Inside the moved dir: `project-template/README.md` self-references
  (`cp -R .../templates/project ...` → `.../project-template`).

**Verify.** §1 gate (the move touches no Python import path; the template's own
`_load.*` resolution is path-relative and unaffected). `git grep -n templates`
shows no stale `templates/project` references.

**Commit.** `refactor(layout): rename templates/project -> project-template`.

---

## Stage 2 — Group OS launchers under `launchers/`

**Problem.** `windows/` (16 `.bat` + README) and `macos-linux/` (15 `.sh` +
README) are parallel OS-specific launcher sets cluttering the repo root.

**Decision (定案).** Wrap both under a single self-documenting parent:
`launchers/windows/` and `launchers/macos-linux/`. Keep the per-OS split (their
contents are genuinely OS-specific). Chosen name `launchers/` over `scripts/`
(too generic — would invite build/dev scripts) and `bin/` (implies
PATH-installed executables).

**Critical coupling — repo-root resolution.** Every launcher locates the repo
root from its own directory:
- `.bat`: `cd /d "%~dp0.."` (script dir → up 1).
- `.sh`: `cd "$(dirname "$0")/.."` (script dir → up 1).

Moving the scripts one level deeper (`launchers/windows/…`) means the root is now
**two** levels up. **Every one of the 31 scripts' `cd` line must change**:
- `.bat`: `cd /d "%~dp0.."` → `cd /d "%~dp0..\.."`
- `.sh`: `cd "$(dirname "$0")/.."` → `cd "$(dirname "$0")/../.."`

This is the easily-missed correctness item; it is the bulk of Stage 2.

**Reference updates.**
- 31 launcher scripts: the `cd` line above (the only in-script change — the
  `python run.py` / `wrapper.py` invocations run after `cd` to root, so they are
  unchanged).
- `launchers/windows/README.md` — the chain diagram + `../macos-linux/`
  cross-ref stays valid (both still siblings under `launchers/`).
- `build_release.py:50-51` — `"windows"`,`"macos-linux"` → single `"launchers"`.
- `config.local.toml.example:12` — `windows/start_api_agent.bat` →
  `launchers/windows/start_api_agent.bat`.
- `README.md` — all `./macos-linux/start*.sh`, `windows/start_*` table rows,
  "open a terminal in the `macos-linux` folder" instructions →
  `launchers/macos-linux/…`, `launchers/windows/…`.
- `project-template/start*.sh` / `start*.cmd` — the handoff
  `exec "$AGENTCHATTR_ROOT/macos-linux/start.sh"` →
  `$AGENTCHATTR_ROOT/launchers/macos-linux/start.sh` (and the `.cmd` Windows
  equivalents pointing at `windows/`).
- `project-template/config.toml:13` + `project-template/README.md:138` — comment
  paths `agentchattr/macos-linux/` / `windows/` → `launchers/...`.

**Verify.** §1 gate. Manually run `launchers/windows/start_codex.bat` end-to-end
in the runtime check: the server auto-starts and codex joins — proves the
two-level `cd` and the template handoff both resolve.

**Commit.** `refactor(layout): group OS launchers under launchers/`.

---

## Stage 3 — Organize the `static/` frontend

**Problem.** 23 flat entries: 16 JS, 3 CSS, `index.html`, `favicon.ico`,
`logo.png`, `sounds/` (7 mp3). Hard to scan; asset vs code vs entry all mixed.

**Decision (定案).** Group within `static/`:
- `static/js/` — the 16 modules (core, format, api, wsClient, store, agentview,
  sounds, version-pill, help, sessions, jobs, channels, rules-panel,
  naming-lightbox, settings, chat).
- `static/css/` — style.css, sessions.css, jobs.css.
- `static/assets/` — favicon.ico, logo.png, sounds/ (the mp3 dir moves whole).
- `static/index.html` **stays at the `static/` root** — it is the served entry
  (`run.py:113` reads `static_dir/"index.html"`); keeping it at root means
  `run.py` is unchanged.

The FastAPI mount is the whole dir (`app.mount("/static", StaticFiles(static))`)
so URLs simply gain the subdir segment (`/static/js/chat.js`); the mount and
`run.py` need no change — only in-file URL references move.

**Reference updates.**
- `static/index.html` — 3 `<link href="/static/*.css">` → `/static/css/*.css`;
  16 `<script src="/static/*.js">` → `/static/js/*.js` (script **order** and
  every `?v=` query preserved verbatim); `favicon` (line 10) + `logo` (line 16)
  → `/static/assets/`.
- `static/js/sounds.js` — 3 hardcoded `new Audio('/static/sounds/${name}.mp3')`
  (lines 28, 39, 88) → `/static/assets/sounds/${name}.mp3`.
- No server-side change (mount path and `index.html` location unchanged). No
  `?v=` bumps needed — file *contents* are unchanged, only their paths; but bump
  any file whose URL changed only if a stale cache would 404. Since the paths
  change, browsers fetch fresh URLs anyway; existing `?v=` values are kept.

**Verify.** §1 gate, with emphasis on the runtime headless check: the page must
render (all 16 scripts 200, not 404), styles apply, and a notification sound
loads (`/static/assets/sounds/*.mp3` resolves). Check the browser console for
zero 404s on static assets.

**Commit.** `refactor(layout): organize static into js/css/assets`.

---

## Stage 4 — Group root modules into an internal `agentchattr/` package

**Problem.** 34 `.py` at the repo root, flat — the user's core complaint
("全部攤平很難理解那些有相關"). No grouping signals which modules form the
server, the wrapper, the stores, the MCP bridge, etc.

**Decision (定案).** Introduce **one internal package `agentchattr/`** with seven
domain subpackages. Move the 30 library modules in; **keep the 4 entry scripts
at the repo root** as real files (not shims) so the launchers' `python
wrapper.py <agent>` / `python run.py` invocations are unchanged and anything that
imports an entry (e.g. the boot-resume hook) keeps working. Rewrite all internal
imports to absolute `agentchattr.<subpkg>.<module>`.

Rationale for "entries at root, library in package": the launchers and the
`build_release` manifest reference the entry filenames; a top-level `agentchattr/`
package avoids the root-level `wrapper.py`-file vs `wrapper/`-package name
collision (the subpackage is `agentchattr.wrapper`, distinct from the root
`wrapper.py`). `agentchattr/` nested in a repo named agentchattr is the standard
Python app layout, not redundancy.

### Module → subpackage mapping (34 total)

| Subpackage | Modules | Role |
|---|---|---|
| *(repo root, entries)* | `run.py`, `wrapper.py`, `wrapper_api.py`, `build_release.py` | invocation entry points / dev tool — unchanged location |
| `agentchattr/core/` | `atomic_io.py`, `config_loader.py`, `version_check.py` | cross-cutting leaf utilities |
| `agentchattr/state/` | `app_state.py`, `mcp_state.py` | in-memory runtime singletons |
| `agentchattr/storage/` | `store.py`, `rules.py`, `summaries.py`, `jobs.py`, `schedules.py`, `settings_store.py`, `archive.py` | JSON-persisted stores |
| `agentchattr/session/` | `session_engine.py`, `session_store.py` | multi-agent session orchestration |
| `agentchattr/mcp/` | `mcp_bridge.py`, `mcp_inject.py` | MCP server bridge + wrapper-side injection |
| `agentchattr/server/` | `app.py`, `router.py`, `agents.py`, `registry.py`, `naming.py`, `commands.py`, `presence_monitor.py`, `schedule_runner.py`, `uploads.py` | FastAPI app, routing, agent registry, runtime tasks |
| `agentchattr/wrapper/` | `supervisor.py`, `identity.py`, `server_client.py`, `unix.py` (was `wrapper_unix.py`), `windows.py` (was `wrapper_windows.py`) | agent-launcher subsystem support |

Renames within `agentchattr/wrapper/`: drop the redundant `wrapper_` prefix —
`wrapper_unix.py`→`unix.py`, `wrapper_windows.py`→`windows.py` (the package name
already says "wrapper"). `wrapper.py` (entry) imports them conditionally at
`wrapper.py:448/452`.

### Dependency direction (sanity — no problematic cycle)

`core` is a leaf (imported by all). `state`,`storage`,`session` depend on `core`.
`server` depends on `core`,`state`,`storage`,`session`. `mcp` depends on
`core`,`state`,`storage`, plus `server.uploads` (one pre-existing
`mcp_bridge`→`uploads` edge — kept; `uploads` is server-domain). `wrapper`
(entry + support) depends on `mcp.mcp_inject`,`wrapper.*`,`core`. The
server↔mcp cycle is broken by placing `mcp_state` in `state/` (so `server.app`
imports `state.mcp_state`, not `mcp/`).

### Import-rewrite scope (exact, from `git grep`)

Every internal import edge becomes `from agentchattr.<subpkg>.<mod> import …`.
Known edges to rewrite (re-confirm with `git grep -nE "^(from|import) "` at
execution — this is the authoritative list):
- `app.py` (18 imports → `storage.*`, `rules`→`storage.rules`, `router`→
  `server.router`, `agents`→`server.agents`, `registry`→`server.registry`,
  `session_store`/`session_engine`→`session.*`, `version_check`→`core.*`,
  `commands`/`presence_monitor`/`schedule_runner`/`uploads`→`server.*`,
  `mcp_state`→`state.mcp_state`, `settings_store`→`storage.settings_store`,
  `app_state`→`state.app_state`).
- `mcp_bridge.py` → `state.mcp_state`, `server.uploads`, `state.app_state`.
- `presence_monitor.py` → `state.mcp_state`.
- `registry.py` → `core.atomic_io`, `server.naming` (intra-server, may use
  relative `from .naming import …`).
- `rules/schedules/store/summaries/jobs/session_store/settings_store/mcp_state`
  → `core.atomic_io`.
- `session_engine.py` → `session.session_store` (intra → `from .session_store`).
- `wrapper.py` → `wrapper.identity`/`wrapper.server_client`/`mcp.mcp_inject`;
  `:448` `from agentchattr.wrapper.windows import …`; `:452` `…wrapper.unix…`.
- `wrapper_api.py` → `wrapper.identity`, `wrapper.server_client`.
- `wrapper_unix.py`/`wrapper_windows.py` → `wrapper.supervisor` (intra →
  `from .supervisor import …`).
- `run.py:18` → `from agentchattr.state.app_state import state`; plus its
  `from app import app` (mount site) → `from agentchattr.server.app import app`.
- **`tests/`** — every `from <mod> import …` (e.g.
  `tests/test_wrapper_mcp_config.py:18,114,127,140` `from mcp_inject import …` →
  `from agentchattr.mcp.mcp_inject import …`). Enumerate with
  `git grep -nE "^(from|import) " tests/`.

Intra-subpackage imports use **relative** form (`from .naming import`); cross
-subpackage imports use **absolute** (`from agentchattr.state.app_state import`).

### `build_release.py` update (also fixes a pre-existing bug)

`INCLUDE_FILES` currently enumerates root `.py` by name and is **stale** — it
omits ~16 modules actually imported at runtime (`app_state`, `mcp_inject`,
`mcp_state`, `commands`, `uploads`, `presence_monitor`, `schedule_runner`,
`settings_store`, `archive`, `identity`, `server_client`, `supervisor`,
`naming`, `atomic_io`, `version_check`, `config_loader`) — so a release zip
built today would be missing modules. Replace the per-file `.py` list with a
single `INCLUDE_DIRS` entry `"agentchattr"` (+ keep the 4 root entry `.py` and
`open_chat.html` in `INCLUDE_FILES`). This both adapts to the new layout and
fixes the missing-modules bug for free.

### Verify (most rigorous gate)

1. `python -c "import agentchattr"` and `python -c "from agentchattr.server.app
   import app"` — import-time soundness.
2. Full 228-test suite green (run with `.venv/Scripts/python.exe` since tests
   import the app).
3. `python run.py` boots; runtime headless Chrome check renders UI; a real codex
   agent launched via `launchers/windows/start_codex.bat` joins and answers.
4. `python wrapper.py codex` resolves the platform module (`agentchattr.wrapper.
   windows`) without ImportError.
5. `python build_release.py` produces a zip; unzip and `python -c "import
   agentchattr"` inside it (no missing module).

### Commit

`refactor(layout): group root modules into agentchattr package`. Single atomic
commit (move + import-rewrite + build_release + tests must land together or the
tree is red).

---

## 3. Per-stage commit & verification protocol

For each stage, in order S1→S2→S3→S4:

1. Apply the moves + reference updates for that stage only.
2. Run the §1 invariant gate (tests + targeted runtime check for the stage's
   risk area).
3. Five-dimension self-review of the diff (style / content / logic /
   architecture / planning) per `rules/review-defaults.md`.
4. Commit at green (one commit per stage; Conventional Commits, English,
   no AI-attribution trailer).
5. Only after all four stages: one consolidated runtime verification (server +
   real agent end-to-end) and a final doc-freshness pass (update `README.md`
   structure section, this doc's status, and `docs/ARCHITECTURE_REVIEW_BACKLOG.md`
   if any reference moved).

## 4. Risk register

| Risk | Stage | Mitigation |
|---|---|---|
| Launcher `cd` depth wrong → scripts run from wrong dir | S2 | Edit all 31 `cd` lines; runtime-run one `.bat` end-to-end. |
| Missed static URL → 404 on a script/sound | S3 | Console-zero-404 check in headless runtime. |
| Missed internal import → ImportError at boot | S4 | `import agentchattr` smoke + full test suite + boot. |
| Template handoff path stale after launcher move | S2 | Grep `project-template/` for `macos-linux`/`windows`; update exec paths. |
| `build_release` ships broken zip | S4 | Build + import-inside-zip check (also fixes existing staleness). |

Rollback: each stage is an isolated commit on `refactor/arch-backlog` (pushed to
`origin` as backup); revert the single stage commit if its gate fails.
