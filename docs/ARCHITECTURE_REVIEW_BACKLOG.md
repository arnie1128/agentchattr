# Architecture review — backlog

Status: **Decided plan — every item below carries an explicit architectural decision (§0 summary + a per-item "Decision (定案)" line); nothing is left to "owner decision".** Fix first: the SRV-2/MCP-3 migrations shipped dangling cross-module references with no boot/connect test to catch them — `app.py:757` bare `session_token` (NameError on every `/ws` connect — **fixed**), `run.py:113` undefined `session_engine` (NameError in the startup hook — pending), and NEW-SRV-6 `agents.py` importing presence fns from `mcp_bridge` after MCP-3 moved them to `mcp_state` (ImportError in every `broadcast_status` — **fixed**). Execution order: Batch 0 (the dangling-reference regressions + smoke tests) -> Batch 1 (STATE-1 presence unification) -> Batch 2 (durability) -> Batch 3 (MCP proxy collapse) -> Batch 4 (god-module cleanups). Deferred by decision: STATE-7 (storage port — YAGNI, reactivate only on a real backend change). Scheduled, not deferred: FE-6 (message model — real defect, sequenced after FE-3). Date 2026-06-27 · Branch: `refactor/arch-backlog`.

## Progress

Each structural item was committed individually (green tree + per-item five-dimension review). The audit below re-verified every claim against current source; states the old doc got wrong are corrected here. Every not-fully-done item carries three labelled fields in its subsystem section: **Approach (方案)** · **Fix scope (修正範圍)** · **Completion criteria (達成條件)**.

| Item | P | State | Commit / note |
|---|---|---|---|
| SRV-1 | P1 | done | `e893bcf` single `_broadcast` fan-out (app.py:673/675) |
| SRV-2 | P1 | **done** | `09894e7` app_state singleton + the 3 dangling-read fixes (NEW-SRV-1/2/6) + first boot/connect smoke tests |
| SRV-3 | P2 | done | `commands.py` macro dispatch + draft logic in session_engine |
| SRV-4 | P2 | done | `472c082` public `store.resolve_decision` / `jobs.resolve_message` |
| SRV-5 | P2 | partial | `bcb5e7e` `_resolve_targets`/`_finish_agent_rename`; 4 inline rename sites + 4 divergent trigger loops remain |
| SRV-6 | P2 | done | `settings_store.py` `SettingsStore`+`HatStore` (lock + validated `update`) |
| SRV-7 | P3 | open | monitor closures + FS-migration still inline in `configure()` |
| SRV-8 | P3 | open | version-check + `_auto_cast` still inline (hats sub-item already done by SRV-6) |
| BUG-1 / STATE-2 | P1 | done | `640b396` locked compare-and-advance + stale-snapshot reject (session_engine.py:287-294) |
| NEW-SRV-1 | P1 | **done** | fix `state.session_token` (app.py:757) + `/ws`-connect smoke test (test_ws_connect.py) |
| NEW-SRV-6 | P1 | **done** | (found in B0 exec) `agents.py` imported is_online/is_active/get_role from mcp_bridge (moved to mcp_state by MCP-3) → ImportError in every `broadcast_status`; repointed to mcp_state |
| NEW-SRV-2 | P1 | **done** | run.py boot-resume reads `state.session_engine` via a testable `resume_sessions_on_boot()` + startup smoke test |
| NEW-SRV-3 | P3 | open | `version_check` local `state` shadows the app_state singleton (latent) |
| NEW-SRV-4 | P3 | open | `start_session` pokes `session_store._templates` directly (app.py:1914) |
| NEW-SRV-5 | P3 | open | `/continue` handled in two places; WS path ignores the channel (app.py:847) |
| STATE-1 | P1 | open | presence/identity/router still 3 reachability owners; 24 private pokes; never started |
| STATE-3 | P2 | done | `0d61519` `_enrich` copies; view fields stay off the record |
| STATE-4 | P2 | partial | `6d3e6d8` `atomic_io` helper exists, but O(n) per-message rewrite + registry rename-save untouched |
| STATE-5 | P2 | partial | `6e72c2e` `naming.py` pure leaves only; view/auth/4× policy orchestration remain in registry |
| STATE-6 | P3 | done | `037695e` `routing_paused` rename + single `_rewrite` |
| STATE-7 | P3 | deferred | **DECISION: defer** (YAGNI — no second backend; reactivate on a scheduled backend change) |
| NEW-STATE-PERSIST-1 | P2 | **open** | ~9 store-save sites still bare `write_text` / no-fsync; `store._rewrite` truncates in place |
| NEW-STATE-PERSIST-2 | P3 | open | `JobStore.list_all` is a read that writes to disk (jobs.py:91-93) |
| MCP-1 | P1 | done | `ad6e7bf` token-derived identity; proxy forwards raw bytes |
| MCP-2 | P1 | open (verify-gated) | codex direct-bearer inject → delete `mcp_proxy.py`; needs one live codex run |
| MCP-3 | P2 | partial | `025d911` `mcp_state.py` landed; `chat_set_hat` still `import app`; inline presence pokes remain |
| NEW-MCP-1 | P2 | open | `chat_send` god-function: duplicated image-upload + duplicated @mention-trigger loop |
| NEW-MCP-2 | P3 | open | MCP read contract serialized in 3 divergent inline shapes |
| WRAP-1 | P1 | done | `31c6e78` `server_client.py` single HTTP contract |
| WRAP-2 | P1 | **partial** | `436c643` `mcp_inject.py` extracted (1 of 3); tmux helpers + prompt/poll split not done |
| WRAP-3 | P2 | partial | `9cf1af6` argparse/proxy extracted; 4 monitor closures + thread-kwargs dup still inline |
| WRAP-4 | P2 | done | `supervisor.run_loop` shared restart skeleton |
| WRAP-5 | P2 | **partial** | `identity.py` (name/token) landed; heartbeat-409 re-register still duplicated |
| WRAP-6 | P3 | **partial** | `1121894` `resolve_path` within config_loader; `_load.py` dup remains, no guard test |
| NEW-WRAP-1 | P3 | open | 3 forwarders re-instantiate `ServerClient` inside the watcher (wrapper.py:93-105) |
| FE-1 | P1 | done | `df0aec2` `api.js` + `wsClient.js` |
| FE-2 | P2 | partial | `47a9895` only `escapeHtml` extracted; 5 helpers still in chat.js (blocked on FE-3) |
| FE-3 | P2 | partial | `9214916` `activeChannel` single-owner; ~7 cross-module bridged globals remain |
| FE-4 | P3 | done | inbound `onmessage` → `Hub.emit` only (chat.js:379-384) |
| FE-5 | P3 | done | `appendMessage` → `_messageRenderers` registry |
| FE-6 | P1 | open | **DECISION: do**, sequenced last after FE-3 (real defect, not owner-gated) |
| NEW-FE-chatjs-split | P3 | open | chat.js 4254 lines / 132 fns; Tier-A leaves extractable now, Tier-B blocked on FE-3 |

**Tests:** 16 `unittest` modules. `python -m unittest discover -s tests` runs **145 tests green** here; `test_app_state` and `test_archive_feature` need `fastapi` and error on import when it is absent (optional-dependency gap, not a regression). **No test covers `/ws`-connect or app boot** — that gap is exactly why the two SRV-2 `NameError`s shipped uncaught; both fixes must add a smoke test. The three large mechanical refactors (SRV-2, MCP-3, FE-3) used a `tokenize`-based renamer to avoid corrupting strings/comments.

## 0. Decision summary (定案)

Every item's disposition, decided on clean-architecture grounds. Detail + the three fields (Approach / Fix scope / Completion criteria) live in each item's section; each item also repeats its **Decision (定案)** inline. Dispositions: **Done** (closed) · **Do now** (Batch 0) · **Do** (scheduled) · **Accept** (close with rationale, no code change) · **Defer** (declined until a stated trigger).

| Item | Disposition | Rationale (clean-arch) |
|---|---|---|
| SRV-1 | Done | single _broadcast fan-out verified |
| SRV-2 | Done (B0) | app_state singleton + 3 dangling-read fixes + boot/connect smoke tests |
| SRV-3 | Done | commands.py + draft logic moved |
| SRV-4 | Done | public resolve_decision / resolve_message |
| SRV-5 | Do (B4) | unify 4 rename sites + 4 trigger loops; precondition for NEW-MCP-1 |
| SRV-6 | Done | settings_store/hats lock-guarded |
| SRV-7 | Do (B4) | extract presence_monitor/schedule_runner for testability |
| SRV-8 | Do (B4) | low-risk leaf extraction |
| BUG-1 / STATE-2 | Done | locked compare-and-advance |
| NEW-SRV-1 | Done (B0) | fixed: state.session_token + /ws smoke test |
| NEW-SRV-6 | Done (B0) | fixed: agents.py repointed to mcp_state (was ImportError in broadcast_status) |
| NEW-SRV-2 | Done (B0) | fixed: run.py resume_sessions_on_boot() reads state.session_engine + smoke test |
| NEW-SRV-3 | Do (B0) | trivial rename; latent footgun in the P1 file |
| NEW-SRV-4 | Do (B4) | public transient-template method |
| NEW-SRV-5 | Do | fix channel-arg now (correctness); collapse dup B4 |
| STATE-1 | Do (B1) | top structural P1; one reachable() predicate |
| STATE-3 | Done | _enrich copies |
| STATE-4 | Do (a) / Accept (b) | atomic rename-save yes; O(n) accepted+documented (bounded) |
| STATE-5 | Do / Accept | NamingPolicy + view move; resolve_token & _inst_dict stay |
| STATE-6 | Done | routing_paused rename; single _rewrite |
| STATE-7 | Defer | speculative abstraction; reactivate on a real backend change |
| NEW-STATE-PERSIST-1 | Do (B2) | durability correctness; atomic adoption + write_jsonl_atomic |
| NEW-STATE-PERSIST-2 | Do (B2) | trivial; pure-read list_all |
| MCP-1 | Done | token-derived identity |
| MCP-2 | Do (B3) | collapse proxy; live-codex confirm folded into B3 |
| MCP-3 | Do (a) / fold (b) | HatStore on_change; presence -> STATE-1 |
| NEW-MCP-1 | Do (after SRV-5) | save_upload helper + shared trigger loop |
| NEW-MCP-2 | Do (B4) | single serialize_message under golden fixtures |
| WRAP-1 | Done | ServerClient single HTTP contract |
| WRAP-2 | Do (B4) | tmux helpers -> unix; pure build_trigger_prompt |
| WRAP-3 | Do (B4) | lift monitor closures; with NEW-WRAP-1 |
| WRAP-4 | Done | supervisor.run_loop shared |
| WRAP-5 | Do (B4) | extract handle_heartbeat_409 |
| WRAP-6 | Accept | keep documented dup + drift test; decline shared-leaf (bootstrap constraint) |
| NEW-WRAP-1 | Do (B4) | thread single ServerClient; with WRAP-3 |
| FE-1 | Done | api.js + wsClient.js |
| FE-2 | Do (after FE-3) | leaf move once state is in Store |
| FE-3 | Do (B4) | keystone; unblocks FE-2 / FE-6 / chatjs Tier-B |
| FE-4 | Done | onmessage -> Hub.emit |
| FE-5 | Done | _messageRenderers registry |
| FE-6 | Do (after FE-3) | real defect; scheduled last, not deferred |
| NEW-FE-chatjs-split | Do Tier-A (B4) | Tier-A leaves now; Tier-B after FE-3 |

