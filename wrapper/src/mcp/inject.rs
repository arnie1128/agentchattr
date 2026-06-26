//! MCP config injection — the five modes from `_apply_mcp_inject` (wrapper.py).
//!
//! Resolution order: explicit `agents.<x>.mcp_*` keys > built-in default for the
//! agent > none. Each mode either writes a config file, sets an env var, or adds
//! launch flags so the agent CLI reaches the agentchattr MCP server with bearer
//! auth.

use crate::config::AgentCfg;
use anyhow::{bail, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SERVER_NAME: &str = "agentchattr";

/// What the launcher needs after injection.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct InjectResult {
    pub launch_args: Vec<String>,
    pub inject_env: BTreeMap<String, String>,
    pub settings_path: Option<PathBuf>,
}

/// Resolved injection config (built-in default merged with explicit overrides).
#[derive(Debug, Clone)]
struct Resolved {
    mode: String,
    flag: String,
    transport: String,
    settings_path: Option<String>,
    env_var: Option<String>,
    http_key: String,
    proxy_flag_template: String,
    merge_project: bool,
}

impl Default for Resolved {
    fn default() -> Self {
        Self {
            mode: String::new(),
            flag: "--mcp-config".to_string(),
            transport: "http".to_string(),
            settings_path: None,
            env_var: None,
            http_key: "httpUrl".to_string(),
            proxy_flag_template: "-c mcp_servers.{server}.url=\"{url}\"".to_string(),
            merge_project: false,
        }
    }
}

/// Built-in defaults, mirroring `_BUILTIN_DEFAULTS`.
fn builtin_default(agent: &str) -> Option<Resolved> {
    let base = Resolved::default();
    match agent {
        "claude" => Some(Resolved {
            mode: "flag".into(),
            flag: "--mcp-config".into(),
            merge_project: true,
            ..base
        }),
        "gemini" => Some(Resolved {
            mode: "env".into(),
            env_var: Some("GEMINI_CLI_SYSTEM_SETTINGS_PATH".into()),
            merge_project: true,
            ..base
        }),
        "codex" => Some(Resolved {
            mode: "proxy_flag".into(),
            ..base
        }),
        "kimi" => Some(Resolved {
            mode: "flag".into(),
            flag: "--mcp-config-file".into(),
            merge_project: true,
            ..base
        }),
        "kilo" => Some(Resolved {
            mode: "env_content".into(),
            env_var: Some("KILO_CONFIG_CONTENT".into()),
            ..base
        }),
        _ => None,
    }
}

/// Resolve injection config: explicit `mcp_inject` in agent_cfg wins; otherwise
/// the built-in default, with any `mcp_*` overrides from agent_cfg applied.
fn resolve(agent: &str, cfg: &AgentCfg) -> Option<Resolved> {
    let mut r = if cfg.mcp_inject.is_some() {
        Resolved {
            mode: cfg.mcp_inject.clone().unwrap(),
            ..Resolved::default()
        }
    } else {
        builtin_default(agent)?
    };
    // Apply explicit overrides.
    if let Some(v) = &cfg.mcp_flag {
        r.flag = v.clone();
    }
    if let Some(v) = &cfg.mcp_transport {
        r.transport = v.clone();
    }
    if let Some(v) = &cfg.mcp_settings_path {
        r.settings_path = Some(v.clone());
    }
    if let Some(v) = &cfg.mcp_env_var {
        r.env_var = Some(v.clone());
    }
    if let Some(v) = &cfg.mcp_http_key {
        r.http_key = v.clone();
    }
    if let Some(v) = &cfg.mcp_proxy_flag_template {
        r.proxy_flag_template = v.clone();
    }
    if let Some(v) = cfg.mcp_merge_project {
        r.merge_project = v;
    }
    Some(r)
}

fn server_url(http_port: u16, sse_port: u16, transport: &str) -> String {
    if transport == "sse" {
        format!("http://127.0.0.1:{sse_port}/sse")
    } else {
        format!("http://127.0.0.1:{http_port}/mcp")
    }
}

