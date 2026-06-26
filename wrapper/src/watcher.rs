//! Queue watcher: polls `{name}_queue.jsonl`, builds the inject prompt (base +
//! role + smart rules + identity hint), and injects it. Mirrors `_queue_watcher`
//! (wrapper.py). The pure prompt logic lives in `prompt.rs`; this module owns
//! the stateful polling loop and the server lookups.

use crate::prompt;
use crate::server::ServerClient;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Drain a queue file: read all lines, truncate it, return the lines. Empty if
/// the file is missing or zero-length.
pub fn drain_queue(path: &Path) -> Vec<String> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > 0 => {}
        _ => return Vec::new(),
    }
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let _ = std::fs::write(path, ""); // truncate so lines aren't re-processed
    content.lines().map(str::to_string).collect()
}

/// Stateful prompt builder for the watcher loop. Tracks rules epoch, trigger
/// count, and the first-mention identity hint. Owns a cloned `ServerClient` so
/// it can run on its own thread.
pub struct Watcher {
    server: ServerClient,
    base_agent: String,
    is_multi_instance: bool,
    default_refresh: i64,
    first_mention: bool,
    last_rules_epoch: i64,
    trigger_count: u64,
}

impl Watcher {
    pub fn new(server: ServerClient, base_agent: String, is_multi_instance: bool) -> Self {
        Self {
            server,
            base_agent,
            is_multi_instance,
            default_refresh: 10,
            first_mention: true,
            last_rules_epoch: 0,
            trigger_count: 0,
        }
    }

    /// Build the flattened text to inject for one drained batch, or `None` if no
    /// valid trigger. Looks up the current role and decides smart-rules injection.
    pub fn build_injection(
        &mut self,
        lines: &[String],
        current_name: &str,
        token: &str,
    ) -> Option<String> {
        let trigger = prompt::parse_trigger(lines)?;
        let base = prompt::base_prompt(&trigger);

        // Role: try the current (possibly renamed) name, then the base agent.
        let role = self.server.role(current_name).or_else(|| {
            if current_name != self.base_agent {
                self.server.role(&self.base_agent)
            } else {
                None
            }
        });

        // Smart rules: cold start / epoch change / periodic refresh.
        self.trigger_count += 1;
        let mut rules: Option<Vec<String>> = None;
        if let Some(active) = self.server.active_rules(token) {
            let ri = if active.refresh_interval != 0 {
                active.refresh_interval
            } else {
                self.default_refresh
            };
            if prompt::should_inject_rules(
                self.last_rules_epoch,
                active.epoch,
                self.trigger_count,
                ri,
            ) {
                if !active.rules.is_empty() {
                    rules = Some(active.rules.clone());
                }
                self.last_rules_epoch = active.epoch;
                self.server.report_rule_sync(current_name, active.epoch, token);
            }
        }

        let identity_hint = self.first_mention && self.is_multi_instance;
        if identity_hint {
            self.first_mention = false;
        }

        let assembled = prompt::assemble(base, role.as_deref(), rules.as_deref(), identity_hint);
        Some(prompt::flatten(&assembled))
    }
}

/// Run the watcher loop forever: poll the queue every second; on a trigger,
/// signal activity, build the prompt, and inject it. `get_identity` /
/// `get_token` are read each tick so a mid-session rename (M5) is picked up.
/// `on_trigger` is invoked before the prompt is built so activity is flagged
/// during the thinking phase.
pub fn run(
    mut watcher: Watcher,
    get_identity: impl Fn() -> (String, PathBuf),
    get_token: impl Fn() -> String,
    inject: impl Fn(&str),
    on_trigger: impl Fn(),
) -> ! {
    loop {
        let (_, queue) = get_identity();
        let lines = drain_queue(&queue);
        if !lines.is_empty() {
            // Signal activity BEFORE injecting so the UI covers the thinking phase.
            on_trigger();
            std::thread::sleep(Duration::from_millis(500));
            let (current_name, _) = get_identity();
            let token = get_token();
            if let Some(text) = watcher.build_injection(&lines, &current_name, &token) {
                inject(&text);
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_reads_and_truncates() {
        let mut path = std::env::temp_dir();
        path.push("agentchattr-drain-test_queue.jsonl");
        std::fs::write(&path, "{\"channel\":\"a\"}\n{\"channel\":\"b\"}\n").unwrap();

        let lines = drain_queue(&path);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "{\"channel\":\"a\"}");

        // File is now truncated → a second drain yields nothing.
        assert!(drain_queue(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drain_missing_file_is_empty() {
        let path = std::env::temp_dir().join("agentchattr-nonexistent_queue.jsonl");
        let _ = std::fs::remove_file(&path);
        assert!(drain_queue(&path).is_empty());
    }
}
