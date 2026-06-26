//! Per-instance MCP identity proxy (codex `proxy_flag` mode).
//!
//! Sits between the agent CLI and the real agentchattr MCP server, stamping the
//! agent's `sender`/`name` into tool-call arguments and forwarding the bearer
//! token — so codex never needs to know its own identity or auth material.
//!
//! Two parts: the pure `inject_sender` transform (fully tested) and an HTTP+SSE
//! forwarding server built on top of it.

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

/// Client request headers we never forward (ureq sets its own; we also avoid
/// asking for an encoding we can't decode without extra features).
const SKIP_REQ_HEADERS: &[&str] = &["host", "content-length", "connection", "accept-encoding"];
/// Response headers worth relaying back to the agent.
const RELAY_RESP_HEADERS: &[&str] = &[
    "content-type",
    "mcp-session-id",
    "cache-control",
    "x-accel-buffering",
];

struct Identity {
    name: String,
    token: String,
}

struct ProxyState {
    upstream_base: String,
    upstream_port: u16,
    identity: Mutex<Identity>,
    local_port: AtomicU16,
}

/// Local identity proxy: forwards MCP traffic to the upstream server, stamping
/// the agent's identity into tool calls and attaching the bearer token.
pub struct McpProxy {
    state: Arc<ProxyState>,
}

impl McpProxy {
    /// `upstream_base` is e.g. `http://127.0.0.1:8200`; `upstream_port` is that
    /// port (used to rewrite SSE endpoint URLs back through the proxy).
    pub fn new(upstream_base: &str, upstream_port: u16, name: &str, token: &str) -> Self {
        Self {
            state: Arc::new(ProxyState {
                upstream_base: upstream_base.trim_end_matches('/').to_string(),
                upstream_port,
                identity: Mutex::new(Identity {
                    name: name.to_string(),
                    token: token.to_string(),
                }),
                local_port: AtomicU16::new(0),
            }),
        }
    }

    /// Bind a local port and spawn the accept loop. Returns the bound port.
    pub fn start(&self) -> Result<u16> {
        let server = tiny_http::Server::http(("127.0.0.1", 0))
            .map_err(|e| anyhow!("proxy bind failed: {e}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| anyhow!("proxy: no bound IP port"))?;
        self.state.local_port.store(port, Ordering::SeqCst);

        let state = Arc::clone(&self.state);
        std::thread::Builder::new()
            .name("mcp-proxy".into())
            .spawn(move || {
                for request in server.incoming_requests() {
                    let st = Arc::clone(&state);
                    // One thread per request so a long-lived SSE GET doesn't
                    // block concurrent POSTs.
                    let _ = std::thread::Builder::new()
                        .name("mcp-proxy-req".into())
                        .spawn(move || handle(st, request));
                }
            })?;
        Ok(port)
    }

    /// Proxy base URL the agent connects to (no path).
    pub fn url(&self) -> String {
        format!(
            "http://127.0.0.1:{}",
            self.state.local_port.load(Ordering::SeqCst)
        )
    }

    /// Update identity after a rename / token refresh.
    pub fn set_identity(&self, name: &str, token: &str) {
        let mut id = self.state.identity.lock().unwrap();
        id.name = name.to_string();
        id.token = token.to_string();
    }
}

fn handle(state: Arc<ProxyState>, request: tiny_http::Request) {
    let url = request.url().to_string();
    let upstream_url = format!("{}{}", state.upstream_base, url);
    let (name, token) = {
        let id = state.identity.lock().unwrap();
        (id.name.clone(), id.token.clone())
    };

    let method = request.method().clone();
    let result = match method {
        tiny_http::Method::Post => forward_post(&state, request, &upstream_url, &name, &token),
        tiny_http::Method::Get => forward_get(&state, request, &upstream_url, &token),
        tiny_http::Method::Delete => forward_delete(request, &upstream_url, &token),
        _ => request
            .respond(tiny_http::Response::empty(405))
            .map_err(|e| anyhow!("{e}")),
    };
    if let Err(e) = result {
        eprintln!("  [proxy] {e}");
    }
}

fn forward_post(
    state: &ProxyState,
    mut request: tiny_http::Request,
    upstream_url: &str,
    name: &str,
    token: &str,
) -> Result<()> {
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body)?;
    let body = inject_sender(&body, name);

    let mut builder = ureq::post(upstream_url);
    for h in request.headers() {
        let field = h.field.as_str().as_str().to_ascii_lowercase();
        if !SKIP_REQ_HEADERS.contains(&field.as_str()) {
            builder = builder.header(h.field.as_str().as_str(), h.value.as_str());
        }
    }
    builder = builder
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Agent-Token", token);

    let _ = state; // (kept for symmetry with forward_get)
    match builder.send(&body) {
        Ok(mut resp) => {
            let status = resp.status().as_u16();
            let headers = relay_headers(&resp);
            let rbody = resp.body_mut().read_to_vec().unwrap_or_default();
            let mut out = tiny_http::Response::from_data(rbody).with_status_code(status);
            for h in headers {
                out.add_header(h);
            }
            request.respond(out).map_err(|e| anyhow!("{e}"))
        }
        Err(ureq::Error::StatusCode(code)) => request
            .respond(tiny_http::Response::empty(code))
            .map_err(|e| anyhow!("{e}")),
        Err(e) => Err(anyhow!("upstream POST failed: {e}")),
    }
}

fn forward_get(
    state: &ProxyState,
    request: tiny_http::Request,
    upstream_url: &str,
    token: &str,
) -> Result<()> {
    let mut builder = ureq::get(upstream_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Agent-Token", token);
    for h in request.headers() {
        let field = h.field.as_str().as_str().to_ascii_lowercase();
        if !SKIP_REQ_HEADERS.contains(&field.as_str()) {
            builder = builder.header(h.field.as_str().as_str(), h.value.as_str());
        }
    }

    match builder.call() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let headers = relay_headers(&resp);
            let local_port = state.local_port.load(Ordering::SeqCst);
            let reader = SseRewriteReader::new(
                resp.into_body().into_reader(),
                state.upstream_port,
                local_port,
            );
            let out = tiny_http::Response::new(tiny_http::StatusCode(status), headers, reader, None, None);
            request.respond(out).map_err(|e| anyhow!("{e}"))
        }
        Err(ureq::Error::StatusCode(code)) => request
            .respond(tiny_http::Response::empty(code))
            .map_err(|e| anyhow!("{e}")),
        Err(e) => Err(anyhow!("upstream GET failed: {e}")),
    }
}

