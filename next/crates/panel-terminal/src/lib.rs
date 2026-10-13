use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

pub type TerminalSink = Arc<dyn Fn(TerminalChunk) + Send + Sync + 'static>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
    pub terminal_id: String,
    pub data: String,
    pub closed: bool,
}

/// How much of each PTY's output is kept so the screen can be put back after a restart.
///
/// This is raw stream, escape sequences and all — replaying it into a fresh xterm reproduces the
/// colours and the layout, which a plain-text transcript cannot. 192 KB is about two thousand
/// lines of a talkative agent: enough to recognise where you were, small enough that nine of them
/// cost under two megabytes of a process that is mostly waiting.
const SCREEN_CAP: usize = 192 * 1024;

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// The tail of everything this PTY has printed. Written by the reader thread, read by
    /// whoever is saving the wall — hence the lock the thread already holds a handle to.
    screen: Arc<Mutex<String>>,
}

/// Drop the front of a kept screen until it fits, then move the cut forward to the next newline.
///
/// Cutting at an arbitrary byte would slice a colour escape in half and the replay would open
/// with one garbled line. Cutting at a line boundary cannot: an escape sequence never spans one.
fn trim_screen(screen: &mut String) {
    // Headroom, not a hard cap. Trimming at exactly the cap shifted the whole 192 KB buffer on
    // every read once it was full: a busy agent paid for a full copy per 8 KB chunk.
    if screen.len() > SCREEN_CAP * 2 {
        trim_to_cap(screen);
    }
}

/// Cut to at most `SCREEN_CAP`, starting on a character and, where one exists, a line boundary.
fn trim_to_cap(screen: &mut String) {
    if screen.len() <= SCREEN_CAP {
        return;
    }
    let over = screen.len() - SCREEN_CAP;
    let mut cut = screen
        .char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= over)
        .unwrap_or(screen.len());
    if let Some(newline) = screen[cut..].find('\n') {
        cut += newline + 1;
    }
    screen.drain(..cut);
}

/// What to run in a new PTY.
///
/// `env` is how an agent learns to talk back to Panel: we inject `PANEL_PORT` and
/// `PANEL_INSTANCE`, and the hook/MCP shims already read exactly those. The agent itself
/// is launched plain — no wrapper, no side protocol — so it behaves in Panel exactly as it
/// does in a normal terminal, which is the entire point of hosting it this way.
pub struct SpawnSpec {
    pub cwd: PathBuf,
    /// `None` runs the user's login shell.
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

impl SpawnSpec {
    pub fn shell(cwd: impl Into<PathBuf>, cols: u16, rows: u16) -> Self {
        Self {
            cwd: cwd.into(),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            cols,
            rows,
        }
    }

