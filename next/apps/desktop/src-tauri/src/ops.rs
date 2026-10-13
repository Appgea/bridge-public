//! Where the ops tree is.
//!
//! This module used to assemble a digest — portfolio facts, decisions, principles — and hand it to
//! a sandboxed companion that had no filesystem of its own. The manager now runs in a terminal
//! rooted in that same tree, so it reads the files directly. What survived is the one thing the
//! host still has to answer: which folder is the ops tree for a given project.

use std::path::PathBuf;

/// `opsRoot` in the shared `config.json`, plus the `ops/` directory it contains. Absent for a
/// checkout with no ops tree — the companion then simply answers without portfolio facts.
pub fn ops_dir() -> Option<PathBuf> {
    ops_dir_for(None)
}

/// The same, but for a named project — its GROUP's ops tree when it has one.
///
/// A portfolio holding two companies holds two sets of standing decisions, and running one
/// company's project against the other's principles is worse than running it against none. A
/// project in no group, or in a group with no `opsRoot`, falls back to the global tree, which is
/// what every project used before groups existed.
pub fn ops_dir_for(project: Option<&crate::projects::Project>) -> Option<PathBuf> {
    let root = crate::projects::ops_root_for(project)?;
    let dir = root.join("ops");
    dir.is_dir().then_some(dir)
}
