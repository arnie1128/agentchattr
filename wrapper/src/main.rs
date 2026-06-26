//! agentchattr-wrapper — native cross-platform agent wrapper (M0 prototype).
//!
//! M0 scope: prove the PTY core. `selftest` validates spawn + injection +
//! output capture headlessly; `run` hosts a command interactively for
//! owner-driven TUI validation. The orchestration layers (server client, queue
//! watcher, MCP injection) land in later milestones — see
//! docs/NATIVE_WRAPPER_REWRITE.md.

mod config;
mod prompt;
mod pty;
mod server;
mod watcher;

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("selftest") => selftest(),
        Some("run") => {
            let rest = &args[2..];
            if rest.is_empty() {
                eprintln!("usage: agentchattr-wrapper run <command> [args...]");
                std::process::exit(2);
            }
            run_interactive(rest)
        }
        Some("config") => dump_config(args.get(2).map(PathBuf::from)),
        Some("ping") => ping(args.get(2).and_then(|s| s.parse().ok())),
        _ => {
            eprintln!("agentchattr-wrapper (M0/M1 prototype)");
            eprintln!("usage:");
            eprintln!("  agentchattr-wrapper selftest          # headless PTY-core validation");
            eprintln!("  agentchattr-wrapper run <cmd> [args]  # host <cmd> in a PTY, interactive");
            eprintln!("  agentchattr-wrapper config [root]     # load + print resolved config");
            eprintln!("  agentchattr-wrapper ping [port]       # smoke-test the server contract");
            std::process::exit(2);
        }
    }
}

/// Smoke-test the server contract: probe, then register → role → heartbeat →
/// deregister against a running server.
fn ping(port: Option<u16>) -> Result<()> {
    let port = port.unwrap_or(8300);
    let client = server::ServerClient::new(port);
    if !client.is_up() {
        println!("server on :{port} is DOWN");
        return Ok(());
    }
    println!("server on :{port} is up");
    let reg = client.register("codex", None)?;
    let token_hint: String = reg.token.chars().take(6).collect();
    println!(
        "registered as {} (slot {}), token {token_hint}…",
        reg.name, reg.slot
    );
    if let Some(role) = client.role(&reg.name) {
        println!("role: {role}");
    }
    match client.heartbeat(&reg.name, &reg.token, Some(false))? {
        server::Heartbeat::Ok { name } => println!("heartbeat ok (name={name})"),
        server::Heartbeat::Conflict => println!("heartbeat conflict → would re-register"),
    }
    client.deregister(&reg.name, &reg.token)?;
    println!("deregistered {}", reg.name);
    Ok(())
}

/// Load config from `root` (default: current dir) and print the resolved view.
fn dump_config(root: Option<PathBuf>) -> Result<()> {
    let root = root
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let cfg = config::load(&root, &config::Overrides::default())?;
    println!("server.port      = {}", cfg.server.port);
    println!("server.data_dir  = {}", cfg.data_dir_path(&root).display());
    println!("mcp.http_port    = {}", cfg.mcp.http_port);
    println!("mcp.sse_port     = {}", cfg.mcp.sse_port);
    println!("agents ({}):", cfg.agents.len());
    for (name, a) in &cfg.agents {
        let kind = a.kind.as_deref().unwrap_or("interactive");
        let inject = a.mcp_inject.as_deref().unwrap_or("(default)");
        println!("  {name:<10} kind={kind:<11} mcp_inject={inject}");
    }
    Ok(())
}

