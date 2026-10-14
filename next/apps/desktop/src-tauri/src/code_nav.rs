//! Lightweight project navigation for the Work editor.
//!
//! This deliberately is not an LSP. Panel hosts mixed repositories and needs navigation before
//! a language server is configured. Exact local import paths are the strongest signal; matching a
//! type defined in one file and used in another is the cross-language fallback (and is especially
//! useful for Swift, where source files do not import one another).

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const MAX_FILES: usize = 6_000;
const MAX_CACHED_PROJECTS: usize = 3;
const MAX_TEXT_BYTES: u64 = 750_000;
const MAX_RELATIONS: usize = 40;
const MAX_DEFINITIONS: usize = 24;
/// Enough to prove the shape of a result set. Past this the answer is "narrow the query", and
/// building ten thousand DOM rows to say so is worse than saying so.
const MAX_SEARCH_HITS: usize = 400;
/// One file cannot own the whole budget. A generated bundle with 900 matches must not push every
/// other file out of the result list.
const MAX_HITS_PER_FILE: usize = 20;
/// A hit line is shown, not read. Longer than this and it is a minified blob, not source.
const MAX_HIT_LINE: usize = 400;

const SKIP_DIRS: &[&str] = &[
    ".git",
    ".dart_tool",
    ".build",
    ".gradle",
    ".idea",
    ".next",
    ".nuxt",
    ".swiftpm",
    ".venv",
    "Pods",
    "DerivedData",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "venv",
];

const SOURCE_EXTENSIONS: &[&str] = &[
    "c",
    "cc",
    "conf",
    "cpp",
    "css",
    "cxx",
    "dart",
    "go",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsonc",
    "jsx",
    "kt",
    "kts",
    "less",
    "md",
    "mdx",
    "mjs",
    "php",
    "properties",
    "py",
    "pyi",
    "rb",
    "rs",
    "sass",
    "scss",
    "sh",
    "sql",
    "swift",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
    "zsh",
];

const DEFINITION_WORDS: &[&str] = &[
    "actor",
    "class",
    "const",
    "def",
    "enum",
    "extension",
    "fn",
    "fun",
    "func",
    "function",
    "interface",
    "mixin",
    "protocol",
    "struct",
    "trait",
    "type",
    "typealias",
    "typedef",
];

/// Where symbol colouring may learn names from. Prose and config would teach it nonsense: "the
/// type system" in a README is not a declaration of `system`.
const SYMBOL_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cxx", "dart", "go", "h", "hpp", "java", "js", "jsx", "kt", "kts", "mjs",
    "php", "py", "pyi", "rb", "rs", "swift", "ts", "tsx",
];

/// Past this a project is generated code, and the editor would rather colour less than wait.
const MAX_PROJECT_SYMBOLS: usize = 40_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileRelation {
    pub path: String,
    pub line: u32,
    /// `outgoing`: the open file uses it. `incoming`: it uses the open file.
    pub direction: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SymbolLocation {
    pub path: String,
    pub line: u32,
    pub detail: String,
}

/// A name the project itself declares, for the editor's Xcode-style colouring (project symbols
/// one hue, everything the SDK brings another) and for Open Quickly.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectSymbol {
    pub name: String,
    pub path: String,
    pub line: u32,
    /// `class`, `struct`, `enum`, `protocol`, `type`, `function` or `constant`.
    pub kind: &'static str,
}

/// One matching line. `column` is a 1-indexed CHAR offset, not a byte offset — the frontend
/// slices JS strings with it, and a byte offset lands mid-character the first time a match sits
/// after an emoji or an accent.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub column: u32,
    /// The whole line, trimmed of leading indentation so the result list has a left edge.
    pub text: String,
    /// Length of the match in chars, so the UI can mark it without re-running the query.
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// How many files actually carried a match, even if their hits were capped away.
    pub files: u32,
    /// True when a cap stopped the walk. The UI says so instead of implying completeness.
    pub truncated: bool,
}

#[derive(Debug, Clone)]
struct SourceFile {
    absolute: PathBuf,
    relative: String,
}

#[derive(Debug, Clone)]
struct RankedRelation {
    relation: FileRelation,
    score: u8,
}

/* ---------------------------------------------------------------- the facts cache */

