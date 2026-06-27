# Architecture review — backlog

Status: **in progress** — Batches 0–3 done, Batch 4 partial (8/9) · Branch: `refactor/arch-backlog`

## Progress

Each item is committed individually (green tree + per-item five-dimension review).
Partials note what was intentionally deferred and where it sequences next.

| Item | State | Commit / note |
|---|---|---|
| BUG-1 | done | `640b396` hold lock + reject stale snapshot on advance |
| BUG-3 | done | `6d3e6d8` `atomic_io.write_json_atomic` |
| SRV-1 | done | `e893bcf` route all WS broadcasts through `_broadcast` |
| WRAP-1 | done | `31c6e78` `server_client.py` |
| FE-1 | done | `df0aec2` `api.js` + `wsClient.js` |
| MCP-1 | done | `ad6e7bf` drop vestigial sender-stamping |
| BUG-2 | done | `4ba754b` `@all` tags only reachable agents |
| WRAP-2 | done | `436c643` `mcp_inject.py` |
| STATE-5 | done | `6e72c2e` `naming.py` (parse/slot/family/color) |
| SRV-2 | done | `09894e7` `app_state.state` single object |
| MCP-3 | done | `025d911` `mcp_state.py` (presence/cursors/roles) |
| WRAP-3 | partial | `9cf1af6` argparse/proxy extracted; identity+monitor closures → WRAP-5 |
| FE-2 | partial | `47a9895` `format.js` + explicit globals; state-coupled leaf extraction → after FE-3 |
| FE-3 | partial | `9214916` `activeChannel` single-owner; other bridged globals follow same pattern |
| STATE-6 | done | `037695e` collapse rewrite + `paused`→`routing_paused` |
| STATE-3 | done | `0d61519` enrich a copy, keep view fields off the record |
| SRV-4 | done | `472c082` public `store.resolve_decision` / `jobs.resolve_message` |
| SRV-5 | partial | `bcb5e7e` `_resolve_targets`/`_finish_agent_rename`; divergent trigger loops left inline |
| WRAP-6 | done | `1121894` unified `resolve_path` + `~`-expansion fix |
| STATE-1 | open | presence-service unification (registry/mcp_state/router) — beyond BUG-2's surface fix |
| SRV-6 | done | `settings_store.py` `SettingsStore`+`HatStore` — lock + validated `update(patch)` + atomic persist; 55-line validator moved out of app.py |
| SRV-3 | done | `commands.py` macro dispatch + draft logic → `session_engine.process_draft`; thin route-and-trigger core |
| FE-4 | done | inbound `onmessage` chain → per-type `Hub.on` (chat.js); switch deleted, `onmessage` is just `Hub.emit` |
| FE-5 | pending | `appendMessage` variants → `_messageRenderers` registry |
| WRAP-4/5 | pending | shared `run_loop(backend)` + `identity.py` (absorbs WRAP-3 closure cluster) |
| MCP-2 | verify-gated | needs live codex static-bearer-header check; cannot run headless |
| STATE-7, FE-6 | deferred | large/strategic — explicit go decision required |

Tests: 42 → 139 passing (`unittest`). The three large mechanical refactors (SRV-2,
MCP-3, FE-3) used a `tokenize`-based renamer to avoid corrupting strings/comments.

## How to read this

- **Source:** a 5-agent architectural review (2026-06-27), one agent per subsystem
  (app.py / state-layer / MCP / Python-wrapper / frontend). Findings are
  architecture-level only — no style/typo notes.
- **Priority:** P1 (structural blocker or correctness bug) · P2 (clear coupling /
  duplication / SRP win) · P3 (cleanup, low risk, low urgency).
- **Rust-rewrite relationship** (`rewrite/native-wrapper`) is recorded per item as
  a *reference note only*. It is **NOT** a reason to defer Python cleanup: the
  Python wrapper is the code in use on `main` today (Windows runs the Python path
  after the console patch). The two tracks are parallel and non-conflicting; a
  clean Python structure also serves as a reference for the Rust port.

---

## 1. Cross-cutting meta-patterns

The same architectural problem recurs across subsystems. These are the highest-
value framing; individual backlog items below are instances of them.

