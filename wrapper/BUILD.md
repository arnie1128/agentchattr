# Building agentchattr-wrapper

Cross-platform native wrapper (Rust) that hosts an agent CLI in a pseudo-terminal
(ConPTY on Windows, `openpty` on Unix). Replaces the Python `wrapper*.py` trio.

## macOS / Linux

Nothing special — the system toolchain works:

```sh
rustup default stable
cargo build --release --manifest-path wrapper/Cargo.toml
```

`portable-pty` uses `openpty`; the system clang/ld link cleanly. macOS is the
owner's primary platform and needs none of the Windows workaround below.

## Windows (x86_64-pc-windows-gnu)

The GNU toolchain needs a mingw-w64 `as` (assembler) **and** `dlltool` to generate
import libraries for the `windows-sys` crate. rustup's self-contained mingw ships
`dlltool` but **not** `as`, so a stock `rustup default stable-gnu` build fails:

```
error: error calling dlltool 'dlltool.exe': program not found          (no as on PATH)
error: dlltool could not create import library ... CreateProcess        (dlltool can't spawn as)
```

Fix — provide a mingw-w64 `as.exe` + `dlltool.exe`, exposing **only** those two
(plus their DLLs) so they don't shadow rust's self-contained linker:

1. Download a winlibs mingw-w64 build (UCRT or MSVCRT both work — `as`/`dlltool`
   are CRT-agnostic for import-lib generation):
   <https://github.com/brechtsanders/winlibs_mingw/releases>
2. Copy `as.exe`, `dlltool.exe`, and the bin `*.dll` into an isolated directory.
   Do **not** put the full winlibs `bin` on PATH — its `ld`/`gcc` would shadow
   rust's self-contained linker and fail with `cannot find -lkernel32`.
3. Build with that directory on PATH and `dlltool` pointed at it:

```sh
export PATH="$HOME/.cargo/bin:/path/to/asdir:$PATH"
export RUSTFLAGS="-Cdlltool=/path/to/asdir/dlltool.exe"
cargo build --release --manifest-path wrapper/Cargo.toml
```

Alternative: install the MSVC toolchain (Visual Studio Build Tools) and
`rustup default stable-msvc` — no mingw needed, but a multi-GB install.

## Smoke test (headless)

```sh
cargo run --manifest-path wrapper/Cargo.toml -- selftest
```

Spawns a shell in a PTY, injects a marker command, and asserts it round-trips —
validates PTY spawn + injection + output capture without a human or a TUI.
Interactive TUI rendering and Ctrl+C-to-agent are validated by a human via
`agentchattr-wrapper run <cmd>` (see docs/NATIVE_WRAPPER_REWRITE.md M0).