/// Headless validation of the PTY core: spawn a shell in a PTY, inject a marker
/// command through the writer, capture the output through the reader, and assert
/// the marker round-tripped. Proves spawn + injection + output capture with no
/// human and no TUI — the part of M0 that can be checked unattended.
fn selftest() -> Result<()> {
    const MARKER: &str = "PTYHOST_MARKER_8675309";

    let (shell, line_sep): (&str, &[u8]) = if cfg!(windows) {
        ("cmd.exe", b"\r\n")
    } else {
        ("/bin/sh", b"\n")
    };

    let size = PtySize {
        rows: 30,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    };
    let mut host = pty::PtyHost::spawn(CommandBuilder::new(shell), size).context("selftest spawn")?;

    // Stream output into a shared buffer so we can see it as it arrives, rather
    // than blocking on read_to_end / child exit (which would hang if injection
    // never reaches the child).
    let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut reader = host.reader()?;
    let sink = Arc::clone(&captured);
    // ConPTY emits a cursor-position (DSR) query `ESC[6n` at startup and stalls
    // until the controlling terminal replies. In the real wrapper the user's
    // terminal answers this; here, headless, we emulate a minimal terminal by
    // replying `ESC[1;1R` so the shell proceeds to render and process input.
    let dsr_writer = host.writer();
    std::thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        loop {
            match reader.read(&mut tmp) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &tmp[..n];
                    if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                        if let Ok(mut w) = dsr_writer.lock() {
                            let _ = w.write_all(b"\x1b[1;1R");
                            let _ = w.flush();
                        }
                    }
                    sink.lock().unwrap().extend_from_slice(chunk);
                }
            }
        }
    });

    // Let the shell come up, then inject `echo MARKER` + `exit`.
    std::thread::sleep(Duration::from_millis(400));
    {
        let writer = host.writer();
        let mut w = writer.lock().unwrap();
        w.write_all(format!("echo {MARKER}").as_bytes())?;
        w.write_all(line_sep)?;
        w.write_all(b"exit")?;
        w.write_all(line_sep)?;
        w.flush()?;
    }

    // Poll for the marker for up to ~6s — never blocks indefinitely.
    let mut found = false;
    for _ in 0..60 {
        if String::from_utf8_lossy(&captured.lock().unwrap()).contains(MARKER) {
            found = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Clean up the child regardless of outcome.
    let _ = host.kill();

    let buf = captured.lock().unwrap().clone();
    println!("[selftest] captured {} bytes from the PTY", buf.len());
    if found {
        println!("[selftest] PASS - spawn + injection + output capture all work");
        Ok(())
    } else {
        let out = String::from_utf8_lossy(&buf);
        eprintln!("[selftest] FAIL - marker not found in captured output");
        eprintln!("--- captured (first 800 bytes) ---");
        eprintln!("{}", out.chars().take(800).collect::<String>());
        eprintln!("--- end ---");
        std::process::exit(1);
    }
}

/// Host a command in a PTY and bridge it to the real terminal: PTY output ->
/// stdout, stdin -> PTY. Raw mode on the real terminal so keystrokes reach the
/// TUI unbuffered; restored on every exit path by `RawModeGuard`. Ctrl+C flows
/// through to the agent as a keystroke — the wrapper never intercepts it.
///
/// Full interactive correctness (TUI rendering, Ctrl+C-to-agent) is owner-
/// validated; this is the code path that validation exercises.
fn run_interactive(argv: &[String]) -> Result<()> {
    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }

    let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 30));
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let mut host = pty::PtyHost::spawn(cmd, size).context("run spawn")?;
    let _raw = pty::RawModeGuard::enable()?; // restored on drop — the Ctrl+C fix

    // PTY output -> stdout
    let mut reader = host.reader()?;
    let out_thread = std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdout.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = stdout.flush();
                }
            }
        }
    });

    // stdin -> PTY. Ctrl+C (0x03) flows through as a keystroke to the agent.
    let writer = host.writer();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut w = writer.lock().unwrap();
                    if w.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = w.flush();
                }
            }
        }
    });

    let code = host.wait()?;
    let _ = out_thread.join(); // drain remaining output after the child exits
    // The stdin thread may be blocked in read(); the process exit reaps it.
    eprintln!("\r\n[agentchattr-wrapper] agent exited (code {code})");
    Ok(())
}