/// Apply MCP injection for an agent. `proxy_url` is the local proxy URL (only
/// used by `proxy_flag`). Returns launch args + env to propagate + the written
/// settings path (if any).
#[allow(clippy::too_many_arguments)]
pub fn apply(
    agent: &str,
    cfg: &AgentCfg,
    instance_name: &str,
    data_dir: &Path,
    proxy_url: Option<&str>,
    token: &str,
    http_port: u16,
    sse_port: u16,
    project_dir: &Path,
) -> Result<InjectResult> {
    let Some(r) = resolve(agent, cfg) else {
        return Ok(InjectResult::default());
    };
    let url = server_url(http_port, sse_port, &r.transport);
    let config_dir = data_dir.join("provider-config");
    let mut out = InjectResult::default();

    match r.mode.as_str() {
        "flag" => {
            let project_servers = if r.merge_project {
                read_project_servers(project_dir)
            } else {
                Map::new()
            };
            let path = config_dir.join(format!("{instance_name}-mcp.json"));
            write_claude_config(&path, &url, token, project_servers)?;
            out.launch_args = vec![r.flag.clone(), path.to_string_lossy().into_owned()];
            out.settings_path = Some(path);
        }
        "env" => {
            let env_var = r
                .env_var
                .clone()
                .ok_or_else(|| anyhow::anyhow!("mcp_inject = 'env' requires mcp_env_var"))?;
            let path = config_dir.join(format!("{instance_name}-settings.json"));
            write_settings_json(&path, &url, &r.transport, token, &r.http_key)?;
            if r.merge_project {
                merge_project_into_settings(&path, project_dir, &r.http_key);
            }
            out.inject_env
                .insert(env_var, path.to_string_lossy().into_owned());
            out.settings_path = Some(path);
        }
        "settings_file" => {
            let raw = r.settings_path.clone().ok_or_else(|| {
                anyhow::anyhow!("mcp_inject = 'settings_file' requires mcp_settings_path")
            })?;
            let target = resolve_settings_path(&raw, project_dir);
            write_settings_json(&target, &url, &r.transport, token, &r.http_key)?;
            if let Some(env_var) = &r.env_var {
                out.inject_env
                    .insert(env_var.clone(), target.to_string_lossy().into_owned());
            }
            out.settings_path = Some(target);
        }
        "env_content" => {
            let env_var = r
                .env_var
                .clone()
                .ok_or_else(|| anyhow::anyhow!("mcp_inject = 'env_content' requires mcp_env_var"))?;
            let mut entry = json!({ "type": "remote", "url": url, "enabled": true });
            if !token.is_empty() {
                entry["headers"] = json!({ "Authorization": format!("Bearer {token}") });
            }
            let payload = json!({ "mcp": { SERVER_NAME: entry } });
            out.inject_env.insert(env_var, payload.to_string());
        }
        "proxy_flag" => {
            let expanded = r
                .proxy_flag_template
                .replace("{server}", SERVER_NAME)
                .replace("{url}", proxy_url.unwrap_or(""));
            out.launch_args = expanded.split_whitespace().map(str::to_string).collect();
        }
        other => bail!("unknown mcp_inject mode '{other}' for agent '{agent}'"),
    }
    Ok(out)
}

/// Read existing MCP servers from a project's `.mcp.json`, dropping any
/// `agentchattr` entry (we add our own authenticated one).
fn read_project_servers(project_dir: &Path) -> Map<String, Value> {
    let path = project_dir.join(".mcp.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Map::new();
    };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&text) else {
        return Map::new();
    };
    match root.get("mcpServers") {
        Some(Value::Object(servers)) => {
            let mut m = servers.clone();
            m.remove(SERVER_NAME);
            m
        }
        _ => Map::new(),
    }
}