    pub fn run(mut self, command: impl Into<String>, args: Vec<String>) -> Self {
        self.command = Some(command.into());
        self.args = args;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

impl TerminalManager {
    /// Open a PTY running the user's login shell.
    pub fn open(
        &mut self,
        cwd: impl AsRef<Path>,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<String> {
        self.spawn(SpawnSpec::shell(cwd.as_ref(), cols, rows), sink)
    }

    /// Open a PTY running whatever the spec says, with its environment injected.
    pub fn spawn(&mut self, spec: SpawnSpec, sink: TerminalSink) -> Result<String> {
        let SpawnSpec {
            cwd,
            command: program,
            args,
            env,
            cols,
            rows,
        } = spec;
        if !cwd.is_dir() {
            return Err(anyhow!("terminal folder does not exist: {}", cwd.display()));
        }

        let pair = native_pty_system().openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let program = program.unwrap_or_else(default_shell);
        let mut command = CommandBuilder::new(&program);
        for arg in args {
            command.arg(arg);
        }
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        for (key, value) in env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("start {program}"))?;
        drop(pair.slave);

        let terminal_id = Uuid::new_v4().to_string();
        let reader_id = terminal_id.clone();
        let mut reader = pair.master.try_clone_reader()?;
        let screen = Arc::new(Mutex::new(String::new()));
        let reader_screen = Arc::clone(&screen);
        thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            // Holds the tail of a multi-byte character that a read stopped in the middle of, so
            // it can be finished by the next read instead of being decoded — and corrupted — early.
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        sink(TerminalChunk {
                            terminal_id: reader_id.clone(),
                            data: String::new(),
                            closed: true,
                        });
                        break;
                    }
                    Ok(read) => {
                        let data = decode_stream(&mut carry, &buffer[..read]);
                        if data.is_empty() {
                            continue; // the whole read was an unfinished character; wait for more
                        }
                        // Kept before it is sent: the UI may not be listening yet, and a screen
                        // that starts at "whenever the window opened" is not the screen.
                        if let Ok(mut kept) = reader_screen.lock() {
                            kept.push_str(&data);
                            trim_screen(&mut kept);
                        }
                        sink(TerminalChunk {
                            terminal_id: reader_id.clone(),
                            data,
                            closed: false,
                        });
                    }
                }
            }
        });

        let writer = pair.master.take_writer()?;
        self.sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
                screen,
            },
        );
        Ok(terminal_id)
    }

    /// The tail of what this PTY has printed, escape sequences intact. Replaying it into a fresh
    /// terminal is how a restored session opens on the screen it had rather than on a blank one.
    pub fn screen(&self, terminal_id: &str) -> Option<String> {
        self.sessions
            .get(terminal_id)
            .and_then(|session| session.screen.lock().ok())
            .map(|kept| {
                let mut tail = kept.clone();
                trim_to_cap(&mut tail);
                tail
            })
    }

    pub fn write(&mut self, terminal_id: &str, data: &str) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .ok_or_else(|| anyhow!("terminal is not open"))?;
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self
            .sessions
            .get_mut(terminal_id)
            .ok_or_else(|| anyhow!("terminal is not open"))?;
        session.master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&mut self, terminal_id: &str) -> Result<()> {
        if let Some(closing) = self.take(terminal_id) {
            closing.end();
        }
        Ok(())
    }

    /// Detach a session without ending it. The manager sits behind one lock that every keystroke
    /// takes, and ending a session can take a second or more (a `ps` scan, the agent's own exit,
    /// a grace period for its children). So callers take under the lock and `end()` outside it.
    pub fn take(&mut self, terminal_id: &str) -> Option<ClosingTerminal> {
        self.sessions.remove(terminal_id).map(ClosingTerminal)
    }

    /// The pid of the process this PTY forked — the login shell, or the agent. Its live cwd is
    /// what "open another shell here" means, so the caller can read it off the OS.
    pub fn pid(&self, terminal_id: &str) -> Option<u32> {
        self.sessions
            .get(terminal_id)
            .and_then(|session| session.child.process_id())
    }

    /// The pid of the process group sitting in the FOREGROUND of this PTY — the one a keystroke
    /// would reach. It equals `pid()` while the spawned process is at its own prompt, and is a
    /// different pid whenever that process is running something (a build, an editor, a command).
    /// That difference is the only honest "is this terminal busy" signal: it ignores background
    /// helpers a program keeps alive for its own reasons, which no user thinks of as running.
    pub fn foreground_pid(&self, terminal_id: &str) -> Option<u32> {
        #[cfg(unix)]
        {
            self.sessions
                .get(terminal_id)
                .and_then(|session| session.master.process_group_leader())
                .filter(|pid| *pid > 0)
                .map(|pid| pid as u32)
        }
        #[cfg(not(unix))]
        {
            let _ = terminal_id;
            None
        }
    }

    /// Whether this PTY still owns a process. Non-blocking: shutdown guards can inspect every
    /// session without waiting on one that is busy compiling, prompting, or running an agent.
    pub fn is_running(&mut self, terminal_id: &str) -> bool {
        self.sessions
            .get_mut(terminal_id)
            .map(|session| !matches!(session.child.try_wait(), Ok(Some(_))))
            .unwrap_or(false)
    }
}

/// A session already out of the manager, waiting to be ended. See `TerminalManager::take`.
pub struct ClosingTerminal(TerminalSession);

