//! The few places where Windows and Unix genuinely differ, kept in one file so the rest of the
//! app reads the same on both.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

/// A subprocess that never flashes a console window. A release build is a GUI-subsystem app on
/// Windows, so every console child (git, python, adb) would otherwise pop a black window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The Python launcher name. `python3` is a Unix convention; on Windows it is either missing or
/// the Store stub that opens a download page instead of running anything.
pub fn python() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

/// Hand a URL or file to the OS default handler.
pub fn open(target: impl AsRef<OsStr>) -> Command {
    #[cfg(target_os = "macos")]
    let mut command = command("open");
    #[cfg(target_os = "windows")]
    let mut command = command("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = command("xdg-open");
    command.arg(target);
    command
}

/// Is this pid still running? `kill -0` on Unix; `tasklist` filtered to the pid on Windows.
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        command("tasklist")
            .args(["/NH", "/FI", &format!("PID eq {pid}")])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        command("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }
}

/// Is a command reachable on PATH? `where` resolves PATHEXT shims (.cmd/.bat) the way a shell
/// would; `which` does the same on Unix.
pub fn on_path(program: &str) -> bool {
    command(if cfg!(windows) { "where" } else { "which" })
        .arg(program)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Link `link` to the directory `target`. Unix symlink; on Windows a directory symlink when
/// Developer Mode allows it, else a junction, which needs no privilege at all.
pub fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        let out = command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

/// Remove a link made by `link_dir`. A Windows directory link is a directory entry, not a file.
pub fn remove_link(link: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if std::fs::remove_dir(link).is_ok() {
        return Ok(());
    }
    std::fs::remove_file(link).map_err(|e| e.to_string())
}
