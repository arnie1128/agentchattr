//! agentchattr-wrapper — native cross-platform agent wrapper (M0 prototype).
//!
//! M0 scope: prove the PTY core. `selftest` validates spawn + injection +
//! output capture headlessly; `run` hosts a command interactively for
//! owner-driven TUI validation. The orchestration layers (server client, queue
//! watcher, MCP injection) land in later milestones — see
//! docs/NATIVE_WRAPPER_REWRITE.md.

mod activity;
mod config;
mod identity;
mod mcp;
mod prompt;
mod pty;
mod server;
mod watcher;

use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, PtySize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
        Some("run-agent") => {
            let opts = parse_run_args(&args[2..])?;
            run_agent(opts)
        }
        Some("start-server") => start_server_cmd(&args[2..]),
        _ => {
            eprintln!("agentchattr-wrapper (M0/M1 prototype)");
            eprintln!("usage:");
            eprintln!("  agentchattr-wrapper selftest          # headless PTY-core validation");
            eprintln!("  agentchattr-wrapper run <cmd> [args]  # host <cmd> in a PTY, interactive");
            eprintln!("  agentchattr-wrapper config [root]     # load + print resolved config");
            eprintln!("  agentchattr-wrapper ping [port]       # smoke-test the server contract");
            eprintln!("  agentchattr-wrapper run-agent <name> [--port P] [--root DIR] [--label L]");
            eprintln!("        [--agent-cwd DIR] [--no-restart] [--exec \"CMD ARGS\"]");
            eprintln!("  agentchattr-wrapper start-server [--root DIR] [--port P]  # server only");
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

/// Resolve config (honouring a per-project overlay) and print the resolved view.
fn dump_config(root: Option<PathBuf>) -> Result<()> {
    let root = root.unwrap_or_else(discover_root);
    let inv = config::resolve_invocation(&root, &config::Overrides::default(), None)?;
    let cfg = &inv.config;
    println!("install_root     = {}", inv.install_root.display());
    println!("server.port      = {}", cfg.server.port);
    println!(
        "server.data_dir  = {}",
        cfg.data_dir_path(&inv.install_root).display()
    );
    println!("mcp.http_port    = {}", cfg.mcp.http_port);
    println!("mcp.sse_port     = {}", cfg.mcp.sse_port);
    if let Some(c) = &inv.agent_cwd {
        println!("agent_cwd        = {c}");
    }
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

// ---------------------------------------------------------------------------
// run-agent — the assembled wrapper (config → register → inject → PTY + threads)
// ---------------------------------------------------------------------------

struct RunOpts {
    agent: String,
    root: PathBuf,
    overrides: config::Overrides,
    label: Option<String>,
    agent_cwd: Option<String>,
    no_restart: bool,
    /// Raw command override (wraps an arbitrary command with no MCP injection).
    exec: Option<String>,
}

fn parse_run_args(args: &[String]) -> Result<RunOpts> {
    let mut agent: Option<String> = None;
    let mut o = config::Overrides::default();
    let mut root: Option<PathBuf> = None;
    let mut label = None;
    let mut agent_cwd = None;
    let mut no_restart = false;
    let mut exec = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                o.port = args.get(i).and_then(|v| v.parse().ok());
            }
            "--mcp-http-port" => {
                i += 1;
                o.mcp_http_port = args.get(i).and_then(|v| v.parse().ok());
            }
            "--mcp-sse-port" => {
                i += 1;
                o.mcp_sse_port = args.get(i).and_then(|v| v.parse().ok());
            }
            "--data-dir" => {
                i += 1;
                o.data_dir = args.get(i).cloned();
            }
            "--root" => {
                i += 1;
                root = args.get(i).map(PathBuf::from);
            }
            "--label" => {
                i += 1;
                label = args.get(i).cloned();
            }
            "--agent-cwd" => {
                i += 1;
                agent_cwd = args.get(i).cloned();
            }
            "--exec" => {
                i += 1;
                exec = args.get(i).cloned();
            }
            "--no-restart" => no_restart = true,
            other if !other.starts_with("--") && agent.is_none() => {
                agent = Some(other.to_string());
            }
            _ => {}
        }
        i += 1;
    }
    let agent = agent.ok_or_else(|| anyhow::anyhow!("run-agent requires an agent name"))?;
    let root = root.unwrap_or_else(discover_root);
    Ok(RunOpts {
        agent,
        root,
        overrides: o,
        label,
        agent_cwd,
        no_restart,
        exec,
    })
}