/// Write a Claude-style `--mcp-config` file: project servers + an agentchattr
/// entry with bearer auth.
fn write_claude_config(
    path: &Path,
    url: &str,
    token: &str,
    project_servers: Map<String, Value>,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut servers = project_servers;
    let mut entry = json!({ "type": "http", "url": url });
    if !token.is_empty() {
        entry["headers"] = json!({ "Authorization": format!("Bearer {token}") });
    }
    servers.insert(SERVER_NAME.to_string(), entry);
    let payload = json!({ "mcpServers": Value::Object(servers) });
    std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(&payload)?))?;
    Ok(())
}

/// Write/merge a settings-style JSON file: preserve existing servers, set the
/// agentchattr entry, and enable folder trust. `http_key` is "httpUrl"
/// (Gemini/Qwen) or "url" (standard MCP).
fn write_settings_json(
    path: &Path,
    url: &str,
    transport: &str,
    token: &str,
    http_key: &str,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut root: Map<String, Value> = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let mut servers = match root.get("mcpServers") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };

    let mut entry = Map::new();
    if transport == "http" || transport == "streamable-http" {
        entry.insert("type".into(), json!("http"));
        entry.insert(http_key.to_string(), json!(url));
    } else {
        entry.insert("type".into(), json!(transport));
        entry.insert("url".into(), json!(url));
    }
    entry.insert("trust".into(), json!(true));
    if !token.is_empty() {
        entry.insert(
            "headers".into(),
            json!({ "Authorization": format!("Bearer {token}") }),
        );
    }
    servers.insert(SERVER_NAME.to_string(), Value::Object(entry));
    root.insert("mcpServers".into(), Value::Object(servers));

    // Enable folder trust (Gemini respects this).
    let mut security = match root.get("security") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    let mut folder_trust = match security.get("folderTrust") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    folder_trust.insert("enabled".into(), json!(true));
    security.insert("folderTrust".into(), Value::Object(folder_trust));
    root.insert("security".into(), Value::Object(security));

    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&Value::Object(root))?),
    )?;
    Ok(())
}

/// Merge a project's `.mcp.json` servers into an already-written settings file,
/// normalising the URL key for providers expecting `httpUrl`.
fn merge_project_into_settings(settings_path: &Path, project_dir: &Path, http_key: &str) {
    let project_servers = read_project_servers(project_dir);
    if project_servers.is_empty() {
        return;
    }
    let Ok(text) = std::fs::read_to_string(settings_path) else {
        return;
    };
    let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let mut servers = match root.get("mcpServers") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    for (name, cfg) in project_servers {
        if servers.contains_key(&name) {
            continue;
        }
        let mut entry = match cfg {
            Value::Object(m) => m,
            _ => continue,
        };
        let srv_type = entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("http")
            .to_string();
        if (srv_type == "http" || srv_type == "streamable-http") && http_key != "url" {
            if let Some(u) = entry.remove("url") {
                entry.entry(http_key.to_string()).or_insert(u);
            }
        }
        entry.entry("trust".to_string()).or_insert(json!(true));
        servers.insert(name, Value::Object(entry));
    }
    root.insert("mcpServers".into(), Value::Object(servers));
    let _ = std::fs::write(
        settings_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&Value::Object(root)).unwrap_or_default()
        ),
    );
}