---
## How to read this

- **Source:** a per-subsystem architectural audit (2026-06-27), one pass per subsystem (app.py / state-layer / MCP / Python-wrapper / frontend), each claim re-verified against current source. Findings are architecture-level only — no style/typo notes. Line numbers are current as of this audit; stale ones from prior rounds were dropped.
- **Three fields per open item.** Every partial / open / verify-gated / deferred item lists, in order: **Approach (方案)** — the clean architectural direction; **Fix scope (修正範圍)** — exact files + site count + line estimate; **Completion criteria (達成條件)** — a verifiable check (a grep that must return 0, or a test that must pass). Done items carry a one-line confirmation plus the grep/test that proves them.
- **Priority:** P1 (structural blocker or correctness bug) · P2 (clear coupling / duplication / SRP win) · P3 (cleanup, low risk, low urgency). Note: MCP-2 and FE-6 are P1 by *value*, not urgency — they are a deletion and a strategic refactor, not misbehaving code. The genuinely-misbehaving P1s are NEW-SRV-1 and NEW-SRV-2.
- **Rust-rewrite relationship** (`rewrite/native-wrapper`) is a *reference note only*, never a reason to defer Python cleanup: the Python wrapper is the code in use on `main` today. The two tracks are parallel and non-conflicting.

---

## 1. Cross-cutting meta-patterns

The same architectural problem recurs across subsystems. These are the highest-value framing; individual backlog items are instances of them. State as of this audit is noted per pattern.

- **A — Missing contract layer.** *Largely resolved at the top level.* The server WS fan-out now routes through one `_broadcast` (SRV-1 done), the wrapper HTTP contract is one `ServerClient` (WRAP-1 done), and the frontend has `api.js` + `wsClient.js` (FE-1 done). **Residue:** MCP still re-specifies its own contracts — `chat_send` duplicates image-upload + @mention-trigger (NEW-MCP-1), the read wire-shape is serialized 3 ways (NEW-MCP-2), and three wrapper forwarders re-wrap the `ServerClient` contract a second time (NEW-WRAP-1).
- **B — God-module + module-global mutable state.** Still the dominant open theme. `app.py` (2166), `mcp_bridge.py` (763), `registry.py` (550), `chat.js` (4254). The app_state singleton landed structurally (SRV-2) but two readers were missed and now raise `NameError` (NEW-SRV-1/2); mcp_state extracted but `chat_set_hat` still `import app`s and the reaper pokes its privates (MCP-3 partial); registry still fuses naming-policy + view + auth (STATE-5 partial); the frontend god-module breakup is partial (FE-2/FE-3/NEW-FE-chatjs-split); two server thread/version leaves remain inline (SRV-7, SRV-8).
- **C — Single-source-of-truth fractures.** Session advance now decides under a lock against the live record (BUG-1 done). `activeChannel` is a single Store owner (FE-3, one key migrated). **Still fractured:** agent reachability has 3 owners (STATE-1 open); the frontend uses the DOM as the message model (FE-6 — decided: do, after FE-3); and the audit found three new SSOT smells — a local `state` shadowing the singleton (NEW-SRV-3), a re-instantiated `ServerClient` (NEW-WRAP-1), and a read that writes to disk (NEW-STATE-PERSIST-2).
- **D — Persistence decided per-store.** `atomic_io.write_json_atomic` exists (tmp+fsync+os.replace) and is adopted by 4 stores, but adoption is incomplete: ~9 store-save sites are still bare `write_text` or hand-rolled tmp+replace **without fsync**, and `store._rewrite` truncates the message log in place (NEW-STATE-PERSIST-1, broader than first logged); `jobs.add_message` re-serializes every other job's messages O(n) per append (STATE-4); and there is still no storage port (STATE-7 deferred).

---

## 2. Correctness — fix first (these actually misbehave)

Two of these are net-new this audit and are the most urgent items in the whole backlog: they are live `NameError`s introduced by the otherwise-correct SRV-2 migration, and neither is covered by a test.

### NEW-SRV-1 — `websocket_endpoint` reads removed module global `session_token` → `NameError` on every `/ws` connect (P1, open) · NEW this audit
**Decision (定案):** **Do now (Batch 0) — top priority.** 1-line fix (`state.session_token`) + a /ws-connect smoke test. Verified live regression.


`app.py:757` `if token != session_token:` sits inside the **module-level** `websocket_endpoint` (decorated `@app.websocket("/ws")` at 753 — not nested in `configure()`). The only `session_token` bindings are the attribute `state.session_token` (82, 130) and the `configure()` parameter (141, 144); there is no module-level `session_token`, so the line raises before `websocket.accept()`. The middleware twin at 130 was correctly repointed to `state.session_token`; this site was missed. Effect: every browser `/ws` connect fails → all live message/status/settings updates break.

- **Approach (方案):** change `app.py:757` to `if token != state.session_token:` (matches the middleware at 130).
- **Fix scope (修正範圍):** `app.py` — 1 line (757).
- **Completion criteria (達成條件):** `grep -n 'session_token' app.py` shows no bare reference outside `state.session_token` and the `configure()` parameter; a smoke test that opens `/ws` with the valid token stays connected (no 4003 close, no `NameError`).

### NEW-SRV-2 — `run.py` startup hook references undefined `session_engine` → `NameError` in the FastAPI startup event (P1, open) · NEW this audit
**Decision (定案):** **Do now (Batch 0).** 2-3 line fix (import state, `state.session_engine`) + a startup-hook smoke test. Verified live regression.


`run.py:113-114` `if session_engine: session_engine.resume_active_sessions()` inside `@app.on_event("startup")` (`on_startup`, 110, nested in `main()`). `session_engine` is never imported or defined — line 61 imports only `(app, configure, set_event_loop)`. The startup event raises `NameError`, so session-resume-on-boot fails (and may abort startup depending on uvicorn). The suite never boots the ASGI app, so it is uncovered.

- **Approach (方案):** add `from app_state import state` and change the hook to `if state.session_engine: state.session_engine.resume_active_sessions()`.
- **Fix scope (修正範圍):** `run.py` — 2-3 lines (113-114 + one import).
- **Completion criteria (達成條件):** `grep -n 'session_engine' run.py` shows only `state.session_engine`; invoking the startup hook (or a boot smoke test) does not raise `NameError` and `resume_active_sessions` runs.

### BUG-1 / STATE-2 — session advance race (P1, done)
**Decision (定案):** Done — closed (verified: locked compare-and-advance + stale-snapshot reject).


Confirmed done. `session_engine.py` `_advance` (277-294) runs under `with self._lock` (287), re-reads `live = self._store.get(...)` (288), bails if the live session is complete/interrupted (289) or if `current_phase`/`current_turn` drifted from the Timer snapshot (291-293), then mutates under the same lock via `_advance_locked`. Two timers off near-simultaneous messages can no longer both advance. Proof: the body executes under the lock and short-circuits on snapshot drift; `test_session_engine` green.

> The SRV-2 fixes (NEW-SRV-1, NEW-SRV-2) must each land **with** their first regression test — the absence of `/ws`-connect and boot tests is the root cause that let both ship.

---

## 3. Backlog by subsystem

### Server core — `app.py (2166)` / `run.py (159)` / `session_engine.py (470)` / `commands.py`

#### SRV-1 — single `_broadcast` fan-out (P1, done)
**Decision (定案):** Done — closed.

Confirmed done. The only `for ... in list(ws_clients)` loop is the dead-client sweep inside `_broadcast` (app.py:673), the only fan-out `send_text` is 675, and `ws_clients` is otherwise touched only at decl 40 / add 765 / discard 1046-1048. All other `send_text` calls (768-819) are per-connection initial-state pushes, not fan-outs. Proof: `grep -nE 'for .* in (list\()?ws_clients' app.py` → one hit (673).

#### SRV-2 — app_state singleton: structural core landed, migration incomplete (P1, partial)
**Decision (定案):** **Do now (Batch 0).** Close via the two NameError fixes (NEW-SRV-1/2) plus first /ws-connect and startup-hook smoke tests. The app_state rename was architecturally correct; the only gap is missing boot/connect test coverage — fix that, not the approach.

