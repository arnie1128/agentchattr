# Standing architecture decisions

Decisions that are deliberate but look like omissions or duplication — recorded
so they are not re-litigated or "fixed" by accident. Salvaged from the completed
architecture-review backlog; the full per-item history lives in git (branch
`refactor/arch-backlog`).

## No storage port (deferred)

The stores under `src/storage/` each hand-roll `_load` / `_save`; there is no
`StoragePort` abstraction. This is intentional (YAGNI / rule-of-three): there is
no second backend, so a port would be indirection with zero consumer across ~7
stores. Durability is already covered by the shared helpers in
`src/core/atomic_io.py` (`write_json_atomic` / `write_jsonl_atomic`: tmp + fsync +
`os.replace`). **Reactivate only when a concrete backend change is scheduled**
(sqlite / remote / multi-process).

## Codex connects to MCP via a direct bearer token, not a proxy

There is no identity proxy in `src/mcp/`. Codex injects the server URL +
`bearer_token_env_var` directly (token in env, never in argv); the server
authenticates the `Authorization: Bearer` header and derives identity from the
token. The old per-identity proxy was the lone exception forcing an entire proxy
subsystem; it was deleted once codex's native bearer support was confirmed
end-to-end. **Do not re-introduce a proxy** for identity stamping.

## The @mention send-gate is presence-only, by design

`@all` is gated by `reachable()` (active ∧ present), so it excludes a
claimed-but-offline agent. But an explicit `@mention` of an offline agent is
instead **queued** (presence-checked via `is_online`, posts "offline — queued",
and still attempts the trigger). These are genuinely different decisions, so the
two paths use different predicates on purpose. **Do not unify them** — collapsing
the explicit-mention gate onto `reachable()` would drop the intentional
queue-on-offline behavior.

## `_load.py`'s path-resolve is duplicated on purpose

`instance-template/_load.py` re-implements the path-resolve rule that
`src/core/config_loader.py` already has, instead of importing it. This is required
by bootstrap ordering: `_load.py` runs *before* the engine install dir is located,
so it cannot import from `src/`. The duplication is guarded by an equivalence test
(`tests/test_config_resolve_drift.py`) so the two copies cannot silently drift.
**Keep the dup**; do not "DRY" it by importing `config_loader`.
