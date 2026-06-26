//! HTTP client for the agentchattr server — the contract documented in
//! docs/NATIVE_WRAPPER_REWRITE.md §4. Blocking calls via ureq; the server is
//! always `http://127.0.0.1:<port>`, so no TLS is pulled in.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::Path;

pub struct ServerClient {
    base: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Registration {
    pub name: String,
    pub token: String,
    #[serde(default)]
    pub slot: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActiveRules {
    #[serde(default)]
    pub epoch: i64,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default = "default_refresh")]
    pub refresh_interval: i64,
}
fn default_refresh() -> i64 {
    10
}

/// Outcome of a heartbeat. The server may rename us (adopt the returned name),
/// or report a 409 conflict (our slot was taken) which the caller resolves by
/// re-registering.
pub enum Heartbeat {
    Ok { name: String },
    Conflict,
}

impl ServerClient {
    pub fn new(port: u16) -> Self {
        Self {
            base: format!("http://127.0.0.1:{port}"),
        }
    }

    fn bearer(token: &str) -> String {
        format!("Bearer {token}")
    }

    /// `POST /api/register {base, label}` → assigned name + token + slot.
    pub fn register(&self, base_agent: &str, label: Option<&str>) -> Result<Registration> {
        let body = serde_json::json!({ "base": base_agent, "label": label });
        let reg = ureq::post(format!("{}/api/register", self.base))
            .send_json(&body)
            .context("register request failed")?
            .body_mut()
            .read_json::<Registration>()
            .context("parsing register response")?;
        Ok(reg)
    }

    /// `POST /api/heartbeat/{name}` (Bearer), optional `{active}` body.
    pub fn heartbeat(&self, name: &str, token: &str, active: Option<bool>) -> Result<Heartbeat> {
        let url = format!("{}/api/heartbeat/{}", self.base, name);
        let req = ureq::post(url).header("Authorization", Self::bearer(token));
        let outcome = match active {
            Some(a) => req.send_json(&serde_json::json!({ "active": a })),
            None => req.send_empty(),
        };
        match outcome {
            Ok(mut resp) => {
                #[derive(Deserialize, Default)]
                struct R {
                    #[serde(default)]
                    name: String,
                }
                let r: R = resp.body_mut().read_json().unwrap_or_default();
                let confirmed = if r.name.is_empty() {
                    name.to_string()
                } else {
                    r.name
                };
                Ok(Heartbeat::Ok { name: confirmed })
            }
            Err(ureq::Error::StatusCode(409)) => Ok(Heartbeat::Conflict),
            Err(e) => Err(anyhow!("heartbeat request failed: {e}")),
        }
    }

    /// `POST /api/deregister/{name}` (Bearer).
    pub fn deregister(&self, name: &str, token: &str) -> Result<()> {
        ureq::post(format!("{}/api/deregister/{}", self.base, name))
            .header("Authorization", Self::bearer(token))
            .send_empty()
            .context("deregister failed")?;
        Ok(())
    }

    /// `GET /api/roles` → this agent's role, if any (unauthenticated endpoint).
    pub fn role(&self, name: &str) -> Option<String> {
        let roles: std::collections::BTreeMap<String, String> =
            ureq::get(format!("{}/api/roles", self.base))
                .call()
                .ok()?
                .body_mut()
                .read_json()
                .ok()?;
        roles.get(name).filter(|s| !s.is_empty()).cloned()
    }

    /// `GET /api/rules/active` (Bearer) → active rules + epoch + refresh interval.
    pub fn active_rules(&self, token: &str) -> Option<ActiveRules> {
        ureq::get(format!("{}/api/rules/active", self.base))
            .header("Authorization", Self::bearer(token))
            .call()
            .ok()?
            .body_mut()
            .read_json()
            .ok()
    }

    /// `POST /api/rules/agent_sync/{name}` (Bearer) — mark rules seen at `epoch`.
    pub fn report_rule_sync(&self, name: &str, epoch: i64, token: &str) {
        let _ = ureq::post(format!("{}/api/rules/agent_sync/{}", self.base, name))
            .header("Authorization", Self::bearer(token))
            .send_json(&serde_json::json!({ "epoch": epoch }));
    }

    /// Is the server listening? Cheap probe (used by auto-start in M6).
    pub fn is_up(&self) -> bool {
        ureq::get(format!("{}/api/roles", self.base)).call().is_ok()
    }
}

/// Write the recovery flag file the server watches (`data/{name}_recovered`).
pub fn write_recovery_flag(data_dir: &Path, name: &str) {
    let _ = std::fs::write(data_dir.join(format!("{name}_recovered")), name);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_localhost_base() {
        let c = ServerClient::new(8401);
        assert_eq!(c.base, "http://127.0.0.1:8401");
    }

    #[test]
    fn is_up_false_for_closed_port() {
        // Port 9 (discard) is essentially never an HTTP server; the probe must
        // fail fast and report down rather than hang or panic.
        let c = ServerClient::new(9);
        assert!(!c.is_up());
    }
}