The State singleton exists (`app_state.py`; `app.py:31 from app_state import state`; handlers read `state.X`), but the prior **done** claim was false — two readers were missed and now ship `NameError`s (see §2: NEW-SRV-1 `app.py:757`, NEW-SRV-2 `run.py:113-114`). Residual, non-blocking: `mcp_bridge.py:645` lazy `import app` (MCP-3), and `version_check` rebinds a local `state` string (NEW-SRV-3).
- **Approach (方案):** repoint the two missed readers to the singleton (NEW-SRV-1, NEW-SRV-2); add `/ws`-connect and startup smoke tests so future global removals can't regress silently. Optionally collapse the last lazy `import app` and rename the `version_check` local.
- **Fix scope (修正範圍):** `app.py` 1 line (757) + `run.py` 2-3 lines (113-114 + import) for the blocker (2 files). Optional: `mcp_bridge.py:645` (1 site), `version_check` local rename (~5 lines).
- **Completion criteria (達成條件):** `grep -n 'session_token' app.py` shows no bare reference; `grep -n 'session_engine' run.py` shows only `state.session_engine`; a test that (a) opens `/ws` with the valid token and stays connected and (b) invokes the startup hook, both pass without `NameError`.

#### SRV-3 — slash-macro + session-draft extracted (P2, done)
**Decision (定案):** Done — closed.

Confirmed done. `commands.py` owns macro dispatch (`BROADCAST_COMMANDS`, `is_macro`, `expand` with the `/hatmaking` `/artchallenge` `/roastreview` `/poetry` templates); draft logic lives in `session_engine`. Proof: `grep -nE 'Hat making|Art challenge|roast review' app.py` → 0 (templates in commands.py:42-69); `grep -nE '_SESSION_DRAFT_RE|validate_session_template' app.py` → 0. Residual long-handler/`/continue`-dup is tracked separately (NEW-SRV-5).

#### SRV-4 — public `store.resolve_decision` / `jobs.resolve_message` (P2, done)
**Decision (定案):** Done — closed.

Confirmed done. Handlers are thin; atomicity lives in the store classes. Proof: `grep -nE '\.store\._lock|\.store\._messages|\.store\._rewrite|\.jobs\._save' app.py` → 0. The single residual store-private access (`session_store._templates` @1914) is a different store, scoped out to NEW-SRV-4.

#### SRV-5 — routing/rename helpers partial; divergent inline sites remain (P2, partial)
**Decision (定案):** **Do (Batch 4).** Genuine DRY/SRP win: one sync rename-finish helper (emitting via run_coroutine_threadsafe) collapses the 4 sync sites; one resolve+trigger helper unifies the 4 divergent loops incl. trigger_agent_silent. Precondition for NEW-MCP-1.

`_finish_agent_rename` (app.py:546-555, async) is used at 2 WS sites, but the same `migrate_identity` sequence is still inlined at 4 sync sites — reaper 292, `register_agent` 1659, `deregister_agent` 1702, `rename_agent_label` REST 1743. `_resolve_targets` (531-543) is used at 630 and 1517, but the trigger loops diverge: `_handle_new_message` @665, `trigger_agent_silent` bypasses `_resolve_targets` and calls `registry.resolve_to_instances` directly @1419 (no pending-skip), `post_job_message` @1526, `resolve_job_message` @1556. The sync sites can't call the async rename helper directly (`run_coroutine_threadsafe`), which is why they stayed inline.
- **Approach (方案):** add a sync rename-finish helper (or a registry-side `rename_and_migrate` emitting via `run_coroutine_threadsafe`) so the 4 sync sites collapse onto one path; extract one trigger-targets helper taking `(sender, text, channel[, job_id])` applying pending-skip + session-guard uniformly, repointing all 4 loops including `trigger_agent_silent`.
- **Fix scope (修正範圍):** `app.py` — 1 sync rename helper repointing 4 sites (292/1659/1702/1743) + 1 trigger-targets helper repointing 4 loops (665, 1419/1424, 1517/1526, 1556). ~8 sites, ~60-90 lines net reduction. `registry.py` optional.
- **Completion criteria (達成條件):** `grep -n 'migrate_identity(' app.py` appears only inside the rename helper(s) (≤2 hits, not the current 5); `trigger_agent_silent` uses `_resolve_targets` (no standalone `resolve_to_instances` loop at 1419); all 4 trigger loops share one helper body.

#### SRV-6 — `room_settings` / `agent_hats` folded into lock-guarded stores (P2, done)
**Decision (定案):** Done — closed.

Confirmed done. `settings_store.py` `SettingsStore`/`HatStore` own their dict + validation + atomic persist behind an `RLock`; the lock-free module dicts are gone. Proof: `grep -nE 'room_settings|agent_hats' app.py` → 0.