/// What `relationships` needs from one file, parsed once and kept until the file changes.
///
/// The scan used to read and tokenize every file in the project on every open. On a 6,000-file
/// repository that was seconds of "Looking…" under the tabs each time, for an answer that had
/// not changed. Now a file is parsed when it is new or its mtime moved, and a call is one stat
/// per file plus lookups in these tables.
#[derive(Debug, Default)]
struct FileFacts {
    literals: Vec<(String, u32)>,
    definitions: Vec<(String, u32)>,
    /// The subset of `definitions` worth colouring project-wide, with what kind of name each is.
    symbols: Vec<(String, u32, &'static str)>,
    /// Every identifier and the first line it appears on.
    idents: HashMap<String, u32>,
    /// Lines carrying import vocabulary, with the identifiers on them — for unquoted imports.
    imports: Vec<(u32, Vec<String>)>,
}

impl FileFacts {
    fn parse(text: &str) -> Self {
        let mut idents: HashMap<String, u32> = HashMap::new();
        let mut imports = Vec::new();
        for (line_index, line) in text.lines().enumerate() {
            let number = (line_index + 1) as u32;
            let words: Vec<&str> = line
                .split(|character: char| {
                    !character.is_alphanumeric() && character != '_' && character != '$'
                })
                .filter(|word| is_identifier(word))
                .collect();
            for word in &words {
                idents.entry((*word).to_string()).or_insert(number);
            }
            if ["import ", "from ", "use ", "mod ", "#include"]
                .iter()
                .any(|keyword| line.contains(keyword))
            {
                imports.push((number, words.iter().map(|word| (*word).to_string()).collect()));
            }
        }
        let declared = declarations(text);
        let symbols = declared
            .iter()
            .filter_map(|item| symbol_kind(item).map(|kind| (item.name.clone(), item.line, kind)))
            .collect();
        Self {
            literals: quoted_literals(text),
            definitions: declared.into_iter().map(|item| (item.name, item.line)).collect(),
            symbols,
            idents,
            imports,
        }
    }

    fn import_line_for(&self, stem: &str) -> Option<u32> {
        self.imports
            .iter()
            .find(|(_, words)| words.iter().any(|word| word == stem))
            .map(|(line, _)| *line)
    }
}

#[derive(Debug)]
struct CachedFile {
    absolute: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    /// None for a file that is not text we read — binary, or past the size cap.
    facts: Option<FileFacts>,
}

type ProjectFacts = HashMap<String, CachedFile>;

#[derive(Default)]
struct FactsCache {
    projects: HashMap<PathBuf, ProjectFacts>,
    recent: VecDeque<PathBuf>,
}

impl FactsCache {
    fn project(&mut self, root: &Path) -> &mut ProjectFacts {
        self.recent.retain(|path| path != root);
        self.recent.push_back(root.to_path_buf());
        while self.recent.len() > MAX_CACHED_PROJECTS {
            if let Some(oldest) = self.recent.pop_front() {
                self.projects.remove(&oldest);
            }
        }
        self.projects.entry(root.to_path_buf()).or_default()
    }
}

fn facts_cache() -> &'static Mutex<FactsCache> {
    static CACHE: OnceLock<Mutex<FactsCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(FactsCache::default()))
}

/// Bring one project's facts up to date: a stat per file, a parse per changed file, and the
/// files that left the disk leave the table.
fn refresh_facts(project: &mut ProjectFacts, root: &Path) {
    let files = project_files(root);
    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    for file in files {
        let Ok(metadata) = fs::metadata(&file.absolute) else {
            continue;
        };
        let modified = metadata.modified().ok();
        let len = metadata.len();
        seen.insert(file.relative.clone());
        if let Some(existing) = project.get(&file.relative) {
            if existing.modified == modified && existing.len == len {
                continue;
            }
        }
        let facts = if len <= MAX_TEXT_BYTES && searchable_name(&file.absolute) {
            fs::read_to_string(&file.absolute)
                .ok()
                .map(|text| FileFacts::parse(&text))
        } else {
            None
        };
        project.insert(
            file.relative,
            CachedFile {
                absolute: file.absolute,
                modified,
                len,
                facts,
            },
        );
    }
    project.retain(|relative, _| seen.contains(relative));
}

/// Parse the project ahead of the first open, so the Related row answers at once.
pub fn warm(root: &Path) -> Result<(), String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut cache = facts_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    refresh_facts(cache.project(&root), &root);
    Ok(())
}

