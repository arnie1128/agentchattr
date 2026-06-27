# Per-project agentchattr instance — template

This folder is a self-contained template for running an **isolated**
agentchattr chat room scoped to a single project. It lets you run more
than one agentchattr instance on the same machine without the projects
interfering with each other.

## Purpose

The default agentchattr install runs a single server on port 8300 (web
UI), 8200 (MCP HTTP), and 8201 (MCP SSE), with one shared data
directory and shared agent CLI sessions. If you want to use agentchattr
on more than one project at the same time, that shared setup causes
real problems:

- **tmux session names collide** — both projects launch a tmux session
  named `agentchattr-codex` (or `-claude`, etc.), and the second wrapper
  silently attaches to the first project's session instead of opening
  its own.
- **Chat history mixes** — both projects write to the same
  `data/{agent}_queue.jsonl`, so messages intended for one project's
  agent get consumed by the other.
- **MCP ports / web UI ports** — only one process can listen on 8300 /
  8200 / 8201 at a time.

This template gives each project its own ports, its own data
directory, its own agent working directory, and a project-scoped tmux
session name. The main 8300 instance keeps running untouched.

## Quick start

**1. Copy this entire folder into your project as `.agentchattr/`**

```sh
# macOS / Linux
cp -R /path/to/agentchattr/project-template /path/to/your-project/.agentchattr

# Windows (PowerShell)
Copy-Item -Recurse /path/to/agentchattr/project-template /path/to/your-project/.agentchattr
```

Copy the **whole folder**, not just the visible files — `_load.py`,
`_load.sh`, and `.gitignore` are required and easy to miss when
selecting by hand.

**2. Edit `.agentchattr/config.toml`**

At minimum, change:

- `[agentchattr] root` — point at your local agentchattr install
- `[server] port` — pick an unused port (e.g. `8301`, `8401`, ...)
- `[mcp] http_port` and `sse_port` — pick unused MCP ports

See the comments inside `config.toml` for the path-form options.

**3. Add `.agentchattr/` to your project's root `.gitignore`**

```gitignore
# agentchattr per-project isolation (local-only)
.agentchattr/
```

Per-project agentchattr settings are machine-specific (paths, ports,
your local agentchattr install location), so they normally shouldn't
travel with the project repo. Add `.agentchattr/` to your project's
root `.gitignore`.

> **Note:** The `.gitignore` file *inside* this template has a
> different purpose — it ignores `data/` and `__pycache__/` *within*
> the `.agentchattr/` folder so runtime artifacts don't get accidentally
> committed even if you do choose to commit the folder. The two
> `.gitignore` files are unrelated and both useful.

**4. Launch**

```sh
# macOS / Linux — one terminal per agent
sh /path/to/your-project/.agentchattr/start.sh         # server only
sh /path/to/your-project/.agentchattr/start_claude.sh  # claude
sh /path/to/your-project/.agentchattr/start_codex.sh   # codex
sh /path/to/your-project/.agentchattr/start_gemini.sh  # gemini
```

```bat
:: Windows — one cmd window per agent
\path\to\your-project\.agentchattr\start.cmd
\path\to\your-project\.agentchattr\start_claude.cmd
\path\to\your-project\.agentchattr\start_codex.cmd
\path\to\your-project\.agentchattr\start_gemini.cmd
```

Open the web UI at `http://127.0.0.1:<your-port>`.

## What gets isolated

- **`server.port`** — web UI listens here
- **`mcp.http_port`, `mcp.sse_port`** — MCP transports listen here
- **`server.data_dir`** — message store, queue files, MCP config files,
  registry state are all written here
- **`agent.cwd`** — the wrapped agent CLI (claude / codex / gemini) is
  launched with this as its working directory, so the agent sees your
  project files
- **tmux session names** (macOS / Linux) — wrapper builds a session
  name with a hash of project + ports, so two projects' wrappers
  never attach to the same session

## Choosing ports

The main agentchattr server (if you keep running it) uses:

- `8300` — web UI
- `8200` — MCP HTTP
- `8201` — MCP SSE

Each per-project instance needs three more ports that don't collide
with the main server or with any other per-project instance. A simple
convention is to bump by 100 per project:

| Instance | web | MCP HTTP | MCP SSE |
|---|---|---|---|
| main         | 8300 | 8200 | 8201 |
| project A    | 8301 | 8211 | 8221 |
| project B    | 8401 | 8311 | 8321 |
| project C    | 8501 | 8411 | 8421 |

Any scheme works as long as nothing collides.

## Platform notes

- **macOS / Linux** — uses the `.sh` thin wrappers. Requires Python
  3.11+ on `PATH` (for `tomllib`).
- **Windows** — uses the `.cmd` thin wrappers. Requires Python 3.11+
  on `PATH`. No PowerShell or execution-policy changes needed.

The thin wrappers source `_load.sh` / call `_load.py` to read
`config.toml` and export `AGENTCHATTR_*` environment variables, then
hand off to the main agentchattr install's launcher scripts (under
`agentchattr/launchers/macos-linux/` or `agentchattr/launchers/windows/`).

## Troubleshooting

**`_load.py: ... not found`** — the thin wrapper expects `_load.py`
next to itself. If you copied files individually instead of the whole
folder, re-copy with `cp -R` / `Copy-Item -Recurse`.

**`Python 3.11+ required (tomllib missing)`** — your default `python3`
is older than 3.11. Install a newer Python (or point your `PATH` at
one) so `import tomllib` works.

**`Address already in use` on port 8301 (or whichever you chose)** —
another process holds that port. Pick a different port in
`config.toml`, or stop the other process.

**Agent registers but messages don't arrive** — confirm you're typing
into the web UI for *this* instance (your chosen port), not the main
8300 instance. Each instance has its own web UI URL.

**`AGENTCHATTR_ROOT` not set / install not found** — `config.toml`'s
`[agentchattr] root` doesn't resolve to a real agentchattr install.
Use an absolute path (`/path/to/agentchattr`) to rule out
config-relative path issues.