- **A — Missing contract layer.** The server's HTTP/WS wire contract has no single
  definition; every caller re-specifies it. Server broadcast helper `_broadcast`
  exists but is bypassed by ~21 inline fan-outs (app.py); the wrapper inlines the
  HTTP contract at 28 sites with `_auth_headers` duplicated verbatim; the frontend
  hard-codes `fetch('/api/…')` + `ws.send({type})` at ~76 sites. → SRV-1, WRAP-1, FE-1.
- **B — God-module + module-global mutable state.** app.py (2637 / 11 globals),
  mcp_bridge.py (963 / 7 state kinds), registry.py (600 / identity+policy+view+auth),
  chat.js (4211 / 12 concerns) couple by poking each other's internals or lazy
  imports, and block unit testing. → SRV-2, MCP-3, STATE-5, FE-2/3, WRAP-2/3.
- **C — Single-source-of-truth fractures (cause real bugs).** Agent online-state in
  3 places (registry / mcp_bridge._presence / router); frontend `activeChannel` in 3
  (global / localStorage / Store); frontend messages use the DOM as the model;
  session advance decides off a stale snapshot. → BUG-1, BUG-2, FE-3.
- **D — Persistence decided per-store.** session_store / jobs use bare `write_text`
  (crash mid-write corrupts the whole file); registry uses atomic tmp+replace; store
  uses fsync+append. Three diverged durability strategies, O(total) rewrite per
  mutation, no shared atomic-JSON helper. → BUG-3, STATE-7.

---

## 2. Correctness bugs (fix first — these actually misbehave)

| ID | Bug | Effect | Fix direction | Cost |
|---|---|---|---|---|
| **BUG-1** | `SessionEngine.self._lock` (session_engine.py:28) is declared but **never acquired**; `_on_message` snapshots a copy then a 0.3s `Timer` runs `_advance`, which decides next turn/phase from the **stale** snapshot and increments the live session. | Two near-simultaneous expected-agent messages schedule two timers off one snapshot → turn incremented twice → a participant silently skipped / phase mis-stepped. | Hold `self._lock` across decide+mutate, **or** push a locked compare-and-advance into SessionStore keyed on current pointers (reject stale snapshot). | Low |
| **BUG-2** | `@all` resolves targets from `registry.get_active_names()` (claimed) at app.py:298/848 but the send path gates on `mcp_bridge.is_online()` (present). Identity and presence are separate stores stitched by the reaper loop (app.py:371-434) + direct pokes into private `mcp_bridge._presence`. | `@all` tags agents that are claimed but **offline**. | Registry owns identity only; promote presence to a service exposing one `reachable = active ∧ present` query consumed by both `online_checker` and the route path; reaper becomes a presence subscriber. | Medium |
| **BUG-3** | `session_store._save` (session_store.py:60) and `jobs._save` (jobs.py:35) are bare `write_text`. | A crash mid-write truncates/corrupts the **entire** `Sessions.json` / jobs file. | One shared atomic-JSON helper (tmp + `os.replace` + fsync), reused by session/job/rename saves. | Low |

> BUG-2's fix is the same work as STATE-1 (presence/identity unify). BUG-3's helper
> is the seed of STATE-7 (storage port).

---

## 3. Backlog by subsystem

### Server — `app.py` (2637)