/// The project's files, shaped for resolving import literals: exact paths, and paths by their
/// last segment so an alias like `@/lib/x` is matched against a handful of files, not all of them.
struct LiteralIndex {
    paths: HashSet<String>,
    by_name: HashMap<String, Vec<String>>,
}

impl LiteralIndex {
    fn new<'a>(paths: impl Iterator<Item = &'a String>) -> Self {
        let mut all = HashSet::new();
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for path in paths {
            all.insert(path.clone());
            let name = path.rsplit('/').next().unwrap_or(path).to_string();
            by_name.entry(name).or_default().push(path.clone());
        }
        Self {
            paths: all,
            by_name,
        }
    }
}

pub fn relationships(root: &Path, current: &Path) -> Result<Vec<FileRelation>, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let current = current.canonicalize().map_err(|error| error.to_string())?;
    if !current.starts_with(&root) {
        return Err("file escaped the selected project".into());
    }
    let current_relative = relative_path(&root, &current)?;

    let mut cache = facts_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let project = cache.project(&root);
    refresh_facts(project, &root);
    let index = LiteralIndex::new(project.keys());

    // Binary/media files have no outgoing code edges, but source files may still reference them.
    // A file the walk does not list (a dotfile, say) is parsed on the spot.
    let own_facts;
    let current_facts: &FileFacts = match project.get(&current_relative).and_then(|cached| cached.facts.as_ref()) {
        Some(facts) => facts,
        None => {
            own_facts = read_source(&current)
                .map(|text| FileFacts::parse(&text))
                .unwrap_or_default();
            &own_facts
        }
    };

    let current_dir = Path::new(&current_relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let direct_outgoing = resolved_literals(&current_facts.literals, current_dir, &index);
    let current_definitions = &current_facts.definitions;
    let current_definition_names: HashSet<&str> = current_definitions
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    let current_words = &current_facts.idents;
    let current_stem = current
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    // A literal can only resolve to the open file if it names it: by stem, or — for an
    // `index.*` file — by the folder that stands for it. Everything else is skipped unresolved.
    let current_folder = current_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let names_current = |literal: &str| {
        (!current_stem.is_empty() && literal.contains(current_stem))
            || (current_stem == "index" && !current_folder.is_empty() && literal.contains(current_folder))
    };

    let mut found: HashMap<(String, String), RankedRelation> = HashMap::new();
    for (path, _) in direct_outgoing {
        if path == current_relative {
            continue;
        }
        insert_relation(
            &mut found,
            FileRelation {
                path,
                line: 1,
                direction: "outgoing".into(),
                detail: "referenced by this file".into(),
            },
            4,
        );
    }

    for (relative, cached) in project.iter() {
        if *relative == current_relative {
            continue;
        }
        let Some(facts) = cached.facts.as_ref() else {
            continue;
        };
        let candidate_dir = Path::new(relative)
            .parent()
            .unwrap_or_else(|| Path::new(""));

        // Exact path/import reference from the candidate back to the open file.
        let back_reference = facts
            .literals
            .iter()
            .filter(|(literal, _)| names_current(literal))
            .find(|(literal, _)| {
                resolve_literal(literal, candidate_dir, &index).as_deref() == Some(current_relative.as_str())
            })
            .map(|(_, line)| *line);
        if let Some(line) = back_reference {
            insert_relation(
                &mut found,
                FileRelation {
                    path: relative.clone(),
                    line,
                    direction: "incoming".into(),
                    detail: "references this file".into(),
                },
                4,
            );
        } else if !current_stem.is_empty() {
            // Python/Rust/C-family imports are commonly unquoted. Require both the file stem and
            // import vocabulary on one line to avoid treating ordinary prose as a dependency.
            if let Some(line) = facts.import_line_for(current_stem) {
                insert_relation(
                    &mut found,
                    FileRelation {
                        path: relative.clone(),
                        line,
                        direction: "incoming".into(),
                        detail: "references this file".into(),
                    },
                    3,
                );
            }
        }

        // A type defined in the candidate and mentioned by the open file is an outgoing edge.
        if let Some((name, _)) = facts.definitions.iter().find(|(name, _)| {
            is_type_name(name)
                && current_words.contains_key(name)
                && !current_definition_names.contains(name.as_str())
        }) {
            insert_relation(
                &mut found,
                FileRelation {
                    path: relative.clone(),
                    line: facts.idents.get(name).copied().unwrap_or(1),
                    direction: "outgoing".into(),
                    detail: format!("defines {name}, used by this file"),
                },
                2,
            );
        }

        // A type defined by the open file and mentioned elsewhere is an incoming edge.
        if let Some((name, line)) = current_definitions
            .iter()
            .filter(|(name, _)| is_type_name(name))
            .find_map(|(name, _)| facts.idents.get(name).map(|line| (name, *line)))
        {
            insert_relation(
                &mut found,
                FileRelation {
                    path: relative.clone(),
                    line,
                    direction: "incoming".into(),
                    detail: format!("uses {name} from this file"),
                },
                2,
            );
        }
    }

    let mut ranked: Vec<RankedRelation> = found.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.relation.direction.cmp(&b.relation.direction))
            .then_with(|| a.relation.path.cmp(&b.relation.path))
    });
    Ok(ranked
        .into_iter()
        .take(MAX_RELATIONS)
        .map(|ranked| ranked.relation)
        .collect())
}