/// Resolve a settings path: expand a leading `~`, then anchor relative paths at
/// `project_dir`.
fn resolve_settings_path(raw: &str, project_dir: &Path) -> PathBuf {
    let expanded = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            home.join(rest)
        } else {
            PathBuf::from(raw)
        }
    } else {
        PathBuf::from(raw)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        project_dir.join(expanded)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(mcp_inject: Option<&str>) -> AgentCfg {
        AgentCfg {
            mcp_inject: mcp_inject.map(str::to_string),
            ..Default::default()
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("agentchattr-mcptest-{tag}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read_json(p: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn claude_flag_writes_bearer_config() {
        let d = temp("claude");
        let out = apply("claude", &agent(None), "claude", &d, None, "TOK", 8200, 8201, &d).unwrap();
        assert_eq!(out.launch_args[0], "--mcp-config");
        let path = PathBuf::from(&out.launch_args[1]);
        let v = read_json(&path);
        let entry = &v["mcpServers"]["agentchattr"];
        assert_eq!(entry["type"], "http");
        assert_eq!(entry["url"], "http://127.0.0.1:8200/mcp");
        assert_eq!(entry["headers"]["Authorization"], "Bearer TOK");
    }

    #[test]
    fn claude_flag_merges_project_servers() {
        let d = temp("claude-merge");
        std::fs::write(
            d.join(".mcp.json"),
            r#"{"mcpServers":{"unity":{"type":"http","url":"http://x"},"agentchattr":{"stale":true}}}"#,
        )
        .unwrap();
        let out = apply("claude", &agent(None), "claude", &d, None, "TOK", 8200, 8201, &d).unwrap();
        let v = read_json(&PathBuf::from(&out.launch_args[1]));
        // project server preserved
        assert_eq!(v["mcpServers"]["unity"]["url"], "http://x");
        // our agentchattr entry replaces the stale one
        assert_eq!(v["mcpServers"]["agentchattr"]["headers"]["Authorization"], "Bearer TOK");
        assert!(v["mcpServers"]["agentchattr"].get("stale").is_none());
    }

    #[test]
    fn gemini_env_sets_var_and_trust() {
        let d = temp("gemini");
        let out = apply("gemini", &agent(None), "gemini", &d, None, "TOK", 8200, 8201, &d).unwrap();
        let path = out.inject_env.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH").unwrap();
        let v = read_json(Path::new(path));
        // Gemini uses httpUrl, trust, and folderTrust.enabled
        assert_eq!(v["mcpServers"]["agentchattr"]["httpUrl"], "http://127.0.0.1:8200/mcp");
        assert_eq!(v["mcpServers"]["agentchattr"]["trust"], true);
        assert_eq!(v["security"]["folderTrust"]["enabled"], true);
    }

    #[test]
    fn settings_file_uses_url_key_when_configured() {
        let d = temp("codebuddy");
        let mut cfg = agent(Some("settings_file"));
        cfg.mcp_settings_path = Some("cb/.mcp.json".into());
        cfg.mcp_http_key = Some("url".into());
        let out = apply("codebuddy", &cfg, "codebuddy", &d, None, "TOK", 8200, 8201, &d).unwrap();
        let v = read_json(out.settings_path.as_ref().unwrap());
        assert_eq!(v["mcpServers"]["agentchattr"]["url"], "http://127.0.0.1:8200/mcp");
    }

    #[test]
    fn kilo_env_content_is_json_string() {
        let d = temp("kilo");
        let out = apply("kilo", &agent(None), "kilo", &d, None, "TOK", 8200, 8201, &d).unwrap();
        let raw = out.inject_env.get("KILO_CONFIG_CONTENT").unwrap();
        let v: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(v["mcp"]["agentchattr"]["type"], "remote");
        assert_eq!(v["mcp"]["agentchattr"]["enabled"], true);
        assert_eq!(v["mcp"]["agentchattr"]["headers"]["Authorization"], "Bearer TOK");
    }

    #[test]
    fn codex_proxy_flag_expands_template() {
        let d = temp("codex");
        let out = apply(
            "codex",
            &agent(None),
            "codex",
            &d,
            Some("http://127.0.0.1:54321/mcp"),
            "TOK",
            8200,
            8201,
            &d,
        )
        .unwrap();
        assert_eq!(out.launch_args[0], "-c");
        assert_eq!(
            out.launch_args[1],
            "mcp_servers.agentchattr.url=\"http://127.0.0.1:54321/mcp\""
        );
    }

    #[test]
    fn unknown_agent_no_inject() {
        let d = temp("unknown");
        let out = apply("mystery", &agent(None), "mystery", &d, None, "TOK", 8200, 8201, &d).unwrap();
        assert_eq!(out, InjectResult::default());
    }
}