fn forward_delete(request: tiny_http::Request, upstream_url: &str, token: &str) -> Result<()> {
    let mut builder = ureq::delete(upstream_url)
        .header("Authorization", format!("Bearer {token}"))
        .header("X-Agent-Token", token);
    if let Some(sid) = header_value(request.headers(), "mcp-session-id") {
        builder = builder.header("Mcp-Session-Id", sid);
    }
    let code = match builder.call() {
        Ok(resp) => resp.status().as_u16(),
        Err(ureq::Error::StatusCode(c)) => c,
        Err(_) => 502,
    };
    request
        .respond(tiny_http::Response::empty(code))
        .map_err(|e| anyhow!("{e}"))
}

/// Collect the relay-list headers from an upstream response into tiny_http headers.
fn relay_headers(resp: &ureq::http::Response<ureq::Body>) -> Vec<tiny_http::Header> {
    let mut out = Vec::new();
    for name in RELAY_RESP_HEADERS {
        if let Some(v) = resp.headers().get(*name) {
            if let Ok(val) = v.to_str() {
                if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), val.as_bytes()) {
                    out.push(h);
                }
            }
        }
    }
    out
}

fn header_value(headers: &[tiny_http::Header], field: &str) -> Option<String> {
    headers
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(field))
        .map(|h| h.value.as_str().to_string())
}

/// A `Read` adapter that rewrites SSE `data: http://127.0.0.1:<up>/` endpoint
/// URLs to point back at the proxy port, line by line.
struct SseRewriteReader<R: Read> {
    inner: BufReader<R>,
    from: String,
    to: String,
    pending: Vec<u8>,
    pos: usize,
}

impl<R: Read> SseRewriteReader<R> {
    fn new(inner: R, upstream_port: u16, local_port: u16) -> Self {
        Self {
            inner: BufReader::new(inner),
            from: format!("http://127.0.0.1:{upstream_port}/"),
            to: format!("http://127.0.0.1:{local_port}/"),
            pending: Vec::new(),
            pos: 0,
        }
    }
}

impl<R: Read> Read for SseRewriteReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.pending.len() {
            let mut line = String::new();
            let n = self.inner.read_line(&mut line)?;
            if n == 0 {
                return Ok(0);
            }
            let rewritten = if line.starts_with("data:") {
                line.replace(&self.from, &self.to)
            } else {
                line
            };
            self.pending = rewritten.into_bytes();
            self.pos = 0;
        }
        let avail = &self.pending[self.pos..];
        let k = avail.len().min(out.len());
        out[..k].copy_from_slice(&avail[..k]);
        self.pos += k;
        Ok(k)
    }
}

/// MCP tools and which argument carries the agent identity. `None` means the
/// tool takes no sender argument; tools absent from this list are left untouched.
fn sender_param(tool: &str) -> Option<Option<&'static str>> {
    match tool {
        "chat_send" => Some(Some("sender")),
        "chat_read" => Some(Some("sender")),
        "chat_resync" => Some(Some("sender")),
        "chat_join" => Some(Some("name")),
        "chat_who" => Some(None),
        "chat_decision" => Some(Some("sender")),
        "chat_channels" => Some(None),
        "chat_set_hat" => Some(Some("sender")),
        "chat_claim" => Some(Some("sender")),
        _ => None,
    }
}