pub fn symbol_locations(
    root: &Path,
    current: &Path,
    symbol: &str,
) -> Result<Vec<SymbolLocation>, String> {
    let symbol = symbol.trim();
    if !is_identifier(symbol) || symbol.len() > 128 {
        return Ok(Vec::new());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let current = current.canonicalize().map_err(|error| error.to_string())?;
    if !current.starts_with(&root) {
        return Err("file escaped the selected project".into());
    }
    let mut matches = Vec::<(u8, SymbolLocation)>::new();
    let mut cache = facts_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let project = cache.project(&root);
    refresh_facts(project, &root);
    for (relative, cached) in project.iter() {
        let Some(facts) = cached.facts.as_ref() else {
            continue;
        };
        for (name, line) in &facts.definitions {
            if name != symbol {
                continue;
            }
            let same_file = cached.absolute == current;
            let stem_match = cached
                .absolute
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.eq_ignore_ascii_case(symbol));
            let score = (if stem_match { 2 } else { 0 }) + (if same_file { 1 } else { 0 });
            let detail = read_source(&cached.absolute)
                .map(|text| definition_detail(&text, *line))
                .unwrap_or_else(|| "definition".into());
            matches.push((
                score,
                SymbolLocation {
                    path: relative.clone(),
                    line: *line,
                    detail,
                },
            ));
        }
    }
    matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    matches.dedup_by(|a, b| a.1.path == b.1.path && a.1.line == b.1.line);
    Ok(matches
        .into_iter()
        .take(MAX_DEFINITIONS)
        .map(|(_, location)| location)
        .collect())
}

/// Every name the project declares, for symbol colouring and Open Quickly. Served from the same
/// facts cache go-to-definition uses, so a warm project answers with one stat per file.
pub fn project_symbols(root: &Path) -> Result<Vec<ProjectSymbol>, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut cache = facts_cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let project = cache.project(&root);
    refresh_facts(project, &root);
    let mut symbols = Vec::new();
    for (relative, cached) in project.iter() {
        let Some(facts) = cached.facts.as_ref() else {
            continue;
        };
        let code = Path::new(relative)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| SYMBOL_EXTENSIONS.contains(&extension));
        if !code || relative.split('/').any(|part| part.starts_with('.')) {
            continue;
        }
        for (name, line, kind) in &facts.symbols {
            symbols.push(ProjectSymbol {
                name: name.clone(),
                path: relative.clone(),
                line: *line,
                kind,
            });
        }
    }
    symbols.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    symbols.truncate(MAX_PROJECT_SYMBOLS);
    Ok(symbols)
}

fn insert_relation(
    found: &mut HashMap<(String, String), RankedRelation>,
    relation: FileRelation,
    score: u8,
) {
    let key = (relation.path.clone(), relation.direction.clone());
    match found.get(&key) {
        Some(existing) if existing.score >= score => {}
        _ => {
            found.insert(key, RankedRelation { relation, score });
        }
    }
}

/// Every file under the project as a relative path, for quick open and the navigator filter.
/// The same walk go-to-definition uses, so the two never disagree about what the project holds.
/// Dot-prefixed folders and files are left out, matching the lazy tree.
pub fn list_files(root: &Path) -> Vec<String> {
    project_files(root)
        .into_iter()
        .map(|file| file.relative)
        .filter(|relative| !relative.split('/').any(|part| part.starts_with('.')))
        .collect()
}