/// Discover the agentchattr install root (where `config.toml` lives) when
/// `--root` isn't given: a per-project `.agentchattr/config.toml` in the current
/// dir, then a `config.toml` in the current dir, then `AGENTCHATTR_ROOT`, else
/// the current dir.
fn discover_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let project = cwd.join(".agentchattr");
    if project.join("config.toml").exists() {
        return project;
    }
    if cwd.join("config.toml").exists() {
        return cwd;
    }
    if let Some(root) = std::env::var_os("AGENTCHATTR_ROOT") {
        return PathBuf::from(root);
    }
    cwd
}

/// Strip Windows' `\\?\` extended-length prefix — CreateProcessW rejects it as
/// a working directory.
fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

struct Launch {
    program: String,
    prefix_args: Vec<String>,
}

/// Resolve a command to something CreateProcessW can spawn. npm/fnm shims on
/// Windows are `.cmd`/`.ps1` scripts (not `.exe`); CreateProcessW can't run them
/// directly, so wrap them in their interpreter. `.exe` and Unix binaries run as
/// themselves. Mirrors what the Python wrapper got from `shutil.which`.
fn resolve_launch(command: &str) -> Launch {
    let resolved = which::which(command).unwrap_or_else(|_| PathBuf::from(command));
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let full = resolved.to_string_lossy().into_owned();
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            // npm/fnm node shims (codex) break interactive stdin under cmd /c
            // because the real process is node's grandchild. If we can spot the
            // node script the shim runs, launch node directly instead.
            if let Some(js) = node_shim_target(&resolved) {
                Launch {
                    program: "node".into(),
                    prefix_args: vec![js],
                }
            } else {
                Launch {
                    program: "cmd.exe".into(),
                    prefix_args: vec!["/c".into(), full],
                }
            }
        }
        Some("ps1") => Launch {
            program: "powershell.exe".into(),
            prefix_args: vec![
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                full,
            ],
        },
        _ => Launch {
            program: full,
            prefix_args: vec![],
        },
    }
}

/// If `cmd_path` is an npm/node shim (`node "...%dp0%...\X.js" %*`), resolve the
/// `.js` target against the shim's directory so we can run node directly.
fn node_shim_target(cmd_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(cmd_path).ok()?;
    let dir = cmd_path.parent()?.to_string_lossy().into_owned();
    for tok in text.split(['"', ' ', '\t', '\r', '\n']) {
        if !tok.to_ascii_lowercase().ends_with(".js") {
            continue;
        }
        let resolved = tok
            .replace("%~dp0", &dir)
            .replace("%dp0%", &dir)
            .replace("%dp0", &dir)
            .replace("\\\\", "\\");
        let pb = PathBuf::from(&resolved);
        if pb.is_file() {
            return Some(pb.to_string_lossy().into_owned());
        }
    }
    None
}

/// Prefer the install's venv Python, else `python` on PATH.
fn find_python(install_root: &Path) -> std::ffi::OsString {
    #[cfg(windows)]
    let venv = install_root.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(windows))]
    let venv = install_root.join(".venv").join("bin").join("python");
    if venv.exists() {
        venv.into_os_string()
    } else {
        std::ffi::OsString::from("python")
    }
}

/// Start the Python server (`run.py`) detached with the resolved ports/data_dir.
/// On Windows it gets its own console window, matching the legacy `.bat` flow.
fn start_server(
    install_root: &Path,
    port: u16,
    data_dir: &Path,
    http_port: u16,
    sse_port: u16,
) -> Result<()> {
    let python = find_python(install_root);
    let mut cmd = std::process::Command::new(python);
    cmd.current_dir(install_root)
        .arg("run.py")
        .arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--mcp-http-port")
        .arg(http_port.to_string())
        .arg("--mcp-sse-port")
        .arg(sse_port.to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP — own window, and not in
        // the agent's Ctrl+C group so quitting an agent never kills the server.
        cmd.creation_flags(0x0000_0010 | 0x0000_0200);
    }
    cmd.spawn().context("starting agentchattr server")?;
    Ok(())
}

