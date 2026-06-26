//! Cross-platform PTY host.
//!
//! Spawns an agent CLI in its own pseudo-terminal — ConPTY on Windows,
//! `openpty` on Unix — and exposes the master side for pumping I/O and
//! injecting queue messages. This single path replaces both `wrapper_unix.py`
//! (tmux) and `wrapper_windows.py` (shared console) from the Python version,
//! and removes the shared-console class of bugs entirely.

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

/// Shared, lockable handle to the PTY input side. Both the user's keystrokes
/// (the interactive pump) and injected queue messages write through this.
pub type PtyWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// A child process hosted in its own pseudo-terminal.
pub struct PtyHost {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: PtyWriter,
}

impl PtyHost {
    /// Spawn `cmd` attached to a fresh PTY of the given size.
    pub fn spawn(cmd: CommandBuilder, size: PtySize) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size).context("openpty failed")?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .context("spawning agent in PTY failed")?;
        // Drop the slave handle now that the child holds it: this lets the
        // master reader observe EOF once the child (and its descendants) exit.
        drop(pair.slave);
        let writer = pair
            .master
            .take_writer()
            .context("taking PTY writer failed")?;
        Ok(Self {
            master: pair.master,
            child,
            writer: Arc::new(Mutex::new(writer)),
        })
    }

    /// Clone a reader over the PTY output stream (master side).
    pub fn reader(&self) -> Result<Box<dyn Read + Send>> {
        self.master
            .try_clone_reader()
            .context("cloning PTY reader failed")
    }

    /// The shared input writer — used by the interactive pump and by injection.
    pub fn writer(&self) -> PtyWriter {
        Arc::clone(&self.writer)
    }

    /// Inject `text` followed by Enter, mirroring tmux `send-keys` /
    /// `WriteConsoleInput`. Goes through the same writer as user keystrokes.
    pub fn inject(&self, text: &str) -> Result<()> {
        let mut w = self.writer.lock().expect("PTY writer mutex poisoned");
        w.write_all(text.as_bytes())?;
        w.write_all(b"\r")?;
        w.flush()?;
        Ok(())
    }

    /// Resize the PTY (forward terminal resize / SIGWINCH).
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("PTY resize failed")
    }

    /// Block until the child exits; returns its exit code.
    pub fn wait(&mut self) -> Result<u32> {
        let status = self.child.wait().context("waiting on child failed")?;
        Ok(status.exit_code())
    }

    /// Force-terminate the child (used by the headless selftest cleanup).
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill().context("killing child failed")?;
        Ok(())
    }
}

/// RAII guard: puts the real terminal into raw mode and ALWAYS restores it on
/// drop — every exit path, including panics. This is the structural fix for the
/// "Ctrl+C dead / console frozen after the agent exits" bug the Python wrapper
/// had: it never restored the console input mode, so `ENABLE_PROCESSED_INPUT`
/// stayed cleared and Ctrl+C was delivered as a raw byte instead of a signal.
pub struct RawModeGuard;

impl RawModeGuard {
    pub fn enable() -> Result<Self> {
        crossterm::terminal::enable_raw_mode().context("enabling raw mode failed")?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}