fn project_files(root: &Path) -> Vec<SourceFile> {
    let mut files = Vec::new();
    collect_source_files(root, root, &mut files);
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    files.truncate(MAX_FILES);
    files
}

fn collect_source_files(root: &Path, dir: &Path, files: &mut Vec<SourceFile>) {
    if files.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_ref()) {
                collect_source_files(root, &path, files);
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let Ok(relative) = relative_path(root, &path) else {
            continue;
        };
        files.push(SourceFile {
            absolute: path,
            relative,
        });
    }
}

fn searchable_path(path: &Path) -> bool {
    if path
        .metadata()
        .map(|metadata| metadata.len() > MAX_TEXT_BYTES)
        .unwrap_or(true)
    {
        return false;
    }
    searchable_name(path)
}

/// The name half of `searchable_path`, for callers that already hold the size.
fn searchable_name(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if SOURCE_EXTENSIONS.contains(&extension.as_str()) {
        return true;
    }
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("Dockerfile" | "Gemfile" | "Makefile" | "Podfile")
    )
}

fn read_source(path: &Path) -> Option<String> {
    if !searchable_path(path) {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "file escaped the selected project".into())
}

fn resolved_literals(
    literals: &[(String, u32)],
    base: &Path,
    index: &LiteralIndex,
) -> Vec<(String, u32)> {
    let mut found = Vec::new();
    for (literal, line) in literals {
        if let Some(path) = resolve_literal(literal, base, index) {
            if !found.iter().any(|(existing, _)| existing == &path) {
                found.push((path, *line));
            }
        }
    }
    found
}

fn resolve_literal(literal: &str, base: &Path, index: &LiteralIndex) -> Option<String> {
    let mut value = literal
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim()
        .replace('\\', "/");
    if value.is_empty()
        || value.contains("://")
        || value.starts_with("data:")
        || value.starts_with('#')
    {
        return None;
    }
    if let Some(stripped) = value
        .strip_prefix("@/")
        .or_else(|| value.strip_prefix("~/"))
    {
        value = stripped.to_string();
    }
    let rooted = value.starts_with('/');
    if rooted {
        value = value.trim_start_matches('/').to_string();
    }
    let relative_like = rooted || value.starts_with("./") || value.starts_with("../");
    let path = if relative_like {
        normalize_path(if rooted {
            PathBuf::from(&value)
        } else {
            base.join(&value)
        })
    } else {
        normalize_path(PathBuf::from(&value))
    };
    let path = path.to_string_lossy().replace('\\', "/");
    let mut candidates = vec![path.clone()];
    if Path::new(&path).extension().is_none() {
        for extension in SOURCE_EXTENSIONS {
            candidates.push(format!("{path}.{extension}"));
        }
        for extension in SOURCE_EXTENSIONS {
            candidates.push(format!("{path}/index.{extension}"));
        }
    }
    if let Some(exact) = candidates
        .iter()
        .find(|candidate| index.paths.contains(*candidate))
    {
        return Some(exact.clone());
    }
    if relative_like {
        return None;
    }
    // Root/module aliases vary by project. Accept a suffix only when it identifies one file.
    // Only files sharing the candidate's last segment can end with it, so look there alone.
    let mut matches: Vec<&String> = Vec::new();
    for candidate in &candidates {
        let name = candidate.rsplit('/').next().unwrap_or(candidate);
        let suffix = format!("/{candidate}");
        if let Some(paths) = index.by_name.get(name) {
            for path in paths {
                if path.ends_with(&suffix) && !matches.contains(&path) {
                    matches.push(path);
                }
            }
        }
    }
    (matches.len() == 1).then(|| matches[0].clone())
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            Component::Normal(value) => clean.push(value),
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    clean
}

fn quoted_literals(text: &str) -> Vec<(String, u32)> {
    let mut values = Vec::new();
    for (line_index, line) in text.lines().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        let mut index = 0;
        while index < chars.len() {
            let quote = chars[index];
            if !matches!(quote, '\'' | '"' | '`') {
                index += 1;
                continue;
            }
            index += 1;
            let mut value = String::new();
            let mut escaped = false;
            while index < chars.len() {
                let character = chars[index];
                index += 1;
                if escaped {
                    value.push(character);
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == quote {
                    break;
                } else {
                    value.push(character);
                }
            }
            if !value.is_empty() {
                values.push((value, (line_index + 1) as u32));
            }
        }
    }
    values
}