| ID | P | Item | Clean direction | Cost |
|---|---|---|---|---|
| SRV-1 | P1 | WS fan-out duplicated ~21× — the 12 typed `broadcast_*` re-inline the dead-client loop that `_broadcast` (856) already is, plus 9 inline copies. | Route all broadcasters + inline copies through `_broadcast`. | 1 file, ~21 sites, ~150 lines deleted. Zero caller impact. |
| SRV-2 | P1 | 11 reassigned module globals; handlers need `import app as _self` (182); `run.py` 65-75 re-exports all 11 into mcp_bridge. Blocks testing. | `app_state.py` with one `state` object; handlers read `state.store`; `run.py` forwards one object. (Lazy app↔mcp_bridge imports collapse too.) | New ~40-line module; mechanical touch of most handlers + run.py + mcp_bridge accesses. High caller-count, low risk (rename-only). |
| SRV-3 | P2 | `_handle_new_message` (611-852) mixes slash-command expansion (hardcoded prompt templates 696-759), session-draft detect/validate/lineage, and route→trigger. | `commands.py` (slash dispatch); move draft logic to session_engine; thin route-and-trigger core. | 1-2 files, ~150 lines moved. |
| SRV-4 | P2 | Handlers reach into store/jobs privates: `resolve_decision` (1711) uses `store._lock/_messages/_rewrite`; `resolve_job_message` (2009) calls `jobs._save`. Atomicity lives in the HTTP layer. | Add public `store.resolve_decision(...)` + public jobs mutate-and-save; handlers call them. | 2 files, ~30 lines, 2 sites. |
| SRV-5 | P2 | Agent-routing trigger block duplicated 3× (805-852, 1964-1982, 1856-1864); label→id rename+migrate+broadcast duplicated 4× (1304/1336/2183/2124). | `routing.resolve_and_trigger(...)` helper + registry-side `rename_and_migrate(...)`. | 1 helper module, ~7 sites. |
| SRV-6 | P2 | `room_settings` / `agent_hats` are lock-free dicts mutated on the loop and read in the background thread; compound read-modify-write not atomic. | Fold into `settings_store` / `hats` with a lock + validated `update(patch)` (the 55-line inline validator 1246-1302 moves there). | 2 modules, ~150 lines, ~10 sites. |
| SRV-7 | P3 | `configure` does unconditional FS migration + spawns 2 threads with a 127-line inlined closure → untestable. | Extract thread bodies to `presence_monitor.py` / `schedule_runner.py`; gate startup behind a flag. | 2 files, ~160 lines. |
| SRV-8 | P3 | Self-contained leaves: version-check (2519-2626), `_auto_cast` (2502-2516 → session_engine), hats persistence (78-130). | Extract to small modules; repoint the one `app.set_agent_hat` import. | ~3 files, ~150 lines. |

### State & persistence — `router / session_engine / session_store / store / registry / jobs`

| ID | P | Item | Clean direction | Cost |
|---|---|---|---|---|
| STATE-1 | P1 | = **BUG-2**: presence/identity/router-names are 3 owners of "is this agent reachable". | Unify into one reachability source; registry = identity only. | Medium (extract presence module, repoint ~6 app.py sites + online_checker). |
| STATE-2 | P1 | = **BUG-1**: session advance non-atomic. | Locked compare-and-advance. | Low-medium. |
| STATE-3 | P2 | `list_active`→`_enrich` writes derived view-model fields (`total_phases`/`phase_name`/…) onto live session dicts, which `_save` then persists. | `list_all` returns copies, or `_enrich` returns new dicts; keep derived fields out of the system-of-record. | Low. |
| STATE-4 | P2 | = **BUG-3** + O(total) whole-file rewrite per mutation (jobs rewrites all nested messages on every `add_message`). | Shared atomic-JSON helper; stop nesting messages in the rewritten job blob (append-log like MessageStore). | Low for helper; medium if job message model moves. |
| STATE-5 | P2 | registry.py (600) fuses identity storage with a naming/slot policy engine (121-364, 521-537), a view helper (`_derive_color` 580, `get_agent_config` 390), and an auth resolver (`resolve_token` 505). | Extract `NamingPolicy`/`SlotAllocator` (pure fns over the instance set); move color/wire-shape to a view layer; leave `RuntimeRegistry` = storage + token lookup. | Medium, internal; public surface stays. |
| STATE-6 | P3 | Two unrelated `paused` (router loop-guard vs session human-interrupt) share the status payload; `store._rewrite` (109) and `_rewrite_jsonl` (193) are identical bodies. | Rename one `paused`; collapse the two rewrite paths. | Trivial. |
| STATE-7 | P3 (strategic) | No storage port — each store hardcodes JSON/JSONL I/O inside the domain class; swapping backends means rewriting all three. Weakest seam in the layer. | Define a storage port; back the three stores with it. **Defer** — large, only worth it if a backend change is actually wanted. | High. |

### MCP — `mcp_bridge.py (963) / mcp_proxy.py (326)`

