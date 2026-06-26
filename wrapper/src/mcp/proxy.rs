//! Per-instance MCP identity proxy (codex `proxy_flag` mode).
//!
//! Sits between the agent CLI and the real agentchattr MCP server, stamping the
//! agent's `sender`/`name` into tool-call arguments and forwarding the bearer
//! token — so codex never needs to know its own identity or auth material.
//!
//! This module has two parts: the pure `inject_sender` transform (here, fully
//! tested) and the HTTP+SSE forwarding server (added on top of it).

use serde_json::Value;

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
        // unchanged → original bytes returned
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
}