/// One `keyword name` pair, as the definition scan saw it.
struct Declaration {
    name: String,
    line: u32,
    keyword: &'static str,
    /// The line starts with whitespace — inside a body, not at the top of the file.
    indented: bool,
}

/// Every `keyword name` pair in the text. Go-to-definition reads all of them; symbol colouring
/// reads the ones `symbol_kind` keeps. One scan, so the two can never disagree about what a
/// declaration looks like.
fn declarations(text: &str) -> Vec<Declaration> {
    let mut result: Vec<Declaration> = Vec::new();
    for (line_index, line) in text.lines().enumerate() {
        let number = (line_index + 1) as u32;
        let indented = line.starts_with([' ', '\t']);
        let tokens: Vec<&str> = line
            .split(|character: char| {
                !character.is_alphanumeric() && character != '_' && character != '$'
            })
            .filter(|token| !token.is_empty())
            .collect();
        for pair in tokens.windows(2) {
            let Some(keyword) = DEFINITION_WORDS.iter().find(|word| **word == pair[0]) else {
                continue;
            };
            if !is_identifier(pair[1]) {
                continue;
            }
            // A name can only repeat on its own line, so only this line's tail is checked.
            let repeated = result
                .iter()
                .rev()
                .take_while(|item| item.line == number)
                .any(|item| item.name == pair[1]);
            if !repeated {
                result.push(Declaration {
                    name: pair[1].to_string(),
                    line: number,
                    keyword,
                    indented,
                });
            }
        }
    }
    result
}

/// What colour a declaration earns, or None when it should stay plain. An indented `const` is a
/// local — colouring every `tab` in a file because one function declared one would turn the
/// whole buffer teal. `extension String` names the SDK's type, not ours.
fn symbol_kind(item: &Declaration) -> Option<&'static str> {
    match item.keyword {
        "extension" => None,
        "def" | "fn" | "fun" | "func" | "function" => Some("function"),
        "const" if item.indented => None,
        "const" => Some("constant"),
        // The family, not just "a type": Open Quickly badges a class C and a protocol Pr.
        "actor" | "class" => Some("class"),
        "struct" => Some("struct"),
        "enum" => Some("enum"),
        "interface" | "mixin" | "protocol" | "trait" => Some("protocol"),
        _ => Some("type"),
    }
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_' || first == '$')
        && chars
            .all(|character| character.is_alphanumeric() || character == '_' || character == '$')
}

fn is_type_name(value: &str) -> bool {
    value.chars().next().is_some_and(char::is_uppercase)
}

