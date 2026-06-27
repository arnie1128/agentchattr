# Engine mode — design

agentchattr is an **engine** that runs chat-room **instances**. Every chat room —
external projects *and this repo itself* — launches from its own `.agentchattr/`
instance through one **stable public entry**, so the engine's internals can
reorganize without breaking any existing instance.

## Engine vs instance

**Engine = the reusable runtime (this repo).**

- `src/` — server + wrapper code (internal package; absolute `src.*` imports).
- `bin/` — runtime entry scripts (`run.py`, `wrapper.py`, `wrapper_api.py`).
- `launchers/` — OS launch scripts, engine-internal (`windows/`, `macos-linux/`).
- `launch.cmd` / `launch.sh` — **the single stable public launch entry**.
- `config/` — engine default config (`config.toml`: agent roster + global defaults).
- `static/` · `assets/` · `session-presets/` — engine assets.
- `instance-template/` — the template you copy to create a new instance.
- `tools/` — dev tooling (`build_release.py`).

**Instance = one chat room's config (a `.agentchattr/` folder).** It lives inside
the consuming project — and this repo carries its own at `./.agentchattr/`.

- `config.toml` — overrides only: `root` (→ engine), ports, `data_dir`, agent
  `cwd`. It does **not** define agents; the roster comes from the engine's
  `config/config.toml`.
- thin wrappers + `_load.{py,sh}`. The thin wrappers call **only**
  `$AGENTCHATTR_ROOT/launch.<ext> <target>` — never an engine-internal path.

## The stable launch contract

An instance references exactly one engine entry: `launch.<ext> <target> [args]`,
where `<target>` is:

- `open` — open the browser at `http://127.0.0.1:${AGENTCHATTR_PORT:-8300}`
  (instance-port aware).
- `server` (or empty) — start the server via `launchers/<os>/start.<bat|sh>`.
- `<agent>` — launch an agent via `launchers/<os>/start_<agent>.<bat|sh>`.

`launch.cmd` (Windows) / `launch.sh` (macOS/Linux) self-locate the engine root and
dispatch internally. Because an instance never names an engine-internal path,
reorganizing `launchers/` — or anything else behind `launch.*` — cannot break it.

**Why this exists.** A real external instance once broke when the launchers moved
from `windows/` to `launchers/windows/`: its thin wrappers hard-coded
`$ROOT\windows\start_<agent>.bat`, an engine-internal path. The stable contract
removes that coupling — the engine reorganizes internals freely behind `launch.*`,
and the instance only ever calls `launch.<ext> <target>`.

## Files that stay at repo root

"Clean root" means no scattered *implementation* files — not an empty root. These
belong at root for a concrete reason, not mere convention:

- `README.md` — GitHub renders it from root.
- `LICENSE` — MIT, © Ben Curtis (upstream). MIT requires the notice be kept "in
  all copies"; removing it on this fork would breach the license. Mandatory.
- `requirements.txt` — the only dependency manifest (no `pyproject.toml`). The
  launchers run `pip install -r requirements.txt`; the literal name is fixed
  (Dependabot / dependency-graph / IDE / CI key on it). Functionally mandatory.
- `VERSION` — engine version metadata (read by `tools/build_release.py` and
  `src/core/version_check.py`).
- `launch.cmd` / `launch.sh` — the public launch entry.

## ROOT resolution

- Modules under `src/` two levels deep resolve the repo root via
  `Path(__file__).resolve().parents[2]`.
- Entry scripts in `bin/` use `Path(__file__).resolve().parent.parent` and
  `sys.path.insert(0, str(ROOT))` before importing `src.*`.

---

The folder reorganization and the Python architecture refactor that produced this
layout are recorded in git history (branch `refactor/arch-backlog`). Standing and
deferred architecture decisions are in [`DECISIONS.md`](DECISIONS.md).
