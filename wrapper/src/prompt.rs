//! Prompt construction for queue triggers — the pure, testable core of the
//! queue watcher. Mirrors the prompt logic in `_queue_watcher` (wrapper.py).

use serde_json::Value;

/// Appended on the first mention of a multi-instance session.
pub const IDENTITY_HINT: &str = " (If this is a multi-instance session, reclaim \
your previous identity from your context window, NOT from the chat history \
before responding. If you didn't have one, tell the user to give you a name by \
clicking your status pill at the top.)";

/// A parsed trigger drained from the queue file.
#[derive(Debug, Clone, PartialEq)]
pub struct Trigger {
    pub channel: String,
    pub job_id: Option<String>,
    pub custom_prompt: Option<String>,
}

fn json_scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Parse drained queue lines into a single trigger, or `None` if no line was a
/// valid JSON object. Later lines override earlier ones for channel/job/prompt,
/// matching the Python (last value wins).
pub fn parse_trigger(lines: &[String]) -> Option<Trigger> {
    let mut seen = false;
    let mut channel = "general".to_string();
    let mut job_id = None;
    let mut custom_prompt = None;

    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        seen = true;
        if let Some(c) = v.get("channel").and_then(Value::as_str) {
            channel = c.to_string();
        }
        if let Some(j) = v.get("job_id").and_then(json_scalar) {
            job_id = Some(j);
        }
        if let Some(p) = v.get("prompt").and_then(Value::as_str) {
            if !p.trim().is_empty() {
                custom_prompt = Some(p.trim().to_string());
            }
        }
    }

    seen.then_some(Trigger {
        channel,
        job_id,
        custom_prompt,
    })
}

/// The base instruction before role/rules are appended.
pub fn base_prompt(t: &Trigger) -> String {
    if let Some(p) = &t.custom_prompt {
        p.clone()
    } else if let Some(j) = &t.job_id {
        format!(
            "use mcp to read job_id={j} - you're mentioned in a job thread, take appropriate action and respond"
        )
    } else {
        format!(
            "use mcp to read #{} - you're mentioned, take appropriate action and respond",
            t.channel
        )
    }
}

/// Append ROLE / RULES / identity hint to a base prompt. The result still
/// contains newlines; callers flatten them to spaces before injecting (multi-
/// line input triggers paste detection in some CLIs).
pub fn assemble(
    base: String,
    role: Option<&str>,
    rules: Option<&[String]>,
    identity_hint: bool,
) -> String {
    let mut p = base;
    if let Some(r) = role {
        if !r.is_empty() {
            p.push_str(&format!("\n\nROLE: {r}"));
        }
    }
    if let Some(rs) = rules {
        if !rs.is_empty() {
            p.push_str(&format!("\n\nRULES:\n{}", rs.join("; ")));
        }
    }
    if identity_hint {
        p.push_str(IDENTITY_HINT);
    }
    p
}

/// Flatten a multi-line prompt to a single line for injection.
pub fn flatten(p: &str) -> String {
    p.replace('\n', " ")
}

/// Whether to (re)inject rules on this trigger: cold start, epoch change, or
/// every `refresh_interval` triggers. Mirrors the Python smart-injection logic.
pub fn should_inject_rules(
    last_epoch: i64,
    current_epoch: i64,
    trigger_count: u64,
    refresh_interval: i64,
) -> bool {
    last_epoch == 0
        || current_epoch != last_epoch
        || (refresh_interval > 0 && trigger_count % (refresh_interval as u64) == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_channel_trigger() {
        let t = parse_trigger(&lines(&[r#"{"channel": "design"}"#])).unwrap();
        assert_eq!(t.channel, "design");
        assert!(t.job_id.is_none());
        assert!(t.custom_prompt.is_none());
        assert_eq!(
            base_prompt(&t),
            "use mcp to read #design - you're mentioned, take appropriate action and respond"
        );
    }

    #[test]
    fn defaults_channel_to_general() {
        let t = parse_trigger(&lines(&[r#"{"foo": 1}"#])).unwrap();
        assert_eq!(t.channel, "general");
    }

    #[test]
    fn job_id_number_or_string() {
        let t = parse_trigger(&lines(&[r#"{"job_id": 42}"#])).unwrap();
        assert_eq!(t.job_id.as_deref(), Some("42"));
        assert!(base_prompt(&t).contains("job_id=42"));

        let t2 = parse_trigger(&lines(&[r#"{"job_id": "abc"}"#])).unwrap();
        assert_eq!(t2.job_id.as_deref(), Some("abc"));
    }

    #[test]
    fn custom_prompt_wins() {
        let t = parse_trigger(&lines(&[r#"{"channel": "x", "prompt": "  do the thing  "}"#])).unwrap();
        assert_eq!(t.custom_prompt.as_deref(), Some("do the thing"));
        assert_eq!(base_prompt(&t), "do the thing");
    }

    #[test]
    fn ignores_blank_and_invalid_lines() {
        assert!(parse_trigger(&lines(&["", "   ", "not json"])).is_none());
        // a valid line among junk still triggers
        let t = parse_trigger(&lines(&["junk", r#"{"channel":"c"}"#, ""])).unwrap();
        assert_eq!(t.channel, "c");
    }

    #[test]
    fn assemble_appends_role_and_rules() {
        let base = "BASE".to_string();
        let rules = vec!["r1".to_string(), "r2".to_string()];
        let out = assemble(base, Some("reviewer"), Some(&rules), false);
        assert!(out.contains("BASE"));
        assert!(out.contains("ROLE: reviewer"));
        assert!(out.contains("RULES:\nr1; r2"));
    }

    #[test]
    fn assemble_skips_empty_role_and_rules() {
        let out = assemble("BASE".to_string(), Some(""), Some(&[]), false);
        assert_eq!(out, "BASE");
    }

    #[test]
    fn identity_hint_appended_when_flagged() {
        let out = assemble("BASE".to_string(), None, None, true);
        assert!(out.contains("multi-instance"));
    }

    #[test]
    fn flatten_removes_newlines() {
        assert_eq!(flatten("a\nb\nc"), "a b c");
    }

    #[test]
    fn rules_injection_decision() {
        // cold start
        assert!(should_inject_rules(0, 5, 1, 10));
        // epoch change
        assert!(should_inject_rules(4, 5, 3, 10));
        // periodic refresh
        assert!(should_inject_rules(5, 5, 10, 10));
        // no change, not at interval
        assert!(!should_inject_rules(5, 5, 3, 10));
        // refresh disabled
        assert!(!should_inject_rules(5, 5, 100, 0));
    }
}