impl ClosingTerminal {
    /// Kill the process and every descendant. Blocks until they are gone or SIGKILLed.
    pub fn end(self) {
        let mut session = self.0;
        // Read before the kill: once the agent dies its children belong to launchd, and
        // nothing links a dev server an agent started back to the tab that started it.
        let tree = session.child.process_id().map(descendants).unwrap_or_default();
        let _ = session.child.kill();
        let _ = session.child.wait();
        end_all(&tree);
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        let ids: Vec<_> = self.sessions.keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

/// Turn raw PTY bytes into text without ever splitting a UTF-8 character across the seam
/// between two reads.
///
/// A fixed-size read can land in the middle of a multi-byte glyph — a box-drawing rule, the `❯`
/// prompt, an emoji, a spinner frame. Decoding each read on its own then turns that half into a
/// `` on both sides of the boundary, which is exactly the "the terminal is garbled" look. So an
/// unfinished tail is carried into the next read instead of being decoded early; only genuinely
/// invalid bytes (never a normal `claude` stream) still collapse to one replacement char.
fn decode_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                out.push_str(text);
                carry.clear();
                break;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&carry[..valid]).expect("prefix is valid"));
                }
                match err.error_len() {
                    // Real garbage mid-stream: emit one replacement and keep decoding past it.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        carry.drain(..valid + bad);
                    }
                    // Just an unfinished character at the very end: hold it for the next read.
                    None => {
                        carry.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// Every process below `root`, whatever its process group. An agent runs its commands in groups
/// of their own with no terminal, so the SIGHUP a closing PTY sends never reaches them.
fn descendants(root: u32) -> Vec<u32> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output() else {
        return Vec::new();
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut fields = line.split_whitespace().filter_map(|field| field.parse::<u32>().ok());
        if let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut found = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
            found.push(child);
            queue.push(child);
        }
    }
    found
}

