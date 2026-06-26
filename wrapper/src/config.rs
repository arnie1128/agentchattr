//! Config loading — `config.toml` + `config.local.toml` + env / CLI overrides.
//!
//! Mirrors the Python `config_loader.py` (server/agent shared config) and the
//! per-project `_load.py` path resolution, collapsed into one place. The Rust
//! binary reads `config.toml` directly, so the template `_load.py` is no longer
//! needed.
//!
//! Precedence: CLI overrides > `AGENTCHATTR_*` env > config file.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn default_port() -> u16 {
    8300
}
fn default_data_dir() -> String {
    "./data".to_string()
}
fn default_http_port() -> u16 {
    8200
}
fn default_sse_port() -> u16 {
    8201
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerCfg {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_data_dir")]
    pub data_dir: String,
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self {
            port: default_port(),
            data_dir: default_data_dir(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpCfg {
    #[serde(default = "default_http_port")]
    pub http_port: u16,
    #[serde(default = "default_sse_port")]
    pub sse_port: u16,
}

impl Default for McpCfg {
    fn default() -> Self {
        Self {
            http_port: default_http_port(),
            sse_port: default_sse_port(),
        }
    }
}

/// Per-agent config. Unknown keys (e.g. API-agent fields `base_url` / `model`,
/// which belong to the Python `wrapper_api.py` path) are ignored by serde.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AgentCfg {
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub label: Option<String>,
    pub color: Option<String>,
    /// "api" marks an API-model agent — not handled by this interactive wrapper.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    // --- MCP injection (used in M3) ---
    pub mcp_inject: Option<String>,
    pub mcp_flag: Option<String>,
    pub mcp_transport: Option<String>,
    pub mcp_settings_path: Option<String>,
    pub mcp_env_var: Option<String>,
    pub mcp_http_key: Option<String>,
    pub mcp_proxy_flag_template: Option<String>,
    pub mcp_merge_project: Option<bool>,
    // --- injection tuning ---
    pub inject_delay: Option<f64>,
    pub enter_backend: Option<String>,
    #[serde(default)]
    pub strip_env: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RoutingCfg {
    pub default: Option<String>,
    pub max_agent_hops: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerCfg,
    #[serde(default)]
    pub mcp: McpCfg,
    #[serde(default)]
    pub routing: RoutingCfg,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentCfg>,
}

impl Config {
    /// Resolve `server.data_dir` against `root` when relative; absolute values
    /// (e.g. from an `AGENTCHATTR_DATA_DIR` override) are used as-is.
    pub fn data_dir_path(&self, root: &Path) -> PathBuf {
        resolve_against(&self.server.data_dir, root)
    }

    /// MCP server URL for the given transport (`http` or `sse`).
    pub fn mcp_url(&self, transport: &str) -> String {
        if transport == "sse" {
            format!("http://127.0.0.1:{}/sse", self.mcp.sse_port)
        } else {
            format!("http://127.0.0.1:{}/mcp", self.mcp.http_port)
        }
    }
}

/// CLI-supplied overrides (highest precedence). `None` = not specified.
#[derive(Debug, Clone, Default)]
pub struct Overrides {
    pub data_dir: Option<String>,
    pub port: Option<u16>,
    pub mcp_http_port: Option<u16>,
    pub mcp_sse_port: Option<u16>,
}

/// Load `config.toml` from `root`, merge `config.local.toml`, then apply
/// `AGENTCHATTR_*` env overrides and finally the CLI `overrides`.
pub fn load(root: &Path, overrides: &Overrides) -> Result<Config> {
    let main_path = root.join("config.toml");
    let text = std::fs::read_to_string(&main_path)
        .with_context(|| format!("reading {}", main_path.display()))?;
    let mut config: Config =
        toml::from_str(&text).with_context(|| format!("parsing {}", main_path.display()))?;

    merge_local(&mut config, root);
    apply_env_overrides(&mut config);
    apply_cli_overrides(&mut config, overrides);
    Ok(config)
}

/// Merge `config.local.toml` agents: add ones not already in `config.toml`
/// (protects the built-in agents from being overridden), matching the Python.
fn merge_local(config: &mut Config, root: &Path) {
    let local_path = root.join("config.local.toml");
    if !local_path.exists() {
        return;
    }
    let Ok(text) = std::fs::read_to_string(&local_path) else {
        return;
    };
    let Ok(local) = toml::from_str::<Config>(&text) else {
        return;
    };
    for (name, agent) in local.agents {
        config.agents.entry(name).or_insert(agent);
    }
}

fn apply_env_overrides(config: &mut Config) {
    if let Some(v) = env_nonempty("AGENTCHATTR_PORT").and_then(|s| s.parse().ok()) {
        config.server.port = v;
    }
    if let Some(v) = env_nonempty("AGENTCHATTR_DATA_DIR") {
        config.server.data_dir = resolve_cwd_abs(&v);
    }
    if let Some(v) = env_nonempty("AGENTCHATTR_MCP_HTTP_PORT").and_then(|s| s.parse().ok()) {
        config.mcp.http_port = v;
    }
    if let Some(v) = env_nonempty("AGENTCHATTR_MCP_SSE_PORT").and_then(|s| s.parse().ok()) {
        config.mcp.sse_port = v;
    }
}

fn apply_cli_overrides(config: &mut Config, o: &Overrides) {
    if let Some(v) = &o.data_dir {
        config.server.data_dir = resolve_cwd_abs(v);
    }
    if let Some(v) = o.port {
        config.server.port = v;
    }
    if let Some(v) = o.mcp_http_port {
        config.mcp.http_port = v;
    }
    if let Some(v) = o.mcp_sse_port {
        config.mcp.sse_port = v;
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// Resolve a path string against `base` when relative; absolute stays as-is.
fn resolve_against(value: &str, base: &Path) -> PathBuf {
    let p = PathBuf::from(value);
    if p.is_absolute() {
        p
    } else {
        base.join(p)
    }
}

/// Resolve a relative path against the current working directory and return it
/// as an absolute string (matches the Python override path semantics).
fn resolve_cwd_abs(value: &str) -> String {
    let p = PathBuf::from(value);
    if p.is_absolute() {
        return value.to_string();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(p).to_string_lossy().into_owned(),
        Err(_) => value.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Per-project overlay (replaces the template `_load.py`)
//
// A project's `.agentchattr/config.toml` doesn't define agents; it points at an
// install via `[agentchattr] root` and overrides ports / data_dir / agent cwd.
// Paths in it anchor at the `.agentchattr` directory and accept `~`.
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ProjectFile {
    agentchattr: Option<ProjectInstall>,
    server: Option<ProjectServerOverlay>,
    mcp: Option<ProjectMcpOverlay>,
    agent: Option<ProjectAgentOverlay>,
}
#[derive(Deserialize)]
struct ProjectInstall {
    root: String,
}
#[derive(Deserialize, Default)]
struct ProjectServerOverlay {
    port: Option<u16>,
    data_dir: Option<String>,
}
#[derive(Deserialize, Default)]
struct ProjectMcpOverlay {
    http_port: Option<u16>,
    sse_port: Option<u16>,
}
#[derive(Deserialize, Default)]
struct ProjectAgentOverlay {
    cwd: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Expand a leading `~`, then anchor relative paths at `anchor`.
fn anchor_path(raw: &str, anchor: &Path) -> PathBuf {
    let expanded = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(raw))
    } else {
        PathBuf::from(raw)
    };
    let joined = if expanded.is_absolute() {
        expanded
    } else {
        anchor.join(expanded)
    };
    joined.canonicalize().unwrap_or(joined)
}

/// A fully-resolved invocation: the agent config, the install root (where the
/// main `config.toml` lives), and the agent's working directory.
pub struct Invocation {
    pub config: Config,
    pub install_root: PathBuf,
    pub agent_cwd: Option<String>,
}

/// Resolve config for a run, honouring a per-project overlay.
///
/// If `config_dir/config.toml` is a per-project file (`[agentchattr] root`
/// present), resolve the install root, fold the project's port/data_dir/mcp/cwd
/// overrides under the CLI overrides, and load the install's main config.
/// Otherwise treat `config_dir` as the install root directly.
pub fn resolve_invocation(
    config_dir: &Path,
    cli: &Overrides,
    cli_cwd: Option<&str>,
) -> Result<Invocation> {
    let path = config_dir.join("config.toml");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let project: ProjectFile = toml::from_str(&text).unwrap_or_default();

    let Some(install) = project.agentchattr else {
        // Plain main config — config_dir IS the install root.
        let config = load(config_dir, cli)?;
        return Ok(Invocation {
            config,
            install_root: config_dir.to_path_buf(),
            agent_cwd: cli_cwd.map(str::to_string),
        });
    };

    let install_root = anchor_path(&install.root, config_dir);
    let mut o = Overrides::default();
    if let Some(s) = &project.server {
        o.port = s.port;
        if let Some(d) = &s.data_dir {
            o.data_dir = Some(anchor_path(d, config_dir).to_string_lossy().into_owned());
        }
    }
    if let Some(m) = &project.mcp {
        o.mcp_http_port = m.http_port;
        o.mcp_sse_port = m.sse_port;
    }
    // CLI overrides win over the project file.
    if cli.port.is_some() {
        o.port = cli.port;
    }
    if cli.data_dir.is_some() {
        o.data_dir = cli.data_dir.clone();
    }
    if cli.mcp_http_port.is_some() {
        o.mcp_http_port = cli.mcp_http_port;
    }
    if cli.mcp_sse_port.is_some() {
        o.mcp_sse_port = cli.mcp_sse_port;
    }

    let config = load(&install_root, &o)?;
    let agent_cwd = cli_cwd.map(str::to_string).or_else(|| {
        project
            .agent
            .and_then(|a| a.cwd)
            .map(|c| anchor_path(&c, config_dir).to_string_lossy().into_owned())
    });
    Ok(Invocation {
        config,
        install_root,
        agent_cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, body: &str) {
        let mut f = std::fs::File::create(dir.join(name)).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        // Unique-ish per tag; tests don't run Date/random so tag must differ.
        d.push(format!("agentchattr-cfgtest-{tag}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const SAMPLE: &str = r#"
[server]
port = 8300
data_dir = "./data"

[agents.claude]
command = "claude"
cwd = ".."
label = "Claude"

[agents.codex]
command = "codex"
mcp_inject = "proxy_flag"

[agents.minimax]
type = "api"
base_url = "https://example.com/v1"
model = "X"

[routing]
default = "none"
max_agent_hops = 4

[mcp]
http_port = 8200
sse_port = 8201
"#;

    #[test]
    fn parses_agents_and_ports() {
        let d = temp_dir("basic");
        write(&d, "config.toml", SAMPLE);
        let cfg = load(&d, &Overrides::default()).unwrap();
        assert_eq!(cfg.server.port, 8300);
        assert_eq!(cfg.mcp.http_port, 8200);
        assert_eq!(cfg.agents.len(), 3);
        assert_eq!(cfg.agents["claude"].command.as_deref(), Some("claude"));
        assert_eq!(cfg.agents["codex"].mcp_inject.as_deref(), Some("proxy_flag"));
        // API-agent extra fields (base_url/model) are ignored, not an error.
        assert_eq!(cfg.agents["minimax"].kind.as_deref(), Some("api"));
        assert_eq!(cfg.routing.max_agent_hops, Some(4));
    }

    #[test]
    fn local_adds_but_does_not_override() {
        let d = temp_dir("local");
        write(&d, "config.toml", SAMPLE);
        write(
            &d,
            "config.local.toml",
            r#"
[agents.claude]
command = "SHOULD_NOT_WIN"

[agents.local_llm]
command = "llm"
"#,
        );
        let cfg = load(&d, &Overrides::default()).unwrap();
        // existing agent protected
        assert_eq!(cfg.agents["claude"].command.as_deref(), Some("claude"));
        // new local agent added
        assert_eq!(cfg.agents["local_llm"].command.as_deref(), Some("llm"));
    }

    #[test]
    fn cli_override_beats_file() {
        let d = temp_dir("override");
        write(&d, "config.toml", SAMPLE);
        let o = Overrides {
            port: Some(8401),
            mcp_http_port: Some(8211),
            ..Default::default()
        };
        let cfg = load(&d, &o).unwrap();
        assert_eq!(cfg.server.port, 8401);
        assert_eq!(cfg.mcp.http_port, 8211);
        assert_eq!(cfg.mcp.sse_port, 8201); // untouched
    }

    #[test]
    fn data_dir_resolves_against_root_when_relative() {
        let d = temp_dir("datadir");
        write(&d, "config.toml", SAMPLE);
        let cfg = load(&d, &Overrides::default()).unwrap();
        assert_eq!(cfg.data_dir_path(&d), d.join("data"));
    }

    #[test]
    fn missing_sections_use_defaults() {
        let d = temp_dir("defaults");
        write(&d, "config.toml", "[agents.solo]\ncommand = \"solo\"\n");
        let cfg = load(&d, &Overrides::default()).unwrap();
        assert_eq!(cfg.server.port, 8300);
        assert_eq!(cfg.mcp.http_port, 8200);
        assert_eq!(cfg.agents.len(), 1);
    }
}