/// `start-server` — resolve the (possibly per-project) config and start the
/// Python server only, if it isn't already up. The standalone equivalent of the
/// template's `start.cmd`.
fn start_server_cmd(args: &[String]) -> Result<()> {
    let mut root: Option<PathBuf> = None;
    let mut o = config::Overrides::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                i += 1;
                root = args.get(i).map(PathBuf::from);
            }
            "--port" => {
                i += 1;
                o.port = args.get(i).and_then(|v| v.parse().ok());
            }
            _ => {}
        }
        i += 1;
    }
    let root = root.unwrap_or_else(discover_root);
    let inv = config::resolve_invocation(&root, &o, None)?;
    let cfg = inv.config;
    let install_root = inv.install_root;
    let port = cfg.server.port;
    let data_dir = cfg.data_dir_path(&install_root);
    std::fs::create_dir_all(&data_dir)?;
    let client = server::ServerClient::new(port);
    if client.is_up() {
        println!("  Server already running on :{port}");
        return Ok(());
    }
    println!("  Starting server on :{port}…");
    start_server(&install_root, port, &data_dir, cfg.mcp.http_port, cfg.mcp.sse_port)?;
    for _ in 0..60 {
        if client.is_up() {
            println!("  Server is up on :{port}");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    anyhow::bail!("server did not come up on :{port} within 30s")
}

fn run_agent(opts: RunOpts) -> Result<()> {
    // Resolve config, honouring a per-project `.agentchattr` overlay.
    let inv = config::resolve_invocation(&opts.root, &opts.overrides, opts.agent_cwd.as_deref())?;
    let cfg = inv.config;
    // Strip the \\?\ extended-length prefix everywhere — agents (e.g. Claude's
    // --mcp-config) and CreateProcessW choke on it.
    let install_root = strip_unc(inv.install_root);
    let server_port = cfg.server.port;
    let data_dir = strip_unc(cfg.data_dir_path(&install_root));
    std::fs::create_dir_all(&data_dir)?;
    let agent_cfg = cfg.agents.get(&opts.agent).cloned().unwrap_or_default();

    // Agent working directory: project overlay / --agent-cwd wins, else
    // config.cwd anchored at the install root, else the install root.
    let project_dir = if let Some(c) = &inv.agent_cwd {
        let p = PathBuf::from(c);
        strip_unc(p.canonicalize().unwrap_or(p))
    } else {
        let cwd = agent_cfg.cwd.clone().unwrap_or_else(|| ".".to_string());
        let p = install_root.join(&cwd);
        strip_unc(p.canonicalize().unwrap_or(p))
    };

    let client = server::ServerClient::new(server_port);
    if !client.is_up() {
        println!("  Server not running on :{server_port} — starting it…");
        start_server(&install_root, server_port, &data_dir, cfg.mcp.http_port, cfg.mcp.sse_port)?;
        let mut up = false;
        for _ in 0..60 {
            if client.is_up() {
                up = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if !up {
            anyhow::bail!("server did not come up on :{server_port} within 30s");
        }
        println!("  Server is up on :{server_port}");
    }
    let reg = client.register(&opts.agent, opts.label.as_deref())?;
    println!("  Registered as: {} (slot {})", reg.name, reg.slot);
    let identity = Arc::new(identity::Identity::new(
        reg.name.clone(),
        reg.token.clone(),
        data_dir.clone(),
    ));
    let is_multi = reg.slot > 1;
    let _ = std::fs::write(identity.queue_path(), "");

    // Ctrl+C handling. While the agent is active the terminal is in raw mode, so
    // Ctrl+C is delivered to the agent as a keystroke and never reaches here.
    // Between runs / at the restart prompt the terminal is cooked, so Ctrl+C
    // fires this handler: restore the terminal, deregister, and quit cleanly.
    {
        let client = client.clone();
        let identity = Arc::clone(&identity);
        let _ = ctrlc::set_handler(move || {
            let _ = crossterm::terminal::disable_raw_mode();
            let _ = client.deregister(&identity.name(), &identity.token());
            println!("\r\n  Quit.");
            std::process::exit(130);
        });
    }

    // Command + MCP injection (+ identity proxy for proxy_flag agents).
    let mut proxy: Option<Arc<mcp::proxy::McpProxy>> = None;
    let (command, launch_args, inject_env): (String, Vec<String>, BTreeMap<String, String>) =
        if let Some(exec) = &opts.exec {
            let mut parts: Vec<String> = exec.split_whitespace().map(str::to_string).collect();
            anyhow::ensure!(!parts.is_empty(), "--exec needs a command");
            let cmd = parts.remove(0);
            (cmd, parts, BTreeMap::new())
        } else {
            let command = agent_cfg.command.clone().unwrap_or_else(|| opts.agent.clone());
            let proxy_url = if mcp::inject::mode_for(&opts.agent, &agent_cfg).as_deref()
                == Some("proxy_flag")
            {
                let upstream = format!("http://127.0.0.1:{}", cfg.mcp.http_port);
                let p = Arc::new(mcp::proxy::McpProxy::new(
                    &upstream,
                    cfg.mcp.http_port,
                    &reg.name,
                    &reg.token,
                ));
                let port = p.start()?;
                println!("  MCP identity proxy on :{port}");
                let url = format!("{}/mcp", p.url());
                proxy = Some(p);
                Some(url)
            } else {
                None
            };
            let inj = mcp::inject::apply(
                &opts.agent,
                &agent_cfg,
                &reg.name,
                &data_dir,
                proxy_url.as_deref(),
                &reg.token,
                cfg.mcp.http_port,
                cfg.mcp.sse_port,
                &project_dir,
            )?;
            if let Some(sp) = &inj.settings_path {
                println!("  MCP config: {}", sp.display());
            }
            (command, inj.launch_args, inj.inject_env)
        };

    let counter = activity::ActivityCounter::new();
    let shared_writer: Arc<Mutex<Option<pty::PtyWriter>>> = Arc::new(Mutex::new(None));

    // Heartbeat thread: rename adoption + 409 recovery.
    std::thread::spawn({
        let client = client.clone();
        let identity = Arc::clone(&identity);
        let proxy = proxy.clone();
        let data_dir = data_dir.clone();
        let agent = opts.agent.clone();
        let label = opts.label.clone();
        move || heartbeat_loop(client, identity, proxy, data_dir, agent, label)
    });

    // Activity reporter thread.
    std::thread::spawn({
        let client = client.clone();
        let identity = Arc::clone(&identity);
        let counter = Arc::clone(&counter);
        move || activity_loop(client, identity, counter)
    });

    // Queue watcher thread: injects into the current PTY via shared_writer.
    std::thread::spawn({
        let watcher = watcher::Watcher::new(client.clone(), opts.agent.clone(), is_multi);
        let id_snap = Arc::clone(&identity);
        let id_tok = Arc::clone(&identity);
        let sw = Arc::clone(&shared_writer);
        let counter = Arc::clone(&counter);
        let get_identity = move || id_snap.snapshot();
        let get_token = move || id_tok.token();
        let inject = move |text: &str| {
            // Clone the current writer handle so we don't hold the outer lock
            // across the delay below.
            let writer = { sw.lock().unwrap().as_ref().cloned() };
            if let Some(w) = writer {
                {
                    let mut g = w.lock().unwrap();
                    let _ = g.write_all(text.as_bytes());
                    let _ = g.flush();
                }
                // Let the TUI ingest the text before Enter — some Ink-based
                // input layers (Claude Code) drop a glued-on Enter and leave the
                // text sitting unsent in the box.
                std::thread::sleep(Duration::from_millis(400));
                let mut g = w.lock().unwrap();
                let _ = g.write_all(b"\r");
                let _ = g.flush();
            }
        };
        let on_trigger = move || counter.set_trigger();
        move || watcher::run(watcher, get_identity, get_token, inject, on_trigger)
    });

    let launch = resolve_launch(&command);
    println!("  Starting {} in {}", command, project_dir.display());

    // One persistent stdin pump → whichever PTY is current (survives restarts).
    std::thread::spawn({
        let sw = Arc::clone(&shared_writer);
        move || pump_input(sw)
    });

    // Run loop: spawn the agent in a PTY, pump I/O, restart unless --no-restart.
    loop {
        let mut cmd = CommandBuilder::new(&launch.program);
        for a in &launch.prefix_args {
            cmd.arg(a);
        }
        for a in &launch_args {
            cmd.arg(a);
        }
        cmd.cwd(&project_dir);
        cmd.env_remove("CLAUDECODE");
        for v in &agent_cfg.strip_env {
            cmd.env_remove(v);
        }
        for (k, v) in &inject_env {
            cmd.env(k, v);
        }

        let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 30));
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let mut host = pty::PtyHost::spawn(cmd, size).context("spawning agent in PTY")?;

        // Raw mode only while the agent is active; restored to cooked before the
        // restart window so Ctrl+C there becomes a quit signal (the Ctrl+C fix).
        let code = {
            let _raw = pty::RawModeGuard::enable().ok();
            *shared_writer.lock().unwrap() = Some(host.writer());
            let reader = host.reader()?;
            let out_thread = std::thread::spawn({
                let counter = Arc::clone(&counter);
                let sw = Arc::clone(&shared_writer);
                move || pump_output(reader, counter, sw)
            });
            // Poll for child exit AND terminal resize (no SIGWINCH on Windows):
            // when the window changes size, resize the PTY so the agent re-flows
            // instead of corrupting and losing input.
            let mut last_size = (cols, rows);
            let code = loop {
                if let Some(c) = host.try_wait()? {
                    break c;
                }
                if let Ok(sz) = crossterm::terminal::size() {
                    if sz != last_size {
                        let _ = host.resize(sz.1, sz.0); // (rows, cols)
                        last_size = sz;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            *shared_writer.lock().unwrap() = None;
            let _ = out_thread.join();
            code
        };

        if opts.no_restart {
            break;
        }
        println!(
            "\r\n  {} exited (code {code}). Restarting in 3s... (Ctrl+C to quit)",
            opts.agent
        );
        std::thread::sleep(Duration::from_secs(3));
    }

    let (name, _) = identity.snapshot();
    let _ = client.deregister(&name, &identity.token());
    println!("  Deregistered {name}");
    // Worker threads (heartbeat/activity/watcher) and portable-pty's internal
    // ConPTY pump threads are detached; exit explicitly so the wrapper returns
    // to the shell promptly instead of lingering on them.
    std::process::exit(0);
}

fn heartbeat_loop(
    client: server::ServerClient,
    identity: Arc<identity::Identity>,
    proxy: Option<Arc<mcp::proxy::McpProxy>>,
    data_dir: PathBuf,
    agent: String,
    label: Option<String>,
) {
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let name = identity.name();
        let token = identity.token();
        match client.heartbeat(&name, &token, None) {
            Ok(server::Heartbeat::Ok { name: server_name }) => {
                if server_name != name && identity.set(Some(&server_name), None) {
                    if let Some(p) = &proxy {
                        p.set_identity(&server_name, &identity.token());
                    }
                    println!("  Identity updated: {name} -> {server_name}");
                }
            }
            Ok(server::Heartbeat::Conflict) => {
                if let Ok(reg) = client.register(&agent, label.as_deref()) {
                    identity.set(Some(&reg.name), Some(&reg.token));
                    if let Some(p) = &proxy {
                        p.set_identity(&reg.name, &reg.token);
                    }
                    server::write_recovery_flag(&data_dir, &reg.name);
                    println!("  Session recovered as {}", reg.name);
                }
            }
            Err(_) => {}
        }
    }
}

fn activity_loop(
    client: server::ServerClient,
    identity: Arc<identity::Identity>,
    counter: Arc<activity::ActivityCounter>,
) {
    let mut state = activity::ActivityState::new(counter);
    let mut last_active: Option<bool> = None;
    let mut last_report = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let active = state.poll();
        let elapsed = Instant::now().duration_since(last_report);
        let should = last_active != Some(active)
            || (active && elapsed >= Duration::from_secs(3))
            || (!active && elapsed >= Duration::from_secs(8));
        if should {
            let _ = client.heartbeat(&identity.name(), &identity.token(), Some(active));
            last_active = Some(active);
            last_report = Instant::now();
        }
    }
}

fn pump_output(
    mut reader: Box<dyn Read + Send>,
    counter: Arc<activity::ActivityCounter>,
    sw: Arc<Mutex<Option<pty::PtyWriter>>>,
) {
    let mut stdout = std::io::stdout();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                counter.add_bytes(n);
                // Answer cursor-position (DSR) queries ourselves so the agent's
                // TUI doesn't stall waiting for the terminal, and strip the query
                // so the outer terminal doesn't also reply.
                let out = answer_dsr(&buf[..n], &sw);
                if stdout.write_all(&out).is_err() {
                    break;
                }
                let _ = stdout.flush();
            }
        }
    }
}