#### SRV-7 — `configure()` inline monitor/schedule closures + unconditional FS migration (P3, open)
**Decision (定案):** **Do (Batch 4, paired with STATE-1's presence work).** Extract presence_monitor.py / schedule_runner.py — the inline closures are currently un-unit-testable; gate the FS migration behind a flag.

`configure()` still inlines `_background_checks` (app.py:237; presence expiry / crash-timeout deregister / leave-message debounce / status broadcast), started as a daemon thread at 365, and `_schedule_runner` (368), started at 400; plus unconditional FS migrations (log rename 149-153, decisions→rules 162-164, activities→jobs ~172). No `presence_monitor.py` / `schedule_runner.py` exist. The logic is untestable without booting the app and closes over `_known_online` / `_posted_leave` / `_known_active`.
- **Approach (方案):** extract the two thread bodies into `presence_monitor.py` / `schedule_runner.py` taking explicit deps (registry, store, mcp_state, event-loop poster); move FS migrations into a one-shot `migrate()` gated behind a flag; `configure()` just wires + starts.
- **Fix scope (修正範圍):** 2 new files (~130 + ~35 lines moved out of app.py) + a `migrate()` helper; `configure()` shrinks ~160 lines; 2 thread-start sites repointed.
- **Completion criteria (達成條件):** `presence_monitor.py` and `schedule_runner.py` exist with unit tests exercising crash-timeout / leave-debounce and run-due without booting FastAPI; `grep -nE 'def _background_checks|def _schedule_runner' app.py` → 0.

#### SRV-8 — self-contained leaves (version-check, `_auto_cast`) still inline (P3, open)
**Decision (定案):** **Do (Batch 4).** Low-risk leaf extraction (version_check.py; _auto_cast -> session_engine). The hats sub-item is already satisfied by SRV-6 and is dropped.

The hats-persistence sub-item is **already satisfied by SRV-6** (HatStore owns `hats.json`) and is dropped from this item. Still inline: the GitHub version-check block — `_detect_install_kind` (2063), `_fetch_latest_release` (2082), `_compare_versions` (2109), `version_check` route (2125-2155), ~105 lines of network/subprocess/packaging logic with no ties to chat state; and `_auto_cast` (2031, a pure role→agent assignment) called once at app.py:1926. No `version_check.py` exists. `set_agent_hat`/`clear_agent_hat` legitimately stay (need the event loop for broadcast).
- **Approach (方案):** lift version-check into `version_check.py` (pure functions + thin route shim); move `_auto_cast` into `session_engine` (pure, testable).
- **Fix scope (修正範圍):** 1 new `version_check.py` (~105 lines moved); `_auto_cast` → `session_engine.py` (~15 lines, repoint the call at app.py:1926). 2 files, ~120 lines.
- **Completion criteria (達成條件):** `grep -nE '_fetch_latest_release|_compare_versions|_detect_install_kind' app.py` → 0; `grep -n 'def _auto_cast' app.py` → 0; both new homes carry direct unit tests.

#### NEW-SRV-1 / NEW-SRV-2 — see §2 (P1, open, NEW this audit).
**Decision (定案):** **Do now (Batch 0).** Full decision + detail in §2.


#### NEW-SRV-3 — `version_check` local `state` shadows the singleton (P3, open) · NEW this audit
**Decision (定案):** **Do (Batch 0, with the SRV-2 cleanup).** Trivial rename to `release_state`; removes a latent UnboundLocalError and an SSOT-name collision in the very file carrying the P1s.

`app.py:2140-2148` assigns a local `state = 'update_available' | 'upstream_update' | 'unknown' | 'current'`, returned as the JSON `state` key (2153). Because `state` is assigned in the body, Python treats it as local throughout `version_check`, shadowing the module-level `from app_state import state` singleton. No current runtime bug (the function never reads `state.X`), but it is a latent `UnboundLocalError` footgun and collides with the central SSOT singleton name used everywhere else.
- **Approach (方案):** rename the local to `release_state` (or `status`) and use it in the returned dict.
- **Fix scope (修正範圍):** `app.py` — ~6 lines in `version_check` (2138-2154).
- **Completion criteria (達成條件):** within `version_check` (app.py:2125-2155), `grep -nE '^\s+state ='` → 0 — the result var is renamed and the only `state` token left is the literal JSON key string; the module `state` singleton is unshadowed in this scope.

#### NEW-SRV-4 — `start_session` pokes `session_store._templates` directly (P3, open) · NEW this audit
**Decision (定案):** **Do (Batch 4).** Add a public `SessionStore.register_transient_template`; closes the last store-private poke from app.py.

`app.py:1914` `state.session_store._templates[template_id] = tmpl` in `/api/sessions/start` — the only remaining store-private poke after SRV-4. `session_store.py` exposes `save_custom_template` (87, persisted) but no public method for a transient in-memory register; private `_templates` writes live only inside `session_store.py` (42/76/101).
- **Approach (方案):** add a public `SessionStore.register_transient_template(tmpl)` (in-memory, not persisted) and call it from the handler.
- **Fix scope (修正範圍):** `session_store.py` ~3-line method; `app.py:1914` repointed. 2 files, 1 site.
- **Completion criteria (達成條件):** `grep -n '\.session_store\._templates' app.py` → 0; the start-from-draft path uses a public method; no `SessionStore` private attribute is accessed from app.py.

#### NEW-SRV-5 — `/continue` handled in two places; WS path ignores the channel (P3, open) · NEW this audit
**Decision (定案):** **Do — fix the channel-arg now** (a real correctness defect: `/continue` unpauses `general` regardless of channel), **collapse the duplicate path in Batch 4.**

`/continue` is handled twice with different behavior: `websocket_endpoint` (app.py:847) calls `continue_routing()` with **no** channel argument (defaults to `general`) while posting the resume notice in the actual `channel` (848) — so `/continue` typed in a non-general channel unpauses `general` but announces resume in the typed channel. The message-callback path `_handle_new_message` (app.py:608) calls `continue_routing(channel)` correctly. Duplicated control-command logic plus a real channel-mismatch defect.
- **Approach (方案):** route the WS `/continue` through the same path as the message callback (or pass `continue_routing(channel)`), collapsing the two branches into one channel-aware path.
- **Fix scope (修正範圍):** `app.py` — 1-3 lines at 846-850 (pass channel), or fold into `_handle_new_message`. 1 file.
- **Completion criteria (達成條件):** `/continue` typed in channel X calls `continue_routing(X)` (`continue_routing` always receives a channel arg) and a single `/continue` code path exists; a test that pauses `#dev` then `/continue` in `#dev` resumes `#dev` (not `#general`).

### State & persistence — `router / session_engine / session_store / store / registry / jobs / mcp_state`

#### STATE-1 — presence/identity/router are 3 owners of "is this agent reachable" (P1, open)
**Decision (定案):** **Do (Batch 1) — the highest-value open P1.** Extract `presence_service.py` exposing one `reachable() = active and present`; registry becomes identity-only; the reaper subscribes instead of holding the lock. Absorbs MCP-3(b). Preserve the intentional queue-on-offline behaviour for an explicit offline @mention.

Confirmed open and never started. `grep -cE 'mcp_state\._' app.py` = **24** (verified: `_presence_lock`×8, `_presence`×5, `_activity`×6, `_activity_ts`×1, `_renamed_from`×4). No presence-service module exists. Three open-coded reachability owners: `registry.get_active_names()` = claimed/identity (registry.py:401-403); `mcp_state.is_online()` = present/heartbeat (mcp_state.py:190-193); router `online_checker` open-codes active∧present inline (app.py:200-202). The reaper (app.py:262-361) holds `mcp_state._presence_lock` directly. Note on the divergence: the send path **does** skip pending at app.py:657, so for registered instances its gate is effectively active-and-present like `@all`; the real fork is at app.py:662 — an offline-but-claimed explicit `@mention` is **not** dropped (posts "offline — queued" and still attempts trigger), whereas `@all` silently excludes it. That queue-on-offline behavior is partly intentional and must be preserved.
- **Approach (方案):** extract a `PresenceService` owning presence/activity/cursor state (wrapping the current `mcp_state` globals) exposing ONE `reachable(name)=active∧present` query plus `subscribe()`. Registry stays identity-only. `@all`'s `online_checker` and the send-gate offline branch (app.py:662) both call `reachable()`; the send-gate keeps its own "attempt-anyway + queue" policy on top of the shared predicate. The reaper subscribes to presence-expiry events instead of holding the lock.
- **Fix scope (修正範圍):** new `presence_service.py` (~80-120 lines, absorbs mcp_state presence/activity/renamed_from); repoint the 24 private pokes in app.py (reaper 262-361 + heartbeat handlers 1654/1764/1801) + the router lambda (200-202) + send-gate (662); wiring in run.py:71-74. ~3-4 files. Medium. (Folds in MCP-3's presence facet.)
- **Completion criteria (達成條件):** `grep -nE 'mcp_state\._(presence|activity|renamed_from)' app.py` → 0 (no app.py code holds the presence lock); exactly ONE `reachable(name)` definition exists; `@all`'s `online_checker` and the send-gate offline branch each call it (one call site each, no open-coded `get_active_names()`+`is_online()` combo left); `test_mcp_state` and `test_router` green.

#### STATE-3 — `_enrich` writes derived fields onto a copy (P2, done)
**Decision (定案):** Done — closed.

Confirmed done. `session_engine.py:455 enriched = dict(session)` is the first statement of `_enrich`; `total_phases`/`phase_name`/`current_role`/`current_agent` are written only onto `enriched` (459-469). Proof: `grep -nE 'total_phases|phase_name|current_role|current_agent' session_store.py` → 0; `test_session_engine` green.

#### STATE-4 — atomic-JSON helper only partially adopted; O(n) per-message rewrite untouched (P2, partial)
**Decision (定案):** **Split decision. Do (a):** route `registry._save_renames` through the atomic helper (Batch 2, shares NEW-STATE-PERSIST-1's fix). **Accept (b):** the O(n) per-append jobs rewrite — jobs are bounded, and splitting to a per-job append-log mid-refactor introduces a divergent storage model for marginal gain. Record the message-count bound + rationale and close (b).

`write_json_atomic` (atomic_io.py:15-42) is adopted by `session_store.py:62`, `jobs.py:37`, `settings_store.py:80/259`. But `registry._save_renames` (registry.py:80-90) still hand-rolls `tmp.write_text` + `tmp.replace` **without fsync**, bypassing the helper. The O(n) half is fully untouched: `jobs._save` (36-37) writes the **entire** jobs blob (all jobs + all nested messages) and `add_message` fires it on every append (243), as do resolve/delete/update — each message append re-serializes every other job's messages.
- **Approach (方案):** (a) route registry rename-saves (and the rest, see NEW-STATE-PERSIST-1) through `write_json_atomic`. (b) O(n): either append-log job messages per-job (like `MessageStore` JSONL) so `add_message` stops rewriting unrelated jobs, **or** formally accept the cost (jobs are bounded) and close the sub-item with a written rationale + a message-count bound.
- **Fix scope (修正範圍):** (a) `registry.py:80-90` swap to `write_json_atomic` (1 site; overlaps NEW-STATE-PERSIST-1). (b) `jobs.py` message model: medium if split to per-job append-log (`add_message` + `_load` + `get_messages`, ~1 file), trivial if accepted-and-documented.
- **Completion criteria (達成條件):** `registry._save_renames` routes through an atomic helper WITH fsync (no hand-rolled `tmp.write_text` remains); AND either `jobs.add_message` no longer serializes other jobs' messages (a kill-during-add on job A leaves job B byte-identical in the persisted blob) OR the O(n) sub-item is explicitly closed with a written rationale bounding job-message count; `test_atomic_io` green.

#### STATE-5 — registry naming leaves extracted; view + auth + 4× policy orchestration remain (P2, partial)
**Decision (定案):** **Do the SRP wins (Batch 4):** a `NamingPolicy` composer (kills the 4x inline label/slot/colour dup) and move `get_agent_config` (a WS projection) to a view layer. **Accept** `resolve_token` staying in registry (token lookup is storage-adjacent) and **keep** `_inst_dict` (the registry's own canonical serializer) — extracting either is churn without a real boundary win.

Only part 1 landed: `naming.py` holds the pure leaves (`parse_name`/`next_free_slot`/`family_conflict`/`derive_color`), imported at registry.py:17 and unit-tested. **Not done:** (2) view/wire-shape helpers — `get_agent_config` (registry.py:389-395, a WS projection) and `_inst_dict` (540-550); (3) `resolve_token` auth resolver (504-510); (4) the label/slot/color **orchestration** is still inlined and duplicated across `register` (127/135/140-142), `deregister` (183-184), `claim` (271-275), `rename` (343-355). (The prior finding's grep count was wrong: the call-form `grep -nE '\.capitalize\(\)|derive_color\(' registry.py` = **12** inline sites + the bare import at 17, not 10.)
- **Approach (方案):** two-layer split — (a) `NamingPolicy.apply(base_cfg, slot, custom_label)` composing the leaves into `(name, label, color, slot)`, called from register/claim/rename/deregister to kill the 4× dup; (b) move `get_agent_config` (the WS projection) to a view/serializer layer. `resolve_token` stays in registry (storage-adjacent token lookup; decided — see Decision). `_inst_dict` relocation is debatable (it is the registry's own canonical Instance→dict serializer used by ~12 internal methods) — weigh before extracting.
- **Fix scope (修正範圍):** `registry.py` (550 lines): add a `NamingPolicy` composer, replace the 4 inlined blocks with one call each (~40 lines deduped); move `get_agent_config` to a view module. Public method surface unchanged. Medium, internal.
- **Completion criteria (達成條件):** `grep -nE '\.capitalize\(\)|derive_color\(' registry.py` → 0 (all 12 inline call-sites delegated; the bare `from naming import` may stay); register/claim/rename/deregister each derive identity via ONE `NamingPolicy` call; `get_agent_config` lives outside `RuntimeRegistry`; tests green.

#### STATE-6 — disambiguate the two `paused` notions + collapse duplicate rewrite bodies (P3, done)
**Decision (定案):** Done — closed.

Confirmed done. The status payload exposes `routing_paused` (app.py:687, 1172), distinct from the session human-interrupt `state=="paused"`. The router's internal `_channels[ch]["paused"]` is a private key never surfaced. Proof: `grep -rn '_rewrite_jsonl' *.py` → 0; `store.py` has a single `_rewrite` (109-115).

#### STATE-7 — no storage port (P3, deferred)
**Decision (定案):** **Defer by decision — NOT pending owner.** A storage port with a single JSON/local-disk implementation is a speculative abstraction (YAGNI / rule-of-three): zero present consumer, real indirection cost across 7 stores. The shared `write_json_atomic` helper already covers durability. **Reactivation trigger:** a concrete backend change is actually scheduled (sqlite / remote / multi-process). Until then, do not build it.

Confirmed still the weakest seam. Every store hand-rolls `_load`/`_save` inline (store.py 27/109, session_store.py 49/61, jobs.py 22/36, schedules.py 97/107, summaries.py 20/30, rules.py 27/63, settings_store.py 63/78). `atomic_io.write_json_atomic` is a shared WRITE helper, not a port — no load/backend abstraction exists.
- **Approach (方案):** define a `StoragePort` (load + atomic save) and back the JSON-list/dict stores plus a JSONL backend via an injected port. Defer until a concrete backend change (sqlite/remote) is actually wanted — large, low present value.
- **Fix scope (修正範圍):** new port module + re-back ~7 stores via constructor injection. High. Deferred by decision (see Decision) — not pending owner.
- **Completion criteria (達成條件):** one `StoragePort` interface (load + atomic save); each store constructed with an injected backend; switching to an alternate backend touches 0 domain classes (proven by an in-memory-backend swap test exercising all stores); tests green. Pursue only on the reactivation trigger above.

#### NEW-STATE-PERSIST-1 — atomic-write adoption incomplete; `store._rewrite` truncates in place (P2, open) · NEW this audit
**Decision (定案):** **Do (Batch 2).** Durability correctness, low cost: route all ~9 save sites through `write_json_atomic` and add `write_jsonl_atomic` for `store._rewrite`. Removes a real crash-corruption class.

Broader than first logged. Bare `self._path.write_text(json.dumps(...))` (truncate-then-write; a crash mid-write leaves a partial/empty file): `rules.py:68`, `schedules.py:108`, `summaries.py:31` — **plus two missed before:** `store.py:306` (`_save_todos`, written on every todo add/complete/remove) and `session_store.py:100/119` (custom-templates save/delete). `store._rewrite` (store.py:109-115) opens the message log in `"w"` mode (truncate) + fsync but **no `os.replace`**, so a crash during `_rewrite` (fired by delete/resolve/update/clear/rename/etc.) can corrupt the entire message JSONL. `registry._save_renames` (87) and `mcp_state` cursors/roles (mcp_state.py:69/93) do tmp+replace **without fsync**, hand-rolled rather than via the shared helper.
- **Approach (方案):** consolidate every store save on the shared helper — route rules/schedules/summaries/`_save_todos`/custom-templates/registry-renames/mcp_state saves through `write_json_atomic`; add a JSONL variant (`write_jsonl_atomic`: tmp+fsync+os.replace) for `store._rewrite`. One durability strategy, one helper.
- **Fix scope (修正範圍):** `rules.py:68`, `schedules.py:108`, `summaries.py:31`, `store.py:306`, `session_store.py:100+119`, `registry.py:87`, `mcp_state.py:69+93` → `write_json_atomic` (~9 sites across 7 files); `store.py:109-115` → new `write_jsonl_atomic` in `atomic_io.py` (1 helper + 1 call site). Low.
- **Completion criteria (達成條件):** every store save routes through an atomic helper (tmp+fsync+os.replace) — grepping for `\.write_text(` and `open(.*['"]w['"]` across store.py, rules.py, schedules.py, summaries.py, session_store.py, registry.py, mcp_state.py (excluding the atomic helpers and intentional `write_text("")` wipes) returns 0 non-atomic matches; `write_jsonl_atomic` added for the message log; a kill-during-save test on each store leaves the prior file intact; `test_atomic_io` green.

#### NEW-STATE-PERSIST-2 — `JobStore.list_all` is a read that writes to disk (P3, open) · NEW this audit
**Decision (定案):** **Do (Batch 2).** Trivial: make `list_all` a pure read; move the sort-order backfill to load/write paths.

`jobs.list_all` (jobs.py:87-99) calls `_ensure_sort_orders_locked()` and, if it mutated anything, `self._save()` (91-93) — a GET that persists the whole jobs blob. The same backfill already runs at load (31-32), so the read-path copy is defensive but makes an ostensibly pure read have a write side effect (SRP/contract smell, surprising under concurrent reads, and compounds STATE-4's O(n) rewrite).
- **Approach (方案):** run the sort-order backfill once at `_load` (and inside the write paths that can introduce a 0 order); make `list_all` a pure read returning copies. If a defensive in-memory backfill is kept, do it without persisting.
- **Fix scope (修正範圍):** `jobs.py:87-99` — drop the `_save` (and optionally the re-run of `_ensure_sort_orders_locked`) from `list_all`. 1 file, 1 site. Trivial.
- **Completion criteria (達成條件):** `list_all` performs no disk write (no `_save` call in its body); a test that calls `list_all` does not change the jobs file mtime/content; sort orders remain correct after create/update_status/reorder (verify each write path assigns `sort_order`, including any archive-import path that bypasses `create()`); tests green.

### MCP — `mcp_bridge.py (763)` / `mcp_state.py (213)` / `mcp_proxy.py (272)` / `mcp_inject.py`

#### MCP-1 — drop vestigial proxy sender-stamping (P1, done)
**Decision (定案):** Done — closed.

Confirmed done. Identity is token-derived server-side (`_extract_agent_token` → `_authenticated_instance` → `_resolve_tool_identity` returns `inst['name']` and ignores any client-supplied sender). The proxy never parses/rewrites the body: `mcp_proxy.do_POST` (136-170) reads raw bytes, forwards them unchanged, and only adds `Authorization` + `X-Agent-Token` headers. Proof: `grep -rn '_maybe_inject_sender|_SENDER_PARAMS'` → 0.

#### MCP-2 — delete `mcp_proxy.py`, fold codex into direct bearer inject (P1, open — verify-gated)
**Decision (定案):** **Do (Batch 3) — converge the gate, do not leave it open-ended.** Collapse to direct bearer-env inject and delete `mcp_proxy.py` (~320 lines net). Clean SSOT: codex is the lone exception forcing the entire proxy while every other agent direct-injects Bearer (which the server already authenticates). Sequence: implement the bearer-env path + unit-assert the `-c` flags -> ONE live codex session confirms end-to-end -> delete. The live check is the final step inside Batch 3 (folded into the end-of-round live test), not an indefinite block.

Structurally verified. The proxy is codex-only (+ unconfigured-custom fallback): `_BUILTIN_DEFAULTS['codex']['mcp_inject']='proxy_flag'` (mcp_inject.py:128) is the only built-in using `proxy_flag`; every other agent direct-injects `Authorization: Bearer`. `wrapper.py:320 needs_proxy = inject_mode in ('proxy_flag','')`. Deletion surface confirmed live (wrapper.py import 244, `_start_identity_proxy` 239-263, needs_proxy block 308-324, proxy mutation 354-356, stop 560-561; mcp_proxy.py whole file; build_release.py:23; mcp_inject.py proxy_flag branch 276-281 + `proxy_url` threading). Note: this is a single-source-of-truth simplification (delete working code), not a correctness bug — P1 reflects value, not urgency.
- **Approach (方案):** add a bearer-env branch in `_apply_mcp_inject` emitting `launch_args ['-c','mcp_servers.agentchattr.url="<url>"','-c','mcp_servers.agentchattr.bearer_token_env_var="AGENTCHATTR_TOKEN"']` and `inject_env['AGENTCHATTR_TOKEN']=token` (token stays out of argv). Replace the "no mcp_inject = proxy fallback" niche with the same direct path, then delete `mcp_proxy.py` and all proxy threading.
- **Fix scope (修正範圍):** `mcp_inject.py` rewrite `_BUILTIN_DEFAULTS['codex']` (127-132) + bearer-env branch (~20 lines), remove proxy_flag branch (276-281) + `proxy_url` params; `wrapper.py` delete import 244 / `_start_identity_proxy` 239-263 / needs_proxy block 308-324 / proxy refs 354-356, 560-561; `mcp_proxy.py` delete (272 lines); `build_release.py:23` drop entry; README proxy row; `tests/test_wrapper_mcp_config.py` assert codex inject emits bearer-env `-c` flags + token in `inject_env`. ~5 files, ~320 lines net deletion.
- **Completion criteria (達成條件):** `grep -rn 'McpIdentityProxy|mcp_proxy|_start_identity_proxy|needs_proxy|proxy_url' *.py` → 0 AND `_BUILTIN_DEFAULTS['codex']['mcp_inject'] != 'proxy_flag'` AND a unit test asserts codex `launch_args` contain `mcp_servers.agentchattr.bearer_token_env_var` and `inject_env` carries the token AND **one live codex session against a running server posts a `chat_send` the server authenticates by token (end-to-end)**. The live-codex step is the gate — asserted from codex CLI docs but not re-run in this pass; mechanically low-risk since the server already authenticates Bearer tokens from every other direct-inject agent.

#### MCP-3 — extract runtime-state god-module out of mcp_bridge (P2, partial)
**Decision (定案):** **Do (a) (Batch 3):** give `HatStore` an `on_change` callback so `chat_set_hat` drops its `import app` — removes the last MCP->app reach-back. **Fold (b)** (presence private-poke removal) into STATE-1 — it is the same work.

Done half: `mcp_state.py` (213 lines) owns presence/activity/cursors/roles/last-read + persistence + migration; `grep 'mcp_bridge\._(presence|activity|cursors|roles|renamed_from)'` → 0. **Not done:** (1) `chat_set_hat` (mcp_bridge.py:645-646) still does `import app; app.set_agent_hat(...)` — the only MCP tool reaching back into app; `HatStore` has no `on_change` so the lazy import is forced. (2) the app.py reaper (264-350) + handlers (1654-1655, 1764-1772, 1801-1802) acquire `mcp_state._presence_lock` and mutate its private dicts. (3, missed before) `mcp_bridge.py` itself writes `mcp_state._presence[...]=time.time()` inline at 255, 322, 358 instead of calling `_touch_presence` — the MCP module pokes its own state module's privates.
- **Approach (方案):** (a) give `HatStore` an `on_change` callback registered in `app.configure` (mirroring the rules/jobs/registry pattern); `chat_set_hat` then calls `state.hats.set(...)` and the callback broadcasts, removing `import app`. (b) promote presence/activity to a small service API on `mcp_state` (`expire_stale()`, `snapshot_online()`, `pop_renamed(name)`, route ALL writes through `_touch_presence`/`set_active`) so neither app.py's reaper nor mcp_bridge poke the private dicts — **(b) is the MCP-visible facet of STATE-1; fold (b) into STATE-1, keep (a) under MCP-3.**
- **Fix scope (修正範圍):** (a) `settings_store.py` HatStore +~8 lines + `app.configure` +1 register line + `mcp_bridge.py` `chat_set_hat` (645-646 → `state.hats.set` + drop import); ~3 files ~12 lines. (b) `mcp_state.py` +~25 lines + app.py reaper repoint (~8 sites) + mcp_bridge.py 3 inline presence writes (255/322/358); overlaps STATE-1.
- **Completion criteria (達成條件):** `grep -n 'import app' mcp_bridge.py` → 0 (chat_set_hat routed via HatStore `on_change`) AND `grep -rn 'mcp_state\._presence\b|_activity\b|_activity_ts\b|_renamed_from|_presence_lock'` across BOTH app.py AND mcp_bridge.py → 0 (all routed through mcp_state methods incl. new `expire_stale`/`snapshot_online`/`pop_renamed`) AND `test_mcp_state` green.

#### NEW-MCP-1 — `chat_send` god-function: duplicated image-upload + duplicated @mention-trigger loop (P2, open) · NEW this audit
**Decision (定案):** **Do, sequenced after SRV-5 (Batch 3/4).** Extract one `save_upload` + a single `ALLOWED_UPLOAD_EXTS`; route the job @mention branch through SRV-5's shared resolve+trigger helper. Cuts `chat_send` from a 160-line god-function.

`chat_send` (mcp_bridge.py:165-323, ~160 lines) mixes identity resolve, fallback routing, gating, job-scoped send (226-281), channel-scoped send (283-323). Two near-identical image blocks: job (235-249) and channel (284-303) — same suffix check + upload_dir resolve + mkdir + `shutil.copy2` + attachment dict (`shutil.copy2` appears 2×: 248, 302). The extension allowlist literal is hardcoded 3× (mcp_bridge.py 240/291, app.py:1054). The upload_dir resolver appears 6× repo-wide (mcp_bridge.py 242/295/366, app.py 157/1060/2160). The job-branch @mention loop (258-278) is an uncounted 4th copy of the trigger loop and re-implements resolution inline instead of calling `_resolve_targets`.
- **Approach (方案):** extract one `save_upload(image_path)->(attachment|error)` helper with a single `ALLOWED_UPLOAD_EXTS` constant shared by both `chat_send` branches and the app.py HTTP upload endpoint; move `_resolve_targets` into a shared module (or have mcp_bridge call it) and route `chat_send`'s job @mention block through SRV-5's resolve+trigger helper. `chat_send` then reduces to resolve-identity → dispatch(job|channel).
- **Fix scope (修正範圍):** `mcp_bridge.py` collapse 235-249 + 284-303 into one helper call, route 258-278 through the shared helper (~50 lines removed); `app.py` repoint the upload handler (1054-1073) and ideally the other upload_dir resolvers (157, 1060, 2160). 1 new helper, ~3 files. **Sequence after SRV-5 lands.**
- **Completion criteria (達成條件):** `grep -c 'shutil.copy2' mcp_bridge.py` → 0 (moved to helper) AND the allowed-ext literal appears once repo-wide AND `chat_send`'s job branch contains no inline `router.get_targets`+`trigger_sync` loop (calls the shared helper) AND upload + routing tests pass.

#### NEW-MCP-2 — MCP read contract serialized in 3 divergent inline shapes (P3, open) · NEW this audit
**Decision (定案):** **Do (Batch 4).** One `serialize_message(m, *, job_id=None)` under golden-fixture tests; preserve each variant's current field set (do not normalise the job branch's conditional `type`).

`chat_read` serializes message→MCP JSON two ways: `_serialize_messages` (mcp_bridge.py:381-398) for channel/recent/resync vs an inline per-message dict-builder for job reads (453-462). Shapes diverge: channel entries carry `channel` (391) and always `type` (390); job entries carry `job_id` (455), omit `channel`, and emit `type` only conditionally (458-459). The job-header dict (439-452) is a 3rd inline shape. `grep '"sender": m\["sender"\]' mcp_bridge.py` → 2 (387, 454).
- **Approach (方案):** one `serialize_message(m, *, job_id=None)` covering channel/job variants (job_id present → add `job_id`, drop `channel`; preserve each variant's current field set incl. the conditional `type`); `chat_read` (both paths), `chat_resync`, and the job-read loop all call it. Keep the job-header builder explicit, documented as the single job-header shape.
- **Fix scope (修正範圍):** `mcp_bridge.py` only, ~25 lines consolidated (381-398 + 453-462). Behavior-preserving.
- **Completion criteria (達成條件):** a single `serialize_message` exists; `grep -n '"sender": m\["sender"\]' mcp_bridge.py` → 1 (currently 2); a golden-fixture test asserts channel-read output is byte-identical to a recorded fixture AND job-read output matches its own recorded fixture (do not silently normalize the job branch's conditional `type` into the channel branch's unconditional form).

### Python wrapper — `wrapper.py (567)` / `wrapper_windows.py` / `wrapper_unix.py` / `wrapper_api.py` / `server_client.py` / `identity.py` / `supervisor.py` / `config_loader.py`

#### WRAP-1 — server HTTP contract unified into `server_client.ServerClient` (P1, done)
**Decision (定案):** Done — closed.

Confirmed done. `ServerClient` (server_client.py:30) owns the wire contract; `_auth_headers` is defined once (server_client.py:23). Both wrappers consume it via `client.*`. Proof: `grep '_auth_headers' wrapper*.py` → 0; `grep 'urllib.request' wrapper.py wrapper_api.py` → only `call_model` (wrapper_api.py:202-203, the OpenAI-compatible model endpoint, correctly inline); `grep 'import wrapper' wrapper_api.py` → 0; `test_server_client` present.

#### WRAP-2 — lift mcp_inject + move tmux helpers + split prompt/poll (P1, partial)
**Decision (定案):** **Do (Batch 4).** Relocate the tmux helpers to wrapper_unix.py (their only consumer); extract a pure `build_trigger_prompt` out of `_queue_watcher` so prompt logic is testable without file I/O. Low risk.

1 of 3 sub-tasks done. **Done:** `mcp_inject.py` extracted and consumed (wrapper.py:36-42). **Not done (a):** `_build_tmux_session_name` / `_safe_tmux_component` (defs wrapper.py:45/50, uses 67/68/520) remain in platform-agnostic wrapper.py and feed only the non-win32 branch — 0 hits in wrapper_unix.py. **Not done (b):** `_queue_watcher` (wrapper.py:108-206) interleaves queue-file polling (115-159) with prompt construction (161-202: role fetch, rules-epoch injection, identity hint).
- **Approach (方案):** relocate the tmux session-name helpers into `wrapper_unix.py` (their only consumer is the tmux path); factor prompt assembly out of `_queue_watcher` into a pure `build_trigger_prompt(identity, role, rules_data, job_id, channel, ...)` the poll loop calls, making prompt logic unit-testable without file I/O.
- **Fix scope (修正範圍):** `wrapper.py` move ~25 lines (45-69) to `wrapper_unix.py`; extract ~40-line prompt builder from `_queue_watcher` (161-202) into a pure helper. 2 files, ~65 lines moved, low risk.
- **Completion criteria (達成條件):** `grep '_build_tmux_session_name|_safe_tmux_component' wrapper.py` → 0 (defs+uses live in wrapper_unix.py); `_queue_watcher` makes no role/rules/hint calls (prompt produced by a separate pure fn with its own unit test asserting the job_id / custom_prompt / channel / ROLE / RULES / hint branches); existing wrapper tests green.

#### WRAP-3 — decompose `main()`; monitor closures still inline (P2, partial)
**Decision (定案):** **Do (Batch 4, with NEW-WRAP-1).** Lift the 3 monitor closures to module scope and dedup the thread-kwargs; `main()` reduces to wiring.

`main()` spans wrapper.py:266-563 (~298 lines). Already extracted: argparse (`_parse_wrapper_args` 213), proxy startup (`_start_identity_proxy` 239), `identity.py`. Still inline as nested closures: `_heartbeat` (410-433), `start_watcher` (443-454), `_watcher_monitor` (456-471), `_set_activity_checker` (477-479), `_activity_monitor` (481-507). The thread-construction kwargs block is duplicated verbatim between `start_watcher` (446-453) and `_watcher_monitor` (461-468).
- **Approach (方案):** lift the three monitor threads to module scope (or a small `monitors.py`) taking `(client, identity, data_dir, flags, server_port)`; reduce `main()` to wiring steps; collapse the duplicated thread-kwargs into one builder.
- **Fix scope (修正範圍):** `wrapper.py` — ~120 lines (3 closures + `start_watcher`) moved to module level; dedup the thread-kwargs. 1 file.
- **Completion criteria (達成條件):** `_heartbeat`/`_watcher_monitor`/`_activity_monitor` are defined at module scope (def at column 0); the queue-watcher thread-kwargs literal appears exactly once; `main()` body materially shorter (≤~120 lines); existing wrapper tests green.

#### WRAP-4 — shared restart loop via `supervisor.run_loop` (P2, done)
**Decision (定案):** Done — closed.

Confirmed done. `supervisor.run_loop` (supervisor.py:16) is the only `while True` restart skeleton; both platform files delegate (wrapper_windows.py:480, wrapper_unix.py:174). Proof: `grep 'supervisor.run_loop'` → exactly those two sites; `test_supervisor` present. The inject-delay scaler `max(delay, len(text)*0.001)` is platform-native pacing (co-located with each inject primitive), not the restart dup the item targeted.

#### WRAP-5 — share ServerClient + identity.py; 409 re-register still duplicated (P2, partial)
**Decision (定案):** **Do (Batch 4).** Extract `identity.handle_heartbeat_409(...)`; per-wrapper recovery side effects stay in the callback. Small DRY + first test of the 409 path.

Shared infra landed (`Identity` + `ServerClient` consumed by wrapper_api.py). **Not done:** the heartbeat-409 re-register skeleton is still duplicated — wrapper.py:419-426 (409 → `client.register` → `set_runtime_identity` → `_notify_recovery`) vs wrapper_api.py:146-153 (409 → `client.register` → `set_identity` → print). Only the post-recovery side effect differs. `grep '.code == 409'` → exactly those two sites; `identity.py` has no recovery helper; no test covers the 409 sequence.
- **Approach (方案):** extract `identity.handle_heartbeat_409(client, agent, label, on_recover)` (or a small heartbeat-loop helper) parameterized by the per-wrapper recovery callback; the differing side effects (proxy repoint/notify vs print) stay in the callback.
- **Fix scope (修正範圍):** `identity.py` +~15 lines (helper); `wrapper.py` and `wrapper_api.py` each −~8 lines at the 409 branch. 3 files, 2 call sites.
- **Completion criteria (達成條件):** the catch→register→set_identity sequence appears exactly once (in the helper); `grep '409'` in BOTH wrapper.py and wrapper_api.py → 0 (the literal lives only in identity.py); a unit test exercises the helper's 409 path (asserts register is called and the recovery callback fires); `test_identity` still green.

#### WRAP-6 — `resolve_path` / `AGENTCHATTR_*` key set still duplicated cross-file (P3, partial)
**Decision (定案):** **Accept the surface option; decline the architectural one.** Keep the ~6-line documented dup in `_load.py` and add a drift-guard equivalence test. The shared-importable-leaf option fights a real bootstrap-ordering constraint — `_load.py` runs before the install dir is located, so it cannot import `config_loader`. A stable dup behind an equivalence test beats a fragile vendored import. Revisit only if drift actually recurs.

Landed within-file: `config_loader.resolve_path` (81) with `.expanduser()`, reused by `_apply_env_overrides` (110). **Not landed:** `templates/project/_load.py:32-39` hand-duplicates `resolve()` verbatim (its docstring admits the dup is intentional — `_load.py` runs before the install dir is located, so it cannot import `config_loader`). The `AGENTCHATTR_*` keys live in two files (config_loader `_ENV_OVERRIDES` + `CLI_OVERRIDE_FLAGS` vs `_load.py` print statements). No guard/sync test exists (`grep` across tests for `_load|resolve_path|AGENTCHATTR_ROOT|AGENT_CWD` → 0).
- **Approach (方案):** two layers. **Surface (recommended, low-risk):** accept the documented dup (the bootstrap-ordering constraint is real, the body is ~6 stable lines) but add a guard test asserting `config_loader.resolve_path` and `_load.resolve` agree across abs / `~` / relative inputs so the two copies cannot silently drift. **Architectural (only if drift recurs):** make the resolve rule importable by both — a dependency-free leaf module vendored alongside `_load.py`, or call `config_loader` after `AGENTCHATTR_ROOT` is known.
- **Fix scope (修正範圍):** Surface: extend `tests/test_config_overrides.py` with the cross-copy resolve-equivalence assertion, ~20-30 lines, 0 source files. Architectural: ~1 small shared leaf module + repoint `_load.py` import, ~30 lines, 2 files.
- **Completion criteria (達成條件):** either (a) a test imports `config_loader.resolve_path` and `_load.resolve` and asserts identical output for absolute, `~user`, and config-dir-relative inputs; or (b) the `resolve()` body is defined exactly once and imported by `_load.py`. (Drop the looser key-set-consistency check — `ROOT`/`AGENT_CWD` legitimately sit outside `_ENV_OVERRIDES`.)

#### NEW-WRAP-1 — vestigial ServerClient forwarders re-instantiate the client inside the watcher (P3, open) · NEW this audit
**Decision (定案):** **Do (Batch 4, with WRAP-3).** Thread `main()`'s single `ServerClient` through the watcher and delete the 3 re-instantiating forwarders.

Post-WRAP-1 residue: wrapper.py:93-105 keeps three one-line forwarders `_fetch_role`/`_fetch_active_rules`/`_report_rule_sync` that each construct a fresh `ServerClient(server_port)` (95/100/105) and call one method. `_queue_watcher` calls them (171/173/179/194) instead of receiving `main()`'s already-built client (built once at wrapper.py:295). So every trigger spins up 1-3 throwaway `ServerClient` instances, re-wrapping the WRAP-1 contract a second time. (`ServerClient` is stateless, so it is cheap — but it is avoidable indirection over the contract object.)
- **Approach (方案):** pass the shared client into `_queue_watcher` (via `start_watcher` kwargs / WRAP-3's decomposition) and call `client.fetch_role`/`fetch_active_rules`/`report_rule_sync` directly; delete the three forwarders. Pairs naturally with WRAP-3.
- **Fix scope (修正範圍):** `wrapper.py` — delete 3 forwarders (93-105, ~13 lines), thread `client` through `start_watcher`/`_watcher_monitor`/`_queue_watcher`, repoint 4 call sites. 1 file.
- **Completion criteria (達成條件):** `grep '_fetch_role|_fetch_active_rules|_report_rule_sync' wrapper.py` → 0; `grep 'ServerClient(' wrapper.py` → exactly 1 (`main()` at :295); `_queue_watcher` calls `client.*` directly; wrapper tests green.

### Frontend — `chat.js (4254)` + `jobs / sessions / channels / rules-panel` + `api.js / wsClient.js / format.js`

#### FE-1 — client API/WS contract layer (P1, done)
**Decision (定案):** Done — closed.

Confirmed done. `api.js:12-52` centralizes the token header + JSON body; `wsClient.js:13-27` centralizes the `{type,...}` send shape. Proof: bare `fetch(` over static/*.js → 5, all in api.js; `ws.send(` / `.send(JSON.stringify` → wsClient only; no `XMLHttpRequest`/`sendBeacon`/extra `new WebSocket` send path. (Optional descoped residual: api.js returns a raw `Response`, so error-body parsing stays per-caller — not a blocker.)

#### FE-2 — extract shared rendering primitives into leaf modules (P2, partial)
**Decision (定案):** **Do, sequenced after FE-3.** Once the backing state lives in Store this is a clean physical move of getColor/resolveAgent/getAvatarSvg (+ renderMarkdown) into a leaf. The implicit-global hazard is already mitigated.

Only `escapeHtml` is extracted (format.js:10-15). The other five still live in chat.js: `getAvatarSvg` (175), `renderMarkdown` (260), `appendMessage` (453), `resolveAgent` (672), `getColor` (682). The implicit-global hazard is now mitigated — these are explicitly `window`-bound (chat.js:723, 730-733) — so the old "IIFE would silently break siblings" rationale is stale. The physical move is blocked: `getColor`/`resolveAgent`/`getAvatarSvg` read live `agentConfig`/`colorOverrides`/`baseColors`/`agentHats` (chat.js `let` globals), so they wait on FE-3.
- **Approach (方案):** after FE-3 moves agent/color state to Store, move `getColor`/`resolveAgent`/`getAvatarSvg` (~120 lines) into a leaf (e.g. `agentview.js`) importing from Store; `renderMarkdown` can move with `escapeHtml` into `format.js`; repoint the 4 window assignments. `appendMessage` stays (depends on many chat.js internals — FE-5/FE-6 territory).
- **Fix scope (修正範圍):** ~4 functions, ~150 lines, into a leaf module loaded before the panels; repoint chat.js:730-733. Blocked on FE-3.
- **Completion criteria (達成條件):** `grep 'function getColor|function renderMarkdown|function resolveAgent|function getAvatarSvg' static/chat.js` → 0; those functions defined in a leaf module loaded before the panels; the app loads with no `ReferenceError` (siblings still resolve them).

#### FE-3 — make Store the single owner of cross-module state (P2, partial)
**Decision (定案):** **Do (Batch 4) — the keystone frontend refactor.** Make Store the single owner of the 7 cross-module keys, one key per commit. Unblocks FE-2, FE-6 Tier-B, and NEW-FE-chatjs-split Tier-B. Highest frontend leverage after FE-1.

`activeChannel` is the one migrated single-owner (chat.js:23/34/37/39, no backing `let`; writers go through Store). The other state is still chat.js `let` + `defineProperty` bridges (33-51), with cross-module poking: rules-panel.js:104 `window.rules = rules.filter(...)` (reassign via setter, **not** `.push`), channels.js reads `window.channelList`/`channelUnread`, jobs.js reads `window.agentConfig` and mutates `window._lastMentionedAgent`. **Scope correction:** `baseColors`/`agentHats`/`colorOverrides` are chat.js-private `let`s (no bridge, no cross-module reader) and `autoScroll`'s bridge has no cross-module reader — these 4 are NOT FE-3 targets (`baseColors`/`agentHats` fold into FE-2's leaf move). The true cross-module bridged set is **7 keys**.
- **Approach (方案):** finish the migration Store was built for — move each remaining CROSS-MODULE global into Store (set+watch), repoint cross-module readers to `Store.get` and writers to `Store.set`, then delete that key's `defineProperty` bridge. Same per-key pattern proven on `activeChannel`. `ws`/`SESSION_TOKEN` stay as non-state shims.
- **Fix scope (修正範圍):** chat.js:33-51 (delete bridges incrementally) + backing `let`s (7-26). Repoint rules-panel.js (`window.rules` 97/104/118/150/352/416/428/509 — worst, in-place reassign), channels.js (`channelList`/`channelUnread` ~9 sites), jobs.js (`agentConfig`, `_lastMentionedAgent`, `soundEnabled`), sessions.js+jobs.js+rules-panel.js (`username` ~14 sites). 7 keys (channelList, channelUnread, agentConfig, rules, username, soundEnabled, _lastMentionedAgent), one key per commit.
- **Completion criteria (達成條件):** for each of the 7 keys: `grep "defineProperty(window, '<key>'" chat.js` → 0 AND no sibling reads/writes `window.<key>` (readers use `Store.get`, writers use `Store.set`; e.g. rules-panel.js uses `Store.set('rules',...)` not `window.rules = rules.filter`). Remaining `defineProperty` entries limited to non-state shims (`ws`, `SESSION_TOKEN`, `activeChannel` Store-getter).

#### FE-4 — inbound `onmessage` switch → `Hub.on` (P3, done)
**Decision (定案):** Done — closed.

Confirmed done. `ws.onmessage` (chat.js:379-384) is exactly `const event = JSON.parse(e.data); Hub.emit(event.type, event);` — no switch/if-else on `event.type`. Inbound types are `Hub.on` subscriptions across chat.js / sessions.js / jobs.js. Proof: no `switch`/`case '`/`if (event.type ===` chain in `connectWebSocket`; the 4 residual `msg.type===` hits (480/489/512/645) are renderer-internal.

#### FE-5 — `appendMessage` type-switch → `_messageRenderers` registry (P3, done)
**Decision (定案):** Done — closed.

Confirmed done. `appendMessage` (chat.js:453-501) looks up `window._messageRenderers[msg.type]` with a `system`/`_renderChat` fallback, then does scroll/unread bookkeeping. Core variants registered at chat.js (509/515/521/553/580); siblings register into the same seam (jobs.js:48, sessions.js:42/48/55/60). No inline type-switch remains.

#### FE-6 — hold a messages model; stop using the DOM as the source of truth (P1, deferred)
**Decision (定案):** **Do, sequenced last in the frontend track (after FE-3) — re-classified from 'deferred' to scheduled.** A genuine architectural defect, not a speculative one: the message subsystem is the lone DOM-as-source-of-truth outlier and the root cause behind every scrape-based feature (recolor/rename/reply/pins) and FE-2's appendMessage blocker. Contrast STATE-7 — FE-6 removes EXISTING fragility so it is justified now (just sequenced); STATE-7 would add an unused abstraction so it is deferred. Hold messages as `Map<id,msg>`; render and mutate from the model.

Confirmed deferred. No JS model for channel messages: `grep 'let messages|messagesById|new Map(' chat.js` → 0 (the only `messages` symbol is the DOM container). Features scrape rendered nodes: reply quote (623-626), `recolorMessages` (779-796), `copyMessage` (2368-2374), `startReply` (2393-2398), export/pins (2737-2739), the `agent_renamed` handler (4023+). Jobs/sessions/rules keep real arrays — messages are the outlier.
- **Approach (方案):** hold messages as `Map<id,msg>` (or `messages[]`); `appendMessage`/`_renderChat` render from the model; reply/recolor/rename/copy/pins read the model; WS mutations update the model then patch the affected node.
- **Fix scope (修正範圍):** `chat.js` — add a model + repoint the scrape sites (623-626, 779-796, 2368-2374, 2393-2398, 2737-2739, 4023-4077) plus `appendMessage`/`_renderChat` and the history-load/clear/edit handlers (4175-4236). High. Root cause behind FE-2's `appendMessage` blocker and the recolor/rename DOM walks. **Sequence after FE-1/2/3.**
- **Completion criteria (達成條件):** a messages model (`Map<id,msg>` or array) owns message data AND `grep 'dataset.rawText'` reads and `querySelector('.msg-sender').textContent` reads in chat.js → 0 (reads come from the model) AND reply/recolor/rename/copy/pins operate on the model, not scraped nodes.

#### NEW-FE-chatjs-split — finish the monolith breakup (P3, open) · NEW this audit
**Decision (定案):** **Do Tier-A now (Batch 4)** — sounds.js / version-pill.js / help.js are dependency-free leaves (~200 lines out today). **Tier-B** (naming-lightbox, settings) sequenced after FE-3. The flat <2500-line target is dropped as the gate; FE-3 is the gate.

chat.js = **4254 lines, 132 top-level functions**. Genuinely self-contained leaves: sound engine (`SOUND_OPTIONS` 71, `playNotificationSound` 86 — localStorage prefs only), version/update-pill (~200-224), help-tour (`openHelp`/`closeHelp`/`initHelpTour` ~3974-3989). **But** the naming-lightbox (`_pendingNameQueue` 995+), color-override picker (`colorOverrides` writes 1251-1295), and settings panel + custom-roles (1437-1702) are state-coupled to chat.js `let`s (`colorOverrides`, `agentConfig`, `window.customRoles`) — the same coupling FE-2/FE-3 face (`colorOverrides` has no window bridge today), so they are NOT "low-risk mechanical" yet. The flat "drops below 2500 lines" target was over-optimistic — it needs FE-3 first.
- **Approach (方案):** continue the channels.js/rules-panel.js extraction pattern in two tiers. **Tier A (now):** dependency-free leaves — `sounds.js` (SOUND_OPTIONS/playNotificationSound + `Hub.on('settings')` wiring), `version-pill.js`, `help.js`; each exposes `init()`+window handlers and subscribes to Hub. **Tier B (after FE-3):** `naming-lightbox.js` and `settings.js`, once `colorOverrides`/`agentConfig`/`customRoles` live in Store (or have explicit bridges).
- **Fix scope (修正範圍):** Tier A: 3 new files (`sounds.js` ~90 lines from chat.js:71-160, `version-pill.js` ~25 from 200-224, `help.js` ~80 around 3960-3989); repoint inline onclick handlers via window exports + existing Hub.on. Tier B (post-FE-3): `naming-lightbox.js` (~300 lines, 995-1300) + `settings.js` (~265 lines, 1437-1702). Net ~750-900 lines movable, but only ~200 lines unblocked today.
- **Completion criteria (達成條件):** Tier A: sounds, version-pill, help-tour each defined in their own module with `grep <moved-fn-names> chat.js` → 0 AND the app loads with no missing-global `ReferenceError` (chat.js drops to ~3950 lines). Full goal (chat.js < ~2500) requires Tier B, gated on FE-3 — verify by `grep 'colorOverrides\[' chat.js` → 0 before extracting the lightbox/settings.

---

## 4. New issues found this audit

Twelve items are net-new (`isNew=true`); NEW-SRV-6 was found during Batch 0 execution (the /ws smoke test surfaced it). Full detail lives in each item's subsystem section above; this is the index. **The genuinely-misbehaving regressions (NEW-SRV-1/2/6) are fixed first.**

| ID | P | Summary | Where |
|---|---|---|---|
| **NEW-SRV-1** | **P1** | `app.py:757` bare `session_token` → `NameError` on every `/ws` connect (live-UI regression) — **fixed (B0)** | §2 / Server |
| **NEW-SRV-2** | **P1** | `run.py:113-114` undefined `session_engine` → `NameError` in the startup hook — **fixed (B0)** | §2 / Server |
| **NEW-SRV-6** | **P1** | `agents.py` imported is_online/is_active/get_role from `mcp_bridge` after MCP-3 moved them to `mcp_state` → ImportError in every `broadcast_status` — **fixed (B0)** | Server / MCP |
| NEW-SRV-3 | P3 | `version_check` local `state` shadows the app_state singleton (latent footgun) | Server |
| NEW-SRV-4 | P3 | `start_session` pokes `session_store._templates` directly | Server |
| NEW-SRV-5 | P3 | `/continue` in two places; WS path unpauses `general` regardless of channel | Server |
| NEW-STATE-PERSIST-1 | P2 | ~9 store-save sites bare/no-fsync; `store._rewrite` truncates the message log in place | State |
| NEW-STATE-PERSIST-2 | P3 | `JobStore.list_all` is a read that writes to disk | State |
| NEW-MCP-1 | P2 | `chat_send` god-function: duplicated image-upload + duplicated @mention loop | MCP |
| NEW-MCP-2 | P3 | MCP read contract serialized in 3 divergent inline shapes | MCP |
| NEW-WRAP-1 | P3 | 3 forwarders re-instantiate `ServerClient` inside the watcher | Wrapper |
| NEW-FE-chatjs-split | P3 | chat.js 4254 lines / 132 fns; Tier-A leaves extractable now, Tier-B blocked on FE-3 | Frontend |

---

## 5. Suggested batches

Items within a batch share a theme or a precondition; batches are roughly ordered.

- **Batch 0 — stop the bleeding (do first, today).** NEW-SRV-1 + NEW-SRV-2 — the two `NameError` regressions from SRV-2. Each is a 1-3 line fix and must land **with** its first smoke test (`/ws`-connect, startup-hook); those missing tests are why both shipped. Closes out SRV-2.
- **Batch 1 — presence unification (meta-pattern C).** STATE-1 (= the architectural half of the old BUG-2). Extract `presence_service.py` with one `reachable()`; absorbs MCP-3's presence facet. The largest open P1 of structural value.
- **Batch 2 — durability consolidation (meta-pattern D).** NEW-STATE-PERSIST-1 (atomic adoption + `write_jsonl_atomic`) + NEW-STATE-PERSIST-2 (read-path `_save`) + the STATE-4 registry rename-save (shares one fix). Decide the STATE-4 O(n) question (split vs accept-and-document).
- **Batch 3 — MCP proxy collapse.** MCP-2 verify-gate (one live codex run) → delete `mcp_proxy.py`; then NEW-MCP-1 (after SRV-5) + NEW-MCP-2 + MCP-3(a) `chat_set_hat` `on_change`.
- **Batch 4 — remaining god-module cleanups (meta-pattern B).** SRV-5, SRV-7, SRV-8, STATE-5, WRAP-2, WRAP-3 (+ NEW-WRAP-1), WRAP-5, WRAP-6, FE-2/FE-3 (FE-3 unblocks FE-2 and Tier-B of NEW-FE-chatjs-split), NEW-FE-chatjs-split Tier-A. Small SSOT tidies: NEW-SRV-3, NEW-SRV-4, NEW-SRV-5.
- **Deferred by decision (not pending owner).** STATE-7 (storage port) — declined as a speculative abstraction; reactivate only when a concrete backend change is scheduled. FE-6 is deliberately NOT here: it fixes existing DOM-as-truth fragility, so it is scheduled (last in the frontend track, after FE-3), not deferred.

## 6. Notes

- The SRV-2 migration was structurally correct but the two missed readers prove the gap is **test coverage of the boot/connect paths**, not the rename approach. Add those smoke tests before any further global removal.
- STATE-1 and MCP-3(b) are the same presence work; STATE-4's registry rename-save and NEW-STATE-PERSIST-1 are the same atomic-write fix; NEW-MCP-1 depends on SRV-5's resolve+trigger helper; FE-2 and NEW-FE-chatjs-split Tier-B both depend on FE-3.
- Each non-bug item is behavior-preserving; do them under a reproducible check. For the bugs (NEW-SRV-1, NEW-SRV-2), write the failing test first, then fix.