/// SIGTERM, a second's grace to shut down cleanly, then SIGKILL for whatever is left.
fn end_all(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let signal = |flag: &str, pids: &[u32]| {
        std::process::Command::new("kill")
            .arg(flag)
            .args(pids.iter().map(u32::to_string))
            .output()
    };
    let _ = signal("-TERM", pids);
    for _ in 0..20 {
        thread::sleep(std::time::Duration::from_millis(50));
        // `kill -0` fails as soon as any pid in the list is gone, so each is asked on its own.
        if !pids.iter().any(|pid| signal("-0", &[*pid]).is_ok_and(|out| out.status.success())) {
            return;
        }
    }
    let _ = signal("-KILL", pids);
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// A thread-safe wrapper used by desktop hosts.
pub type SharedTerminalManager = Arc<Mutex<TerminalManager>>;

#[cfg(test)]
mod decode_tests {
    use super::decode_stream;

    #[test]
    fn a_glyph_split_across_two_reads_survives_the_seam() {
        // `─` (U+2500) is three bytes: E2 94 80. Feed the first two, then the last.
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[0xE2, 0x94]), ""); // held, not corrupted
        assert_eq!(decode_stream(&mut carry, &[0x80]), "─"); // completed cleanly
        assert!(carry.is_empty());
    }

    #[test]
    fn a_read_ending_mid_character_emits_the_finished_part_and_holds_the_rest() {
        // "ab" then the first byte of `❯` (U+276F, E2 9D AF).
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[b'a', b'b', 0xE2, 0x9D]), "ab");
        assert_eq!(decode_stream(&mut carry, &[0xAF, b'c']), "❯c");
        assert!(carry.is_empty());
    }

    #[test]
    fn genuinely_invalid_bytes_become_one_replacement_and_do_not_eat_what_follows() {
        // 0xFF is never valid UTF-8; the 'A' after it must still come through.
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, &[0xFF, b'A']), "\u{FFFD}A");
        assert!(carry.is_empty());
    }

    #[test]
    fn plain_ascii_passes_through_untouched() {
        let mut carry = Vec::new();
        assert_eq!(decode_stream(&mut carry, b"hello\r\n"), "hello\r\n");
        assert!(carry.is_empty());
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn owns_a_real_pty_without_tmux() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let id = manager.open(std::env::temp_dir(), 80, 24, sink).unwrap();
        manager.write(&id, "printf 'PANEL_PTY_OK\\n'\n").unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains("PANEL_PTY_OK") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        manager.close(&id).unwrap();
        assert!(
            output.contains("PANEL_PTY_OK"),
            "PTY output was {output:?}"
        );
    }

    /// The agent finds Panel only through its environment. If this breaks, the panel goes
    /// silent and the whole observation design quietly stops working — so it gets a test.
    #[test]
    fn the_spawned_process_inherits_the_panel_environment() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let spec = SpawnSpec::shell(std::env::temp_dir(), 80, 24)
            .run(
                "sh",
                vec!["-c".into(), "printf 'PORT=%s\\n' \"$PANEL_PORT\"".into()],
            )
            .with_env("PANEL_PORT", "54321");
        let id = manager.spawn(spec, sink).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains("PORT=") {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        manager.close(&id).unwrap();
        assert!(output.contains("PORT=54321"), "PTY output was {output:?}");
    }

    /// What an agent leaves behind: a server in its own process group that ignores SIGHUP.
    /// Closing the tab must still end it, or it runs until the Mac restarts.
    #[test]
    fn closing_a_terminal_ends_what_its_process_started() {
        let (tx, rx) = mpsc::channel();
        let sink: TerminalSink = Arc::new(move |chunk| {
            let _ = tx.send(chunk);
        });
        let mut manager = TerminalManager::default();
        let spec = SpawnSpec::shell(std::env::temp_dir(), 80, 24).run(
            "sh",
            vec![
                "-c".into(),
                "set -m; nohup sleep 300 >/dev/null 2>&1 & printf 'LEFT=%s\\n' $!; wait".into(),
            ],
        );
        let id = manager.spawn(spec, sink).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while Instant::now() < deadline && !output.contains('\n') {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(250)) {
                output.push_str(&chunk.data);
            }
        }
        let left: u32 = output
            .split("LEFT=")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|pid| pid.parse().ok())
            .unwrap_or_else(|| panic!("PTY output was {output:?}"));
        manager.close(&id).unwrap();

        let alive = std::process::Command::new("kill")
            .args(["-0", &left.to_string()])
            .output()
            .is_ok_and(|out| out.status.success());
        assert!(!alive, "background process {left} outlived its terminal");
    }

    #[test]
    fn shutdown_checks_distinguish_a_live_process_from_ended_scrollback() {
        let sink: TerminalSink = Arc::new(|_| {});
        let mut manager = TerminalManager::default();
        let live = manager
            .spawn(
                SpawnSpec::shell(std::env::temp_dir(), 80, 24).run("sh", vec![]),
                sink.clone(),
            )
            .unwrap();
        assert!(manager.is_running(&live));

        let ended = manager
            .spawn(
                SpawnSpec::shell(std::env::temp_dir(), 80, 24)
                    .run("sh", vec!["-c".into(), "exit 0".into()]),
                sink,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && manager.is_running(&ended) {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!manager.is_running(&ended));
        manager.close(&live).unwrap();
        manager.close(&ended).unwrap();
    }
}

#[cfg(test)]
mod screen_tests {
    use super::{trim_screen, trim_to_cap, SCREEN_CAP};

    #[test]
    fn kept_screen_trims_in_batches_but_restores_at_most_the_cap() {
        let line = "x".repeat(99) + "\n";
        let mut kept = String::new();
        let mut trims = 0;
        for _ in 0..(SCREEN_CAP * 5 / line.len()) {
            let before = kept.len();
            kept.push_str(&line);
            trim_screen(&mut kept);
            if kept.len() < before {
                trims += 1;
            }
            assert!(kept.len() <= SCREEN_CAP * 2 + line.len());
        }
        // One cut per cap of output, not one per write.
        assert!(trims <= 5, "trimmed {trims} times");
        let mut tail = kept.clone();
        trim_to_cap(&mut tail);
        assert!(tail.len() <= SCREEN_CAP);
        assert!(tail.starts_with('x') && kept.ends_with(&tail));
    }
}