/// If `chunk` contains a DSR cursor-position query (`ESC[6n`), reply `ESC[1;1R`
/// to the PTY and return the chunk with the query removed; otherwise return the
/// chunk unchanged.
fn answer_dsr(chunk: &[u8], sw: &Arc<Mutex<Option<pty::PtyWriter>>>) -> Vec<u8> {
    const Q: &[u8] = b"\x1b[6n";
    if chunk.len() < 4 || !chunk.windows(4).any(|w| w == Q) {
        return chunk.to_vec();
    }
    if let Some(w) = sw.lock().unwrap().as_ref().cloned() {
        if let Ok(mut g) = w.lock() {
            let _ = g.write_all(b"\x1b[1;1R");
            let _ = g.flush();
        }
    }
    let mut out = Vec::with_capacity(chunk.len());
    let mut i = 0;
    while i < chunk.len() {
        if i + 4 <= chunk.len() && &chunk[i..i + 4] == Q {
            i += 4;
        } else {
            out.push(chunk[i]);
            i += 1;
        }
    }
    out
}

fn pump_input(sw: Arc<Mutex<Option<pty::PtyWriter>>>) {
    let mut stdin = std::io::stdin();
    let mut buf = [0u8; 1024];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let writer = { sw.lock().unwrap().as_ref().cloned() };
                if let Some(w) = writer {
                    if let Ok(mut g) = w.lock() {
                        let _ = g.write_all(&buf[..n]);
                        let _ = g.flush();
                    }
                }
            }
        }
    }
}
