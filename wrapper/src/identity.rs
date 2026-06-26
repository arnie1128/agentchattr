//! Thread-safe agent identity (name + token + derived queue path).
//!
//! The heartbeat thread updates it on a server-side rename or a 409 re-register;
//! the queue watcher and activity reporter read it each tick. Shared as an
//! `Arc<Identity>`.

use std::path::PathBuf;
use std::sync::Mutex;

struct Inner {
    name: String,
    token: String,
}

pub struct Identity {
    inner: Mutex<Inner>,
    data_dir: PathBuf,
}

impl Identity {
    pub fn new(name: String, token: String, data_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner { name, token }),
            data_dir,
        }
    }

    pub fn name(&self) -> String {
        self.inner.lock().unwrap().name.clone()
    }

    pub fn token(&self) -> String {
        self.inner.lock().unwrap().token.clone()
    }

    fn queue_for(&self, name: &str) -> PathBuf {
        self.data_dir.join(format!("{name}_queue.jsonl"))
    }

    /// Consistent (name, queue_path) snapshot under one lock.
    pub fn snapshot(&self) -> (String, PathBuf) {
        let g = self.inner.lock().unwrap();
        (g.name.clone(), self.data_dir.join(format!("{}_queue.jsonl", g.name)))
    }

    pub fn queue_path(&self) -> PathBuf {
        self.queue_for(&self.inner.lock().unwrap().name)
    }

    /// Update name and/or token; returns whether anything actually changed.
    pub fn set(&self, new_name: Option<&str>, new_token: Option<&str>) -> bool {
        let mut g = self.inner.lock().unwrap();
        let mut changed = false;
        if let Some(n) = new_name {
            if n != g.name {
                g.name = n.to_string();
                changed = true;
            }
        }
        if let Some(t) = new_token {
            if t != g.token {
                g.token = t.to_string();
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_and_queue_track_name() {
        let dir = PathBuf::from("/data");
        let id = Identity::new("codex".into(), "tok".into(), dir.clone());
        let (name, queue) = id.snapshot();
        assert_eq!(name, "codex");
        assert_eq!(queue, dir.join("codex_queue.jsonl"));
    }

    #[test]
    fn rename_updates_queue_path() {
        let dir = PathBuf::from("/data");
        let id = Identity::new("codex".into(), "tok".into(), dir.clone());
        assert!(id.set(Some("codex-2"), None));
        assert_eq!(id.name(), "codex-2");
        assert_eq!(id.queue_path(), dir.join("codex-2_queue.jsonl"));
    }

    #[test]
    fn set_same_values_is_no_change() {
        let id = Identity::new("codex".into(), "tok".into(), PathBuf::from("/d"));
        assert!(!id.set(Some("codex"), Some("tok")));
        assert!(id.set(None, Some("tok2")));
    }
}
