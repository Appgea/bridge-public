use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Tiny JSON persistence for the first desktop slice.
///
/// It is isolated behind this type so SQLite can replace it later without changing sessions,
/// agents, or the UI.
pub struct JsonStore {
    root: PathBuf,
}

impl JsonStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let path = self.path(name);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let path = self.path(name);
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
        fs::rename(&temporary, &path)?;
        Ok(())
    }

    fn path(&self, name: &str) -> PathBuf {
        self.root.join(format!("{}.json", safe_name(name)))
    }
}

fn safe_name(name: &str) -> String {
    name.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect()
}

#[allow(dead_code)]
fn is_inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct State {
        value: u8,
    }

    #[test]
    fn round_trips_state() {
        let root = std::env::temp_dir().join(format!("panel-store-{}", std::process::id()));
        let store = JsonStore::new(&root);
        store.save("test", &State { value: 7 }).unwrap();
        assert_eq!(
            store.load::<State>("test").unwrap(),
            Some(State { value: 7 })
        );
        let _ = fs::remove_dir_all(root);
    }
}