/// Parse a JSON-RPC request body and stamp `agent_name` into the identity
/// argument of any `tools/call`. Returns the (possibly rewritten) body; the
/// original bytes are returned unchanged if nothing needed stamping or the body
/// is not JSON. Handles both single requests and batches.
pub fn inject_sender(raw: &[u8], agent_name: &str) -> Vec<u8> {
    if raw.is_empty() {
        return raw.to_vec();
    }
    let Ok(mut data) = serde_json::from_slice::<Value>(raw) else {
        return raw.to_vec();
    };

    let mut modified = false;
    match &mut data {
        Value::Array(items) => {
            for msg in items.iter_mut() {
                modified |= stamp_message(msg, agent_name);
            }
        }
        other => {
            modified |= stamp_message(other, agent_name);
        }
    }

    if modified {
        serde_json::to_vec(&data).unwrap_or_else(|_| raw.to_vec())
    } else {
        raw.to_vec()
    }
}

/// Stamp one JSON-RPC message in place; returns true if it was changed.
fn stamp_message(msg: &mut Value, agent_name: &str) -> bool {
    let Some(obj) = msg.as_object_mut() else {
        return false;
    };
    if obj.get("method").and_then(Value::as_str) != Some("tools/call") {
        return false;
    }
    let Some(params) = obj.get_mut("params").and_then(Value::as_object_mut) else {
        return false;
    };
    let tool = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let sender_key = match sender_param(&tool) {
        Some(Some(key)) => key,
        _ => return false, // tool unknown or takes no sender
    };
    let args = params
        .entry("arguments")
        .or_insert_with(|| Value::Object(Default::default()));
    let Some(args_obj) = args.as_object_mut() else {
        return false;
    };
    let current = args_obj.get(sender_key).and_then(Value::as_str);
    if current == Some(agent_name) {
        return false;
    }
    args_obj.insert(sender_key.to_string(), Value::String(agent_name.to_string()));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stamp(body: Value, name: &str) -> Value {
        let out = inject_sender(body.to_string().as_bytes(), name);
        serde_json::from_slice(&out).unwrap()
    }

    #[test]
    fn stamps_missing_sender() {
        let out = stamp(
            json!({"method":"tools/call","params":{"name":"chat_send","arguments":{"message":"hi"}}}),
            "codex-prime",
        );
        assert_eq!(out["params"]["arguments"]["sender"], "codex-prime");
        assert_eq!(out["params"]["arguments"]["message"], "hi");
    }

    #[test]
    fn overrides_wrong_sender() {
        let out = stamp(
            json!({"method":"tools/call","params":{"name":"chat_send","arguments":{"sender":"someone_else"}}}),
            "codex-prime",
        );
        assert_eq!(out["params"]["arguments"]["sender"], "codex-prime");
    }

    #[test]
    fn uses_name_key_for_chat_join() {
        let out = stamp(
            json!({"method":"tools/call","params":{"name":"chat_join","arguments":{}}}),
            "codex-prime",
        );
        assert_eq!(out["params"]["arguments"]["name"], "codex-prime");
    }

    #[test]
    fn leaves_no_sender_tools_untouched() {
        let body = json!({"method":"tools/call","params":{"name":"chat_who","arguments":{}}});
        let out = inject_sender(body.to_string().as_bytes(), "codex-prime");
        assert_eq!(out, body.to_string().as_bytes());
    }

    #[test]
    fn ignores_non_tool_calls() {
        let body = json!({"method":"initialize","params":{}});
        let out = inject_sender(body.to_string().as_bytes(), "codex-prime");
        assert_eq!(out, body.to_string().as_bytes());
    }

    #[test]
    fn handles_batch() {
        let out = stamp(
            json!([
                {"method":"tools/call","params":{"name":"chat_send","arguments":{}}},
                {"method":"tools/call","params":{"name":"chat_read","arguments":{}}}
            ]),
            "agent7",
        );
        assert_eq!(out[0]["params"]["arguments"]["sender"], "agent7");
        assert_eq!(out[1]["params"]["arguments"]["sender"], "agent7");
    }

    #[test]
    fn non_json_passthrough() {
        let raw = b"not json at all";
        assert_eq!(inject_sender(raw, "x"), raw);
    }

    #[test]
    fn proxy_binds_and_reports_url() {
        let p = McpProxy::new("http://127.0.0.1:8200", 8200, "codex", "tok");
        let port = p.start().expect("proxy should bind");
        assert!(port > 0);
        assert_eq!(p.url(), format!("http://127.0.0.1:{port}"));
        p.set_identity("codex-2", "tok2"); // must not panic
    }
}
