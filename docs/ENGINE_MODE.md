# Engine mode — plan (finalized)

Status: **Decided & accepted — executing.** Reframe agentchattr as an **engine**
that runs chat-room **instances**. Every chat room — external projects *and this
repo itself* — launches from its own `.agentchattr/` instance via one **stable
public entry**, so the engine's internals can reorganize without breaking any
existing instance. Date 2026-06-27 · Branch: `refactor/arch-backlog`.

## 0. Model — engine vs instance

**Engine = the reusable runtime (this repo).**
- `src/` — server + wrapper code
- `bin/` — runtime entry scripts (`run.py`, `wrapper.py`, `wrapper_api.py`)
- `launchers/` — OS launch scripts (engine-internal)
- `launch.cmd` / `launch.sh` — **the single stable public launch entry**
- `config/` — engine default config (agent roster + global defaults)
- `static/` · `assets/` · `session-presets/` — engine assets
- `instance-template/` — template you copy to create a new instance
- `tools/` — dev tooling (`build_release.py`)

**Instance = one chat room's config (a `.agentchattr/` folder).** Inside the
consuming project — *and this repo has its own*:
- `config.toml` — overrides only: `root` (→engine), ports, `data_dir`, agent
  `cwd`. Does **not** define agents.
- thin wrappers + `_load.{py,sh}`. The thin wrappers call **only**
  `$AGENTCHATTR_ROOT/launch.<ext> <target>` — never an engine-internal path.

## 1. The stable launch contract (why this plan exists)

A real external instance (`cocos_cs_349/.agentchattr/`) broke when S2 moved
`windows/` → `launchers/windows/`: its thin wrappers hard-code
`$ROOT\windows\start_<agent>.bat`, an engine-**internal** path. **Lesson: an
instance must reference only a stable public entry.** Engine mode introduces
`launch.{cmd,sh}` as that entry; instances call `launch.<ext> <target>`; the
engine reorganizes internals freely behind it.

## 2. Files that stay at repo root (and why — not just convention)

- `README.md` — GitHub renders it from root.
- `LICENSE` — **MIT, © Ben Curtis (upstream).** MIT requires the notice be kept
  "in all copies"; removing it on this fork **breaches the license** and voids
  the external-use model legally. Mandatory.
- `requirements.txt` — the **only** dependency manifest (no pyproject). The
  launchers `pip install -r requirements.txt`; removing it breaks venv setup →
  `python bin/run.py` ImportErrors. Functionally mandatory. Keep the name —
  Dependabot / dependency-graph / IDE / CI key on the literal `requirements.txt`.
- `VERSION` — engine version metadata (read by `tools/build_release.py` +
  `src/core/version_check.py`); conventional at root. Stays.
- `launch.cmd` / `launch.sh` — the public launch entry; belongs at root.

"Clean root" means no scattered *implementation* files — not an empty root.

## 3. Decisions summary

| # | Stage | Decision (定案) |
|---|---|---|
| R1 | `project-template/` → `instance-template/` | Rename + all refs. |
| R2 | Engine config → `config/` | `config.toml` + `config.local.toml.example` → `config/`; `config_loader`, `run.py`, `.gitignore`, `build_release`, README. |
| R3 | Entries → `bin/`, dev tool → `tools/` | `run/wrapper/wrapper_api.py` → `bin/`; `build_release.py` → `tools/`; fix each entry's `ROOT` (parent→parent.parent); launchers' `python run.py`→`python bin\run.py` etc.; manifest + README. |
| R4 | Stable launch contract | Add `launch.{cmd,sh}` (targets: `open` \| `server` \| `<agent>`); `instance-template/` thin wrappers call `$ROOT/launch.<ext> <target>`; delete `open_chat.html` (folded into `launch … open`, instance-port aware). |
| R5 | Repo self-instance `.agentchattr/` | Copy `instance-template/` → repo `.agentchattr/`; `root=".."`, `cwd=".."`, ports `8300/8200/8201`. Commit. Dogfood-verify codex joins via it. |
| R6 | Docs reframe | README leads with `.agentchattr/` + `launch.*`; engine/instance model; disambiguate `config/config.toml` (engine) vs `.agentchattr/config.toml` (instance). |
| R7 | Re-sync `cocos_cs_349/.agentchattr/` | Re-copy thin wrappers from the new `instance-template/` (now calling `launch.<ext>`); keep its `config.toml` (root/ports/cwd). |

Order **R1→R2→R3→R4→R5→R6→R7**; one commit per stage; invariant gate before
each.

## 4. Invariants (verification contract)

- `python bin/run.py` boots (reads `config/config.toml`); 228 tests green.
- Direct launchers still work; `launch.<ext> <agent>` works.
- Repo's own chat launches via `.agentchattr/` and a real codex agent registers
  + heartbeats (dogfood) — the same flow an external instance uses.
- After R7, `cocos_cs_349/.agentchattr/` references only `launch.<ext>` (no dead
  engine-internal path).

## 5. `launch.cmd` / `launch.sh` contract

`launch.<ext> <target> [args]`:
- `open` → open the browser at `http://127.0.0.1:${AGENTCHATTR_PORT:-8300}`
  (replaces `open_chat.html`; now instance-port aware).
- `server` (or empty) → `launchers/<os>/start.<bat|sh>`.
- `<agent>` → `launchers/<os>/start_<agent>.<bat|sh>`.

Engine-internal launcher reorganization only ever touches `launch.*`; instances
are insulated.

## 6. Risk register

| Risk | Stage | Mitigation |
|---|---|---|
| `config_loader` still reads root `config.toml` | R2 | boot resolves 9 agents from `config/`; tests. |
| entry `ROOT` wrong after `bin/` move → `import src` fails | R3 | `python bin/run.py` boot + import smoke + tests. |
| `launch.*` mis-dispatches / arg passing | R4 | run `launch server` + `launch codex` live. |
| self-instance `root`/`cwd` anchor wrong | R5 | dogfood: codex registers + heartbeats. |
| cocos still points at a dead path | R7 | grep cocos for engine-internal paths = none; only `launch.<ext>`. |

Each stage is an isolated commit on `refactor/arch-backlog` (pushed to origin);
revert a single stage if its gate fails. `cocos_cs_349` is a separate repo —
its `.agentchattr/` is re-synced last, after the engine side is green.
