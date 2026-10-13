//! Per-session skill choices. Choices are applied at process launch, never mid-turn.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

static WRITES: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default)]
    pub overrides: HashMap<String, bool>,
    #[serde(default)]
    pub applied: HashMap<String, bool>,
}

fn policy_file(session: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(session).map_err(|_| "Invalid session identifier")?;
    Ok(crate::paths::user_root()
        .join("state/skills/sessions")
        .join(format!("{id}.json")))
}
fn read_optional(path: &Path) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    let mut raw = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() as u64 > MAX_BYTES {
        return Err(format!("{} exceeds 1 MiB", path.display()));
    }
    Ok(Some(raw))
}
pub fn policy(session: &str) -> Result<Policy, String> {
    match read_optional(&policy_file(session)?)? {
        None => Ok(Policy::default()),
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|e| format!("Invalid session skill policy: {e}"))
        }
    }
}
fn write_policy(session: &str, policy: &Policy) -> Result<(), String> {
    let path = policy_file(session)?;
    let parent = path.parent().ok_or("Invalid policy path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        let raw = serde_json::to_vec_pretty(policy).map_err(|e| e.to_string())?;
        if raw.len() as u64 > MAX_BYTES {
            return Err("Too many session skill overrides".into());
        }
        file.write_all(&raw).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn set(session: &str, path: &str, enabled: Option<bool>) -> Result<Policy, String> {
    let _guard = WRITES.lock().map_err(|_| "Skill policy lock unavailable")?;
    let mut state = policy(session)?;
    // Removing a stale override remains possible after its file was removed.
    if let Some(enabled) = enabled {
        crate::skills::read(path.into())?;
        state.overrides.insert(path.into(), enabled);
    } else {
        state.overrides.remove(path);
    }
    write_policy(session, &state)?;
    Ok(state)
}
pub fn mark_applied(session: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "Skill policy lock unavailable")?;
    if !policy_file(session)?.exists() {
        return Ok(());
    }
    let mut state = policy(session)?;
    state.applied = state.overrides.clone();
    write_policy(session, &state)
}
fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Home directory unavailable".into())
}
fn skill_key(path: &Path) -> PathBuf {
    let path = if path.is_dir() {
        path.join("SKILL.md")
    } else {
        path.to_path_buf()
    };
    path.canonicalize().unwrap_or(path)
}
fn config_path(value: &str, base: &Path) -> Result<PathBuf, String> {
    if let Some(rest) = value.strip_prefix("~/") {
        return Ok(home()?.join(rest));
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        base.join(path)
    })
}

pub fn launch_args(session: &str, kind: &str, cwd: &Path) -> Result<Vec<String>, String> {
    if kind != "codex" {
        return Ok(Vec::new());
    }
    let state = policy(session)?;
    if state.overrides.is_empty() {
        return Ok(Vec::new());
    }
    let cwd = cwd.canonicalize().map_err(|e| e.to_string())?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".codex"));
    let mut configs = vec![codex_home.join("config.toml")];
    let mut ancestors: Vec<_> = cwd.ancestors().take(32).collect();
    ancestors.reverse();
    configs.extend(ancestors.into_iter().map(|p| p.join(".codex/config.toml")));
    let mut seen = HashSet::new();
    let mut entries: Vec<toml::Value> = Vec::new();
    let mut positions = HashMap::<PathBuf, usize>::new();
    for config in configs {
        let key = config.canonicalize().unwrap_or(config.clone());
        if !seen.insert(key) {
            continue;
        }
        let Some(raw) = read_optional(&config)? else {
            continue;
        };
        let parsed: toml::Value =
            toml::from_str(&raw).map_err(|e| format!("Invalid {}: {e}", config.display()))?;
        let Some(array) = parsed.get("skills").and_then(|s| s.get("config")) else {
            continue;
        };
        let array = array
            .as_array()
            .ok_or_else(|| format!("skills.config must be an array in {}", config.display()))?;
        for entry in array {
            let value = entry
                .as_table()
                .ok_or("Skill config entry must be a table")?;
            let path = value
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Skill config entry needs a path")?;
            let resolved = config_path(path, config.parent().unwrap_or(&cwd))?;
            let key = skill_key(&resolved);
            let mut value = value.clone();
            // Relative paths belong to their source config, not the CLI's cwd.
            value.insert(
                "path".into(),
                toml::Value::String(resolved.to_string_lossy().into_owned()),
            );
            if let Some(index) = positions.get(&key) {
                // More specific config fields override earlier fields for the same skill.
                let previous = entries[*index]
                    .as_table_mut()
                    .ok_or("Invalid skill configuration")?;
                previous.extend(value);
            } else {
                positions.insert(key, entries.len());
                entries.push(toml::Value::Table(value));
            }
        }
    }
    let catalog = crate::skills::catalog(Some(cwd))?;
    let mut overrides: Vec<_> = state.overrides.iter().collect();
    overrides.sort_by_key(|(path, _)| *path);
    for (path, enabled) in overrides {
        let entry = catalog
            .iter()
            .find(|entry| entry.path == *path)
            .ok_or_else(|| format!("Configured skill is no longer available: {path}"))?;
        if !matches!(entry.source.as_str(), "personal" | "project" | "panel")
            || !matches!(entry.provider.as_str(), "codex" | "shared")
        {
            return Err(format!(
                "Skill cannot be configured for Codex: {}",
                entry.name
            ));
        }
        let key = skill_key(Path::new(path));
        if let Some(index) = positions.get(&key) {
            entries[*index]
                .as_table_mut()
                .ok_or("Invalid skill configuration")?
                .insert("enabled".into(), toml::Value::Boolean(*enabled));
        } else {
            let mut table = toml::map::Map::new();
            table.insert("path".into(), toml::Value::String(path.clone()));
            table.insert("enabled".into(), toml::Value::Boolean(*enabled));
            positions.insert(key, entries.len());
            entries.push(toml::Value::Table(table));
        }
    }
    Ok(vec![
        "-c".into(),
        format!("skills.config={}", toml::Value::Array(entries)),
    ])
}

/// Inner `skillOverrides` map for Claude's generated launch settings.
pub fn claude_overrides(session: &str, cwd: &Path) -> Result<Value, String> {
    let state = policy(session)?;
    let mut result = serde_json::Map::new();
    if state.overrides.is_empty() {
        return Ok(Value::Object(result));
    }
    let catalog = crate::skills::catalog(Some(cwd.to_path_buf()))?;
    for (path, enabled) in state.overrides {
        let entry = catalog
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| format!("Configured skill is no longer available: {path}"))?;
        if (entry.provider != "claude" && entry.source != "panel") || !matches!(entry.source.as_str(), "personal" | "project" | "panel") {
            return Err(format!(
                "Skill cannot be configured for Claude: {}",
                entry.name
            ));
        }
        if catalog
            .iter()
            .filter(|other| (other.provider == "claude" || other.source == "panel") && other.name == entry.name)
            .count()
            > 1
        {
            return Err(format!("Claude skill name is ambiguous: {}", entry.name));
        }
        result.insert(
            entry.name.clone(),
            Value::String(if enabled { "on" } else { "off" }.into()),
        );
    }
    Ok(Value::Object(result))
}
