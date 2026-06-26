//! Activity detection from the PTY output stream.
//!
//! The Python wrapper re-read the whole console screen buffer every second and
//! diffed visible cells. Because the native wrapper already pumps every byte of
//! PTY output, "is the agent working?" reduces to "are output bytes flowing
//! above a quiet threshold?" — the output pump feeds an `ActivityCounter`, and
//! an `ActivityState` applies hysteresis on a fixed poll interval.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// Shared counter fed by the output pump (bytes) and the queue watcher (trigger).
#[derive(Default)]
pub struct ActivityCounter {
    bytes: AtomicU64,
    trigger: AtomicBool,
}

impl ActivityCounter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Called by the PTY output pump for every chunk read from the agent.
    pub fn add_bytes(&self, n: usize) {
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }

    /// Called by the queue watcher when a message is injected, so the agent is
    /// flagged active immediately (covers the thinking phase before any output).
    pub fn set_trigger(&self) {
        self.trigger.store(true, Ordering::Relaxed);
    }

    /// Atomically read and reset the accumulated bytes + trigger flag.
    fn take(&self) -> (u64, bool) {
        (
            self.bytes.swap(0, Ordering::Relaxed),
            self.trigger.swap(false, Ordering::Relaxed),
        )
    }
}

/// Hysteresis state machine polled once per interval (~1s). Goes active
/// immediately on significant output or a trigger; goes idle only after several
/// consecutive quiet polls.
pub struct ActivityState {
    counter: Arc<ActivityCounter>,
    min_bytes: u64,
    idle_cooldown: u32,
    consecutive_idle: u32,
    is_active: bool,
}

impl ActivityState {
    pub fn new(counter: Arc<ActivityCounter>) -> Self {
        Self {
            counter,
            // A spinner/cursor redraw is tens of bytes; real work is much more.
            // Tuned against the server's active/idle UI during owner validation.
            min_bytes: 24,
            idle_cooldown: 5, // ~5 quiet polls (5s) before idle
            consecutive_idle: 0,
            is_active: false,
        }
    }

    /// Advance one poll; returns the current active state.
    pub fn poll(&mut self) -> bool {
        let (bytes, triggered) = self.counter.take();
        if bytes >= self.min_bytes || triggered {
            self.consecutive_idle = 0;
            self.is_active = true;
        } else {
            self.consecutive_idle += 1;
            if self.consecutive_idle >= self.idle_cooldown {
                self.is_active = false;
            }
        }
        self.is_active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (Arc<ActivityCounter>, ActivityState) {
        let c = ActivityCounter::new();
        let s = ActivityState::new(Arc::clone(&c));
        (c, s)
    }

    #[test]
    fn significant_output_goes_active() {
        let (c, mut s) = state();
        c.add_bytes(200);
        assert!(s.poll());
    }

    #[test]
    fn trigger_forces_active_with_no_output() {
        let (c, mut s) = state();
        c.set_trigger();
        assert!(s.poll());
    }

    #[test]
    fn tiny_noise_below_threshold_stays_idle() {
        let (c, mut s) = state();
        c.add_bytes(3); // below min_bytes
        assert!(!s.poll());
    }

    #[test]
    fn goes_idle_only_after_cooldown() {
        let (c, mut s) = state();
        c.add_bytes(500);
        assert!(s.poll()); // active
                           // five quiet polls → idle
        for _ in 0..4 {
            assert!(s.poll(), "should remain active during cooldown");
        }
        assert!(!s.poll(), "should go idle after cooldown");
    }

    #[test]
    fn output_resets_idle_countdown() {
        let (c, mut s) = state();
        c.add_bytes(500);
        s.poll();
        s.poll(); // 1 idle
        s.poll(); // 2 idle
        c.add_bytes(500); // work resumes
        assert!(s.poll());
        // counter reset, so it takes a fresh full cooldown to go idle again
        for _ in 0..4 {
            assert!(s.poll());
        }
        assert!(!s.poll());
    }
}
