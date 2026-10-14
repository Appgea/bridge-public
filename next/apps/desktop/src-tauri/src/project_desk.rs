//! Project desk: local release evidence and the existing project memory, without an agent.
use crate::projects::Project;
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

static WRITER: Mutex<()> = Mutex::new(());
const EMPTY: &str = "# Project desk\n\nRelease target: \n\n## Todos\n\n## Notes\n";

#[derive(Serialize)]
pub struct Document {
    path: String,
    title: String,
    text: String,
    writable: bool,
    todo_lines: Option<Vec<usize>>,
}
#[derive(Serialize)]
pub struct Release {
    platform: String,
    tag: String,
    at: String,
    pending: Option<u32>,
    changes: Vec<String>,
}
#[derive(Serialize)]
pub struct Todo {
    path: String,
    line: usize,
    state: String,
    text: String,
}
#[derive(Serialize)]
pub struct Overview {
    id: String,
    name: String,
    group: String,
    releases: Vec<ReleaseSummary>,
    open_todos: usize,
    blocked_todos: usize,
    release_target: String,
    dirty_count: usize,
    latest_commit_at: String,
    errors: Vec<String>,
}
#[derive(Serialize)]
struct ReleaseSummary {
    platform: String,
    tag: String,
    at: String,
    pending: Option<u32>,
}
#[derive(Serialize)]
pub struct Desk {
    todos: Vec<Todo>,
    release_target: String,
    latest_commit_at: String,
    documents: Vec<Document>,
    releases: Vec<Release>,
    recent: Vec<String>,
    dirty: Vec<String>,
    errors: Vec<String>,
}
fn project(id: &str) -> Result<Project, String> {
    crate::find_project(id)
}
fn desk_path(p: &Project) -> PathBuf {
    // Hex preserves identity, including punctuation and case, without path traversal.
    let key: String =
        p.id.as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
    crate::paths::brain_dir()
        .join("projects")
        .join(key)
        .join("desk.md")
}
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::platform::command("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}
fn add_document(
    out: &mut Vec<Document>,
    path: PathBuf,
    title: String,
    writable: bool,
) -> Result<(), String> {
    if out.iter().any(|d| Path::new(&d.path) == path) || !path.is_file() {
        return Ok(());
    }
    let path = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    out.push(Document {
        path: path.to_string_lossy().into_owned(),
        title,
        text,
        writable,
        todo_lines: None,
    });
    Ok(())
}
fn documents(p: &Project) -> Result<Vec<Document>, String> {
    let path = desk_path(p);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => EMPTY.into(),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = vec![Document {
        path: path.to_string_lossy().into_owned(),
        title: "Todos & notes".into(),
        text,
        writable: true,
        todo_lines: None,
    }];
    add_document(
        &mut out,
        crate::paths::brain_dir()
            .join("reports")
            .join(format!("{}.md", crate::reports::safe_key(&p.id))),
        "Agent reports".into(),
        false,
    )?;
    if let Some(ops) = crate::ops::ops_dir_for(Some(p)) {
        let root = ops.parent().unwrap_or(&ops);
        let keys: Vec<String> = crate::sprints::portfolio(&ops)
            .into_iter()
            .filter(|(_, _, dir)| {
                !dir.is_empty() && {
                    let folder = root.join(dir);
                    p.path == folder || p.path.starts_with(&folder)
                }
            })
            .map(|(key, _, _)| key)
            .collect();
        // Frontmatter keys also cover aliases such as dream_commenter → hayrola.md.
        for area in ["apps", "work", "behavior", "sprints"] {
            let Ok(entries) = fs::read_dir(ops.join(area)) else {
                continue;
            };
            let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
            paths.sort();
            for path in paths {
                if path.extension().and_then(|s| s.to_str()) != Some("md")
                    || path.file_name().is_some_and(|s| s == "_template.md")
                {
                    continue;
                }
                let text = fs::read_to_string(&path).unwrap_or_default();
                let stem = path.file_stem().unwrap_or_default().to_string_lossy();
                let matches = keys.iter().any(|key| {
                    stem == key.as_str()
                        || stem.starts_with(&format!("{key}-"))
                        || text.lines().any(|line| {
                            (line.starts_with("ref:")
                                && line.split(['[', ']', ',', ' ']).any(|part| part == key))
                                || line.trim() == format!("key: {key}")
                                || line.trim() == format!("app: {key}")
                                || (area == "sprints" && line.contains(&format!(" {key} |")))
                        })
                });
                if matches {
                    add_document(&mut out, path.clone(), format!("{area}/{stem}"), true)?;
                    if area == "sprints" {
                        if let Some(doc) = out.last_mut() {
                            doc.todo_lines = Some(
                                doc.text
                                    .lines()
                                    .enumerate()
                                    .filter(|(_, line)| {
                                        keys.iter().any(|key| line.contains(&format!(" {key} |")))
                                    })
                                    .map(|(i, _)| i)
                                    .collect(),
                            );
                        }
                    }
                }
            }
        }
    }
    for file in ["TODO.md", "WORK.md", "docs/RELEASE.md", "CHANGELOG.md"] {
        add_document(&mut out, p.path.join(file), file.into(), true)?;
    }
    Ok(out)
}
// A single parser feeds both the project view and portfolio counts. Fenced examples
// are never tasks; shared sprint documents only expose their assigned project rows.
fn parse_memory(documents: &[Document]) -> (Vec<Todo>, String) {
    let mut todos = Vec::new();
    let mut target = String::new();
    for (document_index, doc) in documents.iter().enumerate() {
        let mut fence: Option<(char, usize)> = None;
        for (line_index, line) in doc.text.lines().enumerate() {
            let trimmed = line.trim_start();
            let marker = trimmed.chars().next().unwrap_or(' ');
            let length = trimmed.chars().take_while(|c| *c == marker).count();
            if let Some((open, minimum)) = fence {
                if marker == open && length >= minimum && trimmed[length..].trim().is_empty() {
                    fence = None;
                }
                continue;
            }
            if matches!(marker, '`' | '~') && length >= 3 {
                fence = Some((marker, length));
                continue;
            }
            if document_index == 0 {
                if let Some(value) = trimmed.strip_prefix("Release target:") {
                    if target.is_empty() {
                        target = value.trim().to_string();
                    }
                }
            }
            if !doc.writable
                || doc
                    .todo_lines
                    .as_ref()
                    .is_some_and(|lines| !lines.contains(&line_index))
            {
                continue;
            }
            let Some(rest) = trimmed
                .strip_prefix("- [")
                .or_else(|| trimmed.strip_prefix("* ["))
            else {
                continue;
            };
            let Some((mark, text)) = rest.split_once("] ") else {
                continue;
            };
            let state = match mark {
                " " => "todo",
                "x" | "X" => "done",
                "!" => "blocked",
                _ => continue,
            };
            let text = if doc.todo_lines.is_some() {
                let goal = text.splitn(3, '|').nth(2).unwrap_or(text).trim();
                goal.split_once("[done-when:")
                    .map(|(label, _)| label.trim())
                    .unwrap_or(goal)
            } else {
                text.trim()
            };
            todos.push(Todo {
                path: doc.path.clone(),
                line: line_index,
                state: state.into(),
                text: text.into(),
            });
        }
    }
    (todos, target)
}
fn release(root: &Path, platform: &str, tags: &str, detail: bool) -> Result<Release, String> {
    let tag = tags
        .lines()
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            if platform == "ios" || platform == "android" {
                lower.contains(&format!("-{platform}-v"))
            } else {
                lower.starts_with('v') && lower.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
            }
        })
        .unwrap_or("")
        .to_string();
    let mut value = Release {
        platform: platform.into(),
        tag,
        at: String::new(),
        pending: None,
        changes: vec![],
    };
    if value.tag.is_empty() {
        return Ok(value);
    }
    let reference = format!("refs/tags/{}", value.tag);
    value.at = git(
        root,
        &[
            "for-each-ref",
            "--format=%(creatordate:iso-strict)",
            &reference,
        ],
    )?;
    let range = format!("{reference}..HEAD");
    value.pending = git(root, &["rev-list", "--count", &range])?.parse().ok();
    if detail {
        value.changes = git(root, &["log", "-30", "--format=%h · %s", &range])?
            .lines()
            .map(str::to_string)
            .collect();
    }
    Ok(value)
}
fn read(id: &str) -> Result<Desk, String> {
    read_project(&project(id)?, true)
}
fn read_project(p: &Project, detail: bool) -> Result<Desk, String> {
    let mut errors = Vec::new();
    let documents = documents(p).unwrap_or_else(|error| {
        errors.push(error);
        Vec::new()
    });
    let (todos, release_target) = parse_memory(&documents);
    let mut desk = Desk {
        todos,
        release_target,
        latest_commit_at: String::new(),
        documents,
        releases: vec![],
        recent: vec![],
        dirty: vec![],
        errors,
    };
    // Containers can hold separate iOS and Android repositories.
    let mut roots = vec![];
    if p.path.join(".git").exists() {
        roots.push(("project", p.path.clone()));
    }
    for platform in ["ios", "android"] {
        let root = p.path.join(platform);
        if root.join(".git").exists() {
            roots.push((platform, root));
        }
    }
    if roots.is_empty() {
        desk.errors
            .push("No Git repository found. Release history is unknown.".into());
    }
    for (label, root) in roots {
        let result = (|| -> Result<(), String> {
            let tags = git(&root, &["tag", "--merged", "HEAD", "--sort=-creatordate"])?;
            let mut found = false;
            for platform in ["ios", "android", "project"] {
                let item = release(&root, platform, &tags, detail)?;
                if !item.tag.is_empty() {
                    found = true;
                    desk.releases.push(Release {
                        platform: if platform == "project" {
                            label.into()
                        } else {
                            platform.into()
                        },
                        ..item
                    });
                }
            }
            if !found {
                desk.releases.push(release(&root, label, "", detail)?);
            }
            desk.dirty.extend(
                git(&root, &["status", "--porcelain"])?
                    .lines()
                    .map(|line| format!("{label} · {line}")),
            );
            let latest = git(&root, &["log", "-1", "--format=%cI"])?;
            if latest > desk.latest_commit_at {
                desk.latest_commit_at = latest;
            }
            if detail {
                desk.recent.extend(
                    git(&root, &["log", "-15", "--format=%cI · %h · %s"])?
                        .lines()
                        .map(|line| format!("{line} · {label}")),
                );
            }
            Ok(())
        })();
        if let Err(error) = result {
            desk.errors.push(format!("{label}: {error}"));
        }
    }
    desk.recent.sort_by(|a, b| b.cmp(a));
    desk.recent.truncate(20);
    Ok(desk)
}
fn overview_project(p: &Project) -> Result<Overview, String> {
    let desk = read_project(p, false)?;
    Ok(Overview {
        id: p.id.clone(),
        name: p.name.clone(),
        group: p.group.clone(),
        open_todos: desk
            .todos
            .iter()
            .filter(|todo| todo.state != "done")
            .count(),
        blocked_todos: desk
            .todos
            .iter()
            .filter(|todo| todo.state == "blocked")
            .count(),
        release_target: desk.release_target,
        dirty_count: desk.dirty.len(),
        latest_commit_at: desk.latest_commit_at,
        errors: desk.errors,
        releases: desk
            .releases
            .into_iter()
            .map(|release| ReleaseSummary {
                platform: release.platform,
                tag: release.tag,
                at: release.at,
                pending: release.pending,
            })
            .collect(),
    })
}
#[tauri::command]
pub async fn project_desk_overview() -> Result<Vec<Overview>, String> {
    crate::off_main(move || {
        let projects = crate::all_projects();
        let mut result = Vec::with_capacity(projects.len());
        // Each worker runs Git sequentially. At most four repositories run together.
        for batch in projects.chunks(4) {
            let summaries = std::thread::scope(|scope| {
                let workers: Vec<_> = batch
                    .iter()
                    .map(|project| scope.spawn(move || overview_project(project)))
                    .collect();
                workers
                    .into_iter()
                    .map(|worker| {
                        worker
                            .join()
                            .map_err(|_| "Project overview worker failed".to_string())?
                    })
                    .collect::<Result<Vec<_>, String>>()
            })?;
            result.extend(summaries);
        }
        Ok(result)
    })
    .await
}
#[tauri::command]
pub async fn project_desk(project: String) -> Result<Desk, String> {
    crate::off_main(move || read(&project)).await
}
#[tauri::command]
pub async fn project_desk_save(
    project: String,
    path: String,
    text: String,
    expect: String,
) -> Result<Desk, String> {
    crate::off_main(move || {
        let _guard = WRITER.lock().map_err(|e| e.to_string())?;
        let p = self::project(&project)?;
        let doc = documents(&p)?
            .into_iter()
            .find(|d| d.path == path && d.writable)
            .ok_or("This document cannot be edited here")?;
        if doc.text != expect {
            return Err(
                "File changed outside Panel. Your draft is kept. Copy it before reloading.".into(),
            );
        }
        let path = PathBuf::from(path);
        fs::create_dir_all(path.parent().ok_or("Missing parent folder")?)
            .map_err(|e| e.to_string())?;
        let temp = path.with_extension(format!("save-{}", uuid::Uuid::new_v4()));
        fs::write(&temp, text).map_err(|e| e.to_string())?;
        // Recheck immediately before replacement for editors outside this process.
        let current = fs::read_to_string(&path)
            .or_else(|e| {
                if e.kind() == std::io::ErrorKind::NotFound && path == desk_path(&p) {
                    Ok(EMPTY.into())
                } else {
                    Err(e)
                }
            })
            .map_err(|e| e.to_string())?;
        if current != expect {
            let _ = fs::remove_file(temp);
            return Err("File changed outside Panel. Your draft is kept.".into());
        }
        fs::rename(&temp, &path).map_err(|e| {
            let _ = fs::remove_file(&temp);
            e.to_string()
        })?;
        read_project(&p, true)
    })
    .await
}
