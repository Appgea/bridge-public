//! Device leases — Rust half of the broker that decides who may use which device.
//!
//! The store is `~/.panel/leases.json`, and it is shared, byte for byte, with
//! `common/lease.py`, next to the Panel checkout,. That sharing is the entire point: the screenshot
//! pipeline runs out of a Makefile, often from a terminal with Panel closed, and a lease that
//! only existed inside this process would not stop `flutter drive` from grabbing the simulator
//! you are debugging on. A file both sides read does stop it.
//!
//! Read `lease.py`'s module docstring for the address format and the picking rules — they are
//! stated once, there, and this file follows them rather than restating them.
//!
//! Liveness is the holder's pid. Every lease Panel takes carries Panel's pid, so a crash
//! releases the whole set the next time anybody touches the file. Nothing here expires on a
//! timer, and there is no daemon.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A lock older than this belonged to something that died holding it. Generous next to the
/// microseconds an honest read-modify-write takes, short enough that a build never hangs on it.
const LOCK_STALE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub owner: String,
    /// "interactive" for a Run, "debug" for DAP, "capture" for screenshots. The UI says which,
    /// so a busy device reads as *why* it is busy rather than just unavailable.
    pub kind: String,
    pub pid: u32,
    pub since: u64,
    pub family: String,
    pub name: String,
    /// This broker booted the device, so this broker owes the RAM back on release. A simulator
    /// the human already had up is theirs; shutting it down would be us tidying their desk.
    #[serde(default)]
    pub booted_by_us: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    leases: BTreeMap<String, Lease>,
}

fn one() -> u32 {
    1
}

fn store_path() -> PathBuf {
    home().join(".panel").join("leases.json")
}

fn lock_path() -> PathBuf {
    home().join(".panel").join("leases.lock")
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whole-file lock via `create_dir`, which is atomic everywhere and, unlike `flock`, is not tied
/// to an open file description — so the Python half's shell subprocesses honour the same lock.
struct Lock;

impl Lock {
    fn acquire() -> Lock {
        let path = lock_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let deadline = SystemTime::now() + LOCK_STALE;
        loop {
            if std::fs::create_dir(&path).is_ok() {
                return Lock;
            }
            let stale = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .map(|at| at.elapsed().map(|age| age > LOCK_STALE).unwrap_or(false))
                .unwrap_or(true);
            if stale {
                let _ = std::fs::remove_dir(&path);
                continue;
            }
            if SystemTime::now() > deadline {
                // Better a rare double-booking than a frozen UI: the caller is on a Run click.
                let _ = std::fs::remove_dir(&path);
                return Lock;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(lock_path());
    }
}

fn read() -> Store {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Store {
            version: 1,
            leases: BTreeMap::new(),
        })
}

fn write(store: &Store) {
    let path = store_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_string_pretty(store)
        .ok()
        .and_then(|text| std::fs::write(&tmp, text).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // `kill -0` is the portable liveness question, and the only one that does not need a crate.
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Drop every lease whose holder is gone, shutting down the simulators we booted for them.
/// Called on every mutation, so a crashed run never starves the pool.
fn sweep(store: &mut Store) -> bool {
    let own_pid = std::process::id();
    let mut alive: HashMap<u32, bool> = HashMap::new();
    let dead: Vec<String> = store
        .leases
        .iter()
        .filter(|(_, lease)| {
            let running = *alive.entry(lease.pid).or_insert_with(|| {
                lease.pid == own_pid || pid_alive(lease.pid)
            });
            !running
        })
        .map(|(target, _)| target.clone())
        .collect();
    let changed = !dead.is_empty();
    for target in dead {
        if let Some(lease) = store.leases.remove(&target) {
            if lease.booted_by_us {
                if let Some(udid) = target.split_once(':').map(|(_, id)| id.to_string()) {
                    crate::sim::shutdown_device(&udid);
                }
            }
        }
    }
    changed
}

// --------------------------------------------------------------------------- public

/// Every live lease, keyed by target address. What the Run screen greys out, and why.
pub fn held() -> BTreeMap<String, Lease> {
    let _lock = Lock::acquire();
    let mut store = read();
    if sweep(&mut store) {
        write(&store);
    }
    store.leases
}

/// Claim one target for one owner. Fails when somebody else already holds it — the caller is
/// expected to have picked a free one, and a race here means the world changed underneath them.
pub fn take(
    target: &str,
    owner: &str,
    kind: &str,
    family: &str,
    name: &str,
    booted_by_us: bool,
) -> Result<(), String> {
    let _lock = Lock::acquire();
    let mut store = read();
    sweep(&mut store);
    if let Some(existing) = store.leases.get(target) {
        if existing.owner != owner {
            return Err(format!(
                "{} is held by {} ({})",
                existing.name, existing.owner, existing.kind
            ));
        }
    }
    store.leases.insert(
        target.to_string(),
        Lease {
            owner: owner.to_string(),
            kind: kind.to_string(),
            pid: std::process::id(),
            since: now(),
            family: family.to_string(),
            name: name.to_string(),
            booted_by_us,
        },
    );
    write(&store);
    Ok(())
}

/// Hand back everything one owner holds. A run's stop path calls this; the device it releases is
/// what advances the UI's oldest queued project.
pub fn release_owner(owner: &str) {
    let _lock = Lock::acquire();
    let mut store = read();
    let swept = sweep(&mut store);
    let mine: Vec<String> = store
        .leases
        .iter()
        .filter(|(_, lease)| lease.owner == owner)
        .map(|(target, _)| target.clone())
        .collect();
    for target in &mine {
        store.leases.remove(target);
    }
    if swept || !mine.is_empty() {
        write(&store);
    }
}

/// Is this target free for this owner to use?
pub fn free_for(held: &BTreeMap<String, Lease>, target: &str, owner: &str) -> bool {
    held.get(target)
        .map(|lease| lease.owner == owner)
        .unwrap_or(true)
}