| ID | P | Item | Clean direction | Cost |
|---|---|---|---|---|
| MCP-1 | P1 | Proxy sender-stamping is vestigial — `_resolve_tool_identity` (mcp_bridge.py:166-172) already derives `sender` from the token and discards the client value. Proof: `_SENDER_PARAMS` is already drifted (omits `chat_rules`/`chat_summary`/`chat_propose_job`), yet identity still works. Sender is not agent-spoofable (token override + agent-family rejection without token). | Delete `_maybe_inject_sender` + `_SENDER_PARAMS`. | ~40 lines deleted, **zero server change, zero behavior change**. |
| MCP-2 | verify | Can the proxy be deleted entirely? Its one irreplaceable job is attaching the bearer header for codex (every other agent injects `Authorization: Bearer` straight into its MCP client config). | Verify (~30 min) whether codex CLI can inject a static bearer/header via `-c mcp_servers.agentchattr.http_headers=…` / bearer config. **Yes →** delete `mcp_proxy.py`, fold codex into the direct-inject path. **No →** shrink proxy to a ~50-line header-only shim (drop sender-stamping + SSE rewrite). | 30 min verify, then small. |
| MCP-3 | P2 | mcp_bridge.py is a god-module: 12 tool defs + token-auth + presence/activity + cursors + roles + last-read + identity migration + dual-server, all module-global; app.py pokes `_presence`/`_activity`/`_renamed_from` (358-444); `chat_set_hat` does `import app` (843). | Extract a state module (presence/activity/cursors/roles/last-read + persistence + migration) imported by both app.py and the tools; mcp_bridge = tools + server construction. | ~250-300 lines move, ~15 app.py sites; mechanical. |

> Note: proxy SSE-rewrite (mcp_proxy.py:250-267) + the wrapper SSE branch are
> currently unexercised but are **planned transport-completeness, not dead code** —
> they go only if the proxy is reduced (MCP-2).

### Python wrapper — `wrapper.py (965) / wrapper_windows.py / wrapper_unix.py / wrapper_api.py / config_loader.py`