fn definition_detail(text: &str, line: u32) -> String {
    text.lines()
        .nth(line.saturating_sub(1) as usize)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(120).collect())
        .unwrap_or_else(|| "definition".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parsed_facts_evict_the_oldest_project() {
        let mut cache = FactsCache::default();
        let roots: Vec<_> = (0..MAX_CACHED_PROJECTS)
            .map(|index| PathBuf::from(format!("/cache/project-{index}")))
            .collect();
        for root in &roots {
            cache.project(root);
        }
        cache.project(&roots[0]);
        cache.project(Path::new("/cache/new"));
        assert_eq!(cache.projects.len(), MAX_CACHED_PROJECTS);
        assert!(cache.projects.contains_key(&roots[0]));
        assert!(!cache.projects.contains_key(&roots[1]));
    }

    fn fixture() -> PathBuf {
        // macOS clocks tick in microseconds, so two parallel tests can read the same time. The
        // counter keeps their folders apart; one test's cleanup must never delete another's files.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("panel-code-nav-{id}-{serial}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/token.ts"), "export class TokenStore {}\n").unwrap();
        fs::write(
            root.join("src/auth.ts"),
            "import { TokenStore } from './token';\nexport class AuthService { store = new TokenStore(); }\n",
        )
        .unwrap();
        fs::write(
            root.join("src/app.ts"),
            "import { AuthService } from './auth';\nconst auth = new AuthService();\n",
        )
        .unwrap();
        fs::write(
            root.join("src/LoginView.swift"),
            "final class LoginView { let service: SessionService }\n",
        )
        .unwrap();
        fs::write(
            root.join("src/SessionService.swift"),
            "final class SessionService {}\n",
        )
        .unwrap();
        fs::write(root.join("src/logo.png"), [0, 159, 146, 150]).unwrap();
        fs::write(
            root.join("src/header.ts"),
            "import logo from './logo.png';\nexport const header = logo;\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn finds_exact_imports_in_both_directions() {
        let root = fixture();
        let relations = relationships(&root, &root.join("src/auth.ts")).unwrap();
        assert!(relations.iter().any(|relation| {
            relation.path == "src/token.ts" && relation.direction == "outgoing"
        }));
        assert!(relations
            .iter()
            .any(|relation| { relation.path == "src/app.ts" && relation.direction == "incoming" }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn type_usage_connects_swift_files_without_imports() {
        let root = fixture();
        let relations = relationships(&root, &root.join("src/LoginView.swift")).unwrap();
        assert!(relations.iter().any(|relation| {
            relation.path == "src/SessionService.swift" && relation.direction == "outgoing"
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbol_lookup_prefers_the_definition_file() {
        let root = fixture();
        let locations = symbol_locations(&root, &root.join("src/app.ts"), "AuthService").unwrap();
        assert_eq!(locations[0].path, "src/auth.ts");
        assert_eq!(locations[0].line, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn swift_functions_are_definitions() {
        let root = fixture();
        fs::write(
            root.join("src/Loader.swift"),
            "struct Loader {\n    func reload(force: Bool) {}\n}\n",
        )
        .unwrap();
        let locations = symbol_locations(&root, &root.join("src/app.ts"), "reload").unwrap();
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].path, "src/Loader.swift");
        assert_eq!(locations[0].line, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_symbols_keep_declarations_and_drop_locals_and_prose() {
        let root = fixture();
        fs::write(
            root.join("src/view.ts"),
            "export const VIEW_LIMIT = 3;\nexport function paint() {\n  const local = 1;\n}\n",
        )
        .unwrap();
        fs::write(root.join("README.md"), "The type system is simple.\n").unwrap();
        fs::write(root.join("src/More.swift"), "extension String {}\n").unwrap();
        let symbols = project_symbols(&root).unwrap();
        let kind = |name: &str| symbols.iter().find(|item| item.name == name).map(|item| item.kind);
        assert_eq!(kind("VIEW_LIMIT"), Some("constant"));
        assert_eq!(kind("paint"), Some("function"));
        assert_eq!(kind("SessionService"), Some("class"));
        assert_eq!(kind("local"), None);
        assert_eq!(kind("system"), None);
        assert_eq!(kind("String"), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_references_are_visible_from_a_media_file() {
        let root = fixture();
        let relations = relationships(&root, &root.join("src/logo.png")).unwrap();
        assert!(relations.iter().any(|relation| {
            relation.path == "src/header.ts" && relation.direction == "incoming"
        }));
        fs::remove_dir_all(root).unwrap();
    }
}


/* ------------------------------------------------------------------- search */

/// Repository-wide plain-text search over the same files the navigator already walks.
///
/// Deliberately not a regex engine and not an index. Panel opens arbitrary repositories with no
/// warm-up, so the honest primitive is one cold pass with hard caps — the same walker, the same
/// `SKIP_DIRS`, the same "is this text" test used for go-to-definition. Consistency matters more
/// than speed here: a file you cannot search is a file you also cannot navigate, and a user
/// should never have to learn two different ideas of what "the project" contains.
///
/// `case_sensitive` off is the default because it is what you want when hunting a symbol you
/// half-remember. Matching is non-overlapping, left to right.
pub fn search(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<SearchResult, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            files: 0,
            truncated: false,
        });
    }

    let folded = if case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };
    let needle_chars: Vec<char> = folded.chars().collect();

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut files = 0u32;
    let mut truncated = false;

    for file in project_files(&root) {
        if hits.len() >= MAX_SEARCH_HITS {
            truncated = true;
            break;
        }
        let Some(text) = read_source(&file.absolute) else {
            continue;
        };
        let mut in_this_file = 0usize;

        for (index, raw) in text.lines().enumerate() {
            if in_this_file >= MAX_HITS_PER_FILE || hits.len() >= MAX_SEARCH_HITS {
                break;
            }
            // Compare against a folded copy but always REPORT offsets against the original, so
            // the column the UI highlights is the column the user sees.
            let hay = if case_sensitive {
                raw.to_string()
            } else {
                raw.to_lowercase()
            };
            // Lowercasing can change byte length (İ, ﬁ), which would make byte offsets from the
            // folded line meaningless against the original. Char offsets survive it.
            let hay_chars: Vec<char> = hay.chars().collect();
            if needle_chars.is_empty() || hay_chars.len() != raw.chars().count() {
                continue;
            }
            let raw_chars: Vec<char> = raw.chars().collect();

            let mut at = 0usize;
            while at + needle_chars.len() <= hay_chars.len() {
                if hay_chars[at..at + needle_chars.len()] != needle_chars[..] {
                    at += 1;
                    continue;
                }
                if whole_word && !is_word_bounded(&hay_chars, at, needle_chars.len()) {
                    at += 1;
                    continue;
                }
                let indent = raw_chars.iter().take_while(|c| c.is_whitespace()).count();
                // A match inside the indentation cannot be trimmed away, so it pins the trim.
                let trim = indent.min(at);
                let mut shown: String = raw_chars[trim..].iter().collect();
                shown.truncate_chars(MAX_HIT_LINE);
                hits.push(SearchHit {
                    path: file.relative.clone(),
                    line: index as u32 + 1,
                    column: (at - trim) as u32 + 1,
                    text: shown,
                    length: needle_chars.len() as u32,
                });
                in_this_file += 1;
                at += needle_chars.len();
                if in_this_file >= MAX_HITS_PER_FILE || hits.len() >= MAX_SEARCH_HITS {
                    truncated = true;
                    break;
                }
            }
        }
        if in_this_file > 0 {
            files += 1;
        }
    }

    Ok(SearchResult {
        hits,
        files,
        truncated,
    })
}

/// A word match is one whose neighbours are not identifier characters. `_` counts as a word
/// character, so `read_file` is one word and searching `file` with whole-word off is how you
/// find it.
fn is_word_bounded(chars: &[char], at: usize, length: usize) -> bool {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let before = at == 0 || !is_word(chars[at - 1]);
    let after = at + length >= chars.len() || !is_word(chars[at + length]);
    before && after
}

trait TruncateChars {
    fn truncate_chars(&mut self, max: usize);
}

impl TruncateChars for String {
    fn truncate_chars(&mut self, max: usize) {
        if self.chars().count() <= max {
            return;
        }
        let cut = self
            .char_indices()
            .nth(max)
            .map(|(index, _)| index)
            .unwrap_or(self.len());
        self.truncate(cut);
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("panel-search-{id}"));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(
            root.join("src/app.ts"),
            "const readFile = 1;\n  readFile();\nother\n",
        )
        .unwrap();
        fs::write(root.join("src/other.ts"), "// READFILE mentioned\n").unwrap();
        fs::write(root.join("node_modules/x.ts"), "readFile everywhere\n").unwrap();
        root
    }

    #[test]
    fn it_skips_ignored_directories_and_folds_case_by_default() {
        let root = fixture();
        let found = search(&root, "readfile", false, false).unwrap();
        assert!(!found
            .hits
            .iter()
            .any(|hit| hit.path.contains("node_modules")));
        assert_eq!(found.files, 2);
        assert_eq!(found.hits.len(), 3);
    }

    #[test]
    fn a_case_sensitive_query_drops_the_shouted_copy() {
        let root = fixture();
        let found = search(&root, "readFile", true, false).unwrap();
        assert_eq!(found.files, 1);
        assert_eq!(found.hits.len(), 2);
    }

    #[test]
    fn the_column_points_at_the_match_in_the_trimmed_line() {
        let root = fixture();
        let found = search(&root, "readFile", true, false).unwrap();
        // "  readFile();" loses its indent, so the match lands on column 1 of what is shown.
        let indented = found.hits.iter().find(|hit| hit.line == 2).unwrap();
        assert_eq!(indented.text, "readFile();");
        assert_eq!(indented.column, 1);
        // "const readFile = 1;" has no indent to lose, so the offset is the real one.
        let plain = found.hits.iter().find(|hit| hit.line == 1).unwrap();
        assert_eq!(plain.column, 7);
    }

    #[test]
    fn whole_word_will_not_match_inside_an_identifier() {
        let root = fixture();
        assert_eq!(search(&root, "read", true, false).unwrap().hits.len(), 2);
        assert_eq!(search(&root, "read", true, true).unwrap().hits.len(), 0);
    }
}
