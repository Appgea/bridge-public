//! One private Markdown file, never exposed as project or agent context.

use std::fs;

fn file() -> Result<std::path::PathBuf, String> {
    let file = crate::paths::notebook_file();
    let parent = file.parent().ok_or("the notebook path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    Ok(file)
}

#[tauri::command]
pub fn read_notebook() -> Result<String, String> {
    let file = file()?;
    if !file.exists() {
        fs::write(&file, "").map_err(|error| format!("could not create notes.md: {error}"))?;
    }
    fs::read_to_string(file).map_err(|error| format!("could not read notes.md: {error}"))
}

#[tauri::command]
pub fn save_notebook(text: String) -> Result<(), String> {
    let file = file()?;
    let temp = file.with_extension(format!("md.save-{}", uuid::Uuid::new_v4()));
    fs::write(&temp, text).map_err(|error| format!("could not save notes.md: {error}"))?;
    if let Err(error) = fs::rename(&temp, &file) {
        let _ = fs::remove_file(&temp);
        return Err(format!("could not save notes.md: {error}"));
    }
    Ok(())
}