(Previously under-weighted "the Rust rewrite will absorb it" — re-included at full weight. Parallel tracks; clean the Python that's in use now.)

| ID | P | Item | Clean direction | Cost |
|---|---|---|---|---|
| WRAP-1 | P1 | Server HTTP contract scattered across 28 inline sites (14 in wrapper.py + 14 in wrapper_api.py); `_auth_headers` defined verbatim twice (wrapper.py:385, wrapper_api.py:34); wrapper_api already reaches into `wrapper._register_instance`. | Extract `server_client.py` (`ServerClient` with base_url + thread-safe token; `register/heartbeat/deregister/fetch_roles/fetch_rules/report_sync/read_messages/send`). Both wrappers consume it. | ~120-line module; mechanical 28-site replace; low risk. |
| WRAP-2 | P1 | wrapper.py mixes 5 concerns; the MCP-config wiring block (40-368, ~330 lines) is self-contained and platform-agnostic. | Lift `mcp_inject.py` wholesale; move `_build_tmux_session_name` into wrapper_unix.py; split prompt-construction from queue file-polling. | mcp_inject extraction near-zero-risk; rest medium care. |
| WRAP-3 | P2 | wrapper.py `main()` is ~370 lines wiring registration, proxy, identity, 3 monitor threads, platform dispatch. | Decompose `main()` into the registration / injection-setup / monitor-thread / dispatch steps (pairs naturally with WRAP-1 + WRAP-2). | Medium. |
| WRAP-4 | P2 | Restart loop / inject-delay scaler / `trigger_flag` short-circuit are duplicated across wrapper_windows.py vs wrapper_unix.py; only the injection primitive + activity sensor are genuinely platform-specific. | Shared `run_loop(backend)` / `supervisor.py` parameterized by a thin platform backend (`spawn/wait/inject/sample_activity/cleanup`); platform files shrink to native primitives. | Medium — defines the backend seam; ~80 lines moved; both `run_agent` signatures change. |
| WRAP-5 | P2 | wrapper_api.py re-implements identity-state / heartbeat-409 / queue-poll / deregister parallel to wrapper.py; only `_register_instance` is shared. | Share `ServerClient` (WRAP-1) + a small `identity.py` (name/token lock + 409 handler); keep only the trigger-payload handlers per wrapper. | Low-medium once WRAP-1 lands. |
| WRAP-6 | P3 | config_loader.py and templates/project/_load.py form a producer/consumer pair over `AGENTCHATTR_*` env keys, each hand-rolling path resolution with subtly different rules; the key set lives in 2 files + app.py docs. | Define the `AGENTCHATTR_*` key set + one `resolve_path(raw, anchor)` once (in config_loader, imported by _load.py). | Low. |

### Frontend — `chat.js (4211) + jobs/sessions/channels/rules-panel`

| ID | P | Item | Clean direction | Cost |
|---|---|---|---|---|
| FE-1 | P1 | No client API/WS layer — 44 raw `fetch('/api/…')` + 32 `ws.send({type})` across 5 files, each re-specifying `X-Session-Token`; inbound is a 230-line `if/else` on `event.type` (chat.js:386-594) that duplicates the `Hub.emit` it already feeds. | `api.js` (typed wrappers, centralizes token header + `{error}` parsing) + `wsClient.js` (`send(type,payload)`); migrate the inbound switch handler-by-handler onto `Hub.on` (sessions/jobs/rules already subscribe). | Medium, incremental; 2 files + per-feature follow-ups. |
| FE-2 | P2 | Shared primitives (`escapeHtml`, `renderMarkdown`, `getColor`, `resolveAgent`, `getAvatarSvg`, `appendMessage`) live inside chat.js and are consumed by siblings via implicit globals; `getColor`/`renderMarkdown` are never even assigned to `window` (resolve only because chat.js is a classic script). Wrapping chat.js in an IIFE/ES-module would break siblings with no static warning. | Extract into 2-3 dependency-free leaf modules loaded first; everyone imports from there. Make implicit globals explicit before any module conversion. | Low-medium, move-and-export. |
| FE-3 | P2 | State split between ~20 chat.js `let` globals (exposed via `Object.defineProperty(window,…)`) and the new `Store`; `activeChannel` is tracked in **3** places (global + localStorage + Store). | Finish the migration Store was built for — make Store the single owner of cross-module state; delete the defineProperty bridges per key. | Medium, incremental; infra (Store.watch) exists. |
| FE-4 | P3 | Inbound `onmessage` switch duplicates the Hub; some types handled in both → ordering risk. | Migrate remaining inline cases to `Hub.on` in owning modules; delete the switch. | Low. |
| FE-5 | P3 | `appendMessage` (664-850) is a 190-line type-switch of HTML string templates with manual per-branch `escapeHtml` (XSS-safety unenforced). | Move core variants into the `_messageRenderers` registry (the seam sessions/jobs already use); leave dispatch + scroll bookkeeping. | Low-medium. |
| FE-6 | P1 (strategic) | DOM is the source of truth for messages; features scrape rendered nodes (recolor/reply/pins/rename all read `.msg-*` textContent). Jobs/rules/schedules keep JS arrays — messages are the outlier. | Hold a `messages[]` / `Map<id,msg>` model; render reads from it; mutations update model then patch. **Defer** — high cost, root cause behind several P2s, sequence after FE-1/2/3. | High. |

---

## 4. Suggested batches

Items within a batch share a theme or a precondition; batches are roughly ordered.

- **Batch 0 — correctness (do first).** BUG-1 (session race, low) + BUG-3 (atomic
  write, low) are quick and isolated. BUG-2 (@all offline) = STATE-1, medium, can
  ride with Batch 2.
- **Batch 1 — contract layers (meta-pattern A).** SRV-1 + WRAP-1 + FE-1. Three
  independent subsystems, same theme; each removes the worst per-call-site coupling.
  WRAP-1 also unlocks WRAP-3/WRAP-5.
- **Batch 2 — MCP proxy collapse.** MCP-1 (delete sender-stamping now) → MCP-2
  (verify codex header → delete or shrink proxy). Resolves NATIVE_WRAPPER_REWRITE
  §8.1 and simplifies both wrapper tracks.
- **Batch 3 — god-module containers (meta-pattern B).** SRV-2 (app_state) + MCP-3
  (bridge state) + STATE-5 (registry policy) + WRAP-2/3 + FE-2/3. SRV-2 first — it
  unlocks testing for everything else.
- **Batch 4 — remaining P2/P3 cleanups.** SRV-3/4/5/6, STATE-3/6, WRAP-4/5/6,
  FE-4/5.
- **Deferred (large, own decision).** STATE-7 (storage port), FE-6 (message model).
  Only worth it on an explicit need (new backend / heavy client features).

## 5. Notes

- BUG-2 and STATE-1 are the same work; BUG-3 and STATE-4 share the atomic helper.
- SRV-2 (app_state) is the single highest-leverage refactor — it removes the
  global-singleton barrier that blocks unit-testing every other server change.
- Each item is behavior-preserving unless marked a bug; do them under a
  reproducible check (write a failing test for the 3 bugs first, then fix).
