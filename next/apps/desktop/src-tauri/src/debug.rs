//! Debug Adapter Protocol host.
//!
//! Panel already owns long-lived processes, project routing and device leases. Debugging uses
//! those same boundaries, but DAP speaks framed JSON over pipes rather than terminal bytes. One
//! adapter lives per project. Flutter and Dart work without configuration; other toolchains may
//! declare their adapter and launch payload in `.panel/debug.json`.

use crate::{android, leases, paths, sim, targets};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const EVENT: &str = "panel-debug-event";
static BREAKPOINT_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugProfile {
    pub id: String,
    pub name: String,
    pub adapter: String,
    pub targeted: bool,
    pub automatic: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStatus {
    pub active: bool,
    pub phase: String,
    pub thread_id: Option<i64>,
}

#[derive(Debug, Clone)]
struct ResolvedProfile {
    public: DebugProfile,
    argv: Vec<String>,
    cwd: PathBuf,
    request: String,
    configuration: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AdapterSpec {
    Command(String),
    Argv(Vec<String>),
    Detailed {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

impl AdapterSpec {
    fn argv(&self) -> Vec<String> {
        match self {
            Self::Command(command) => vec![command.clone()],
            Self::Argv(argv) => argv.clone(),
            Self::Detailed { command, args } => {
                let mut argv = vec![command.clone()];
                argv.extend(args.clone());
                argv
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct DebugManifest {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    configurations: Vec<ManifestProfile>,
}

#[derive(Debug, Deserialize)]
struct ManifestProfile {
    #[serde(default)]
    id: String,
    name: String,
    adapter: AdapterSpec,
    #[serde(default)]
    targeted: bool,
    #[serde(flatten)]
    configuration: Map<String, Value>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct BreakpointStore {
    #[serde(default = "one")]
    version: u32,
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, Vec<u32>>>,
}

#[derive(Debug, Clone)]
struct DebugResource {
    owner: String,
    address: String,
    device_id: String,
    booted_by_us: bool,
}

pub struct DebugManager {
    sessions: Arc<Mutex<HashMap<String, Arc<DebugSession>>>>,
}

impl Default for DebugManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct DebugSession {
    project: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    next_seq: AtomicI64,
    pending: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
    breakpoints: Mutex<BTreeMap<String, Vec<u32>>>,
    alive: AtomicBool,
    configured: AtomicBool,
    cleaned: AtomicBool,
    phase: Mutex<String>,
    thread_id: Mutex<Option<i64>>,
    resource: Option<DebugResource>,
    app: AppHandle,
}

impl DebugSession {
    fn send(&self, command: &str, arguments: Value) -> Result<i64, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        let mut stdin = self.stdin.lock().unwrap();
        write_message(&mut *stdin, &message)?;
        Ok(seq)
    }

    fn request(&self, command: &str, arguments: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        self.pending.lock().unwrap().insert(seq, tx);
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        let mut stdin = self.stdin.lock().unwrap();
        if let Err(error) = write_message(&mut *stdin, &message) {
            self.pending.lock().unwrap().remove(&seq);
            return Err(error);
        }
        drop(stdin);
        let response = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| format!("debug adapter timed out during {command}"))?;
        if response
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Ok(response.get("body").cloned().unwrap_or(Value::Null))
        } else {
            Err(response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("debug adapter rejected the request")
                .to_string())
        }
    }

    fn configure(&self) {
        if self.configured.swap(true, Ordering::SeqCst) {
            return;
        }
        let breakpoints = self.breakpoints.lock().unwrap().clone();
        for (path, lines) in breakpoints {
            let _ = self.send(
                "setBreakpoints",
                json!({
                    "source": { "name": file_name(&path), "path": path },
                    "breakpoints": lines.into_iter().map(|line| json!({ "line": line })).collect::<Vec<_>>(),
                    "sourceModified": false,
                }),
            );
        }
        let _ = self.send("configurationDone", json!({}));
    }

    fn set_breakpoints(&self, path: String, lines: Vec<u32>) -> Result<(), String> {
        self.breakpoints
            .lock()
            .unwrap()
            .insert(path.clone(), lines.clone());
        if self.configured.load(Ordering::SeqCst) {
            self.send(
                "setBreakpoints",
                json!({
                    "source": { "name": file_name(&path), "path": path },
                    "breakpoints": lines.into_iter().map(|line| json!({ "line": line })).collect::<Vec<_>>(),
                    "sourceModified": false,
                }),
            )?;
        }
        Ok(())
    }

    fn stop(&self) {
        if self.alive.swap(false, Ordering::SeqCst) {
            let _ = self.send("disconnect", json!({ "terminateDebuggee": true }));
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.finish();
    }

    fn finish(&self) {
        if self.cleaned.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(resource) = &self.resource {
            leases::release_owner(&resource.owner);
            if resource.booted_by_us && !resource.device_id.is_empty() {
                if targets::family_of(&resource.address) == "android" {
                    android::shutdown_now(&resource.device_id);
                } else {
                    sim::shutdown_device_now(&resource.device_id);
                }
            }
        }
    }

    fn emit(&self, message: Value) {
        let _ = self.app.emit(
            EVENT,
            json!({ "project": self.project, "message": message }),
        );
    }
}

impl DebugManager {
    pub fn start(
        &self,
        app: AppHandle,
        project: &str,
        root: &Path,
        profile_id: &str,
        target_address: Option<&str>,
    ) -> Result<DebugProfile, String> {
        if self
            .sessions
            .lock()
            .unwrap()
            .get(project)
            .is_some_and(|session| session.alive.load(Ordering::SeqCst))
        {
            return Err("this project already has a debug session".to_string());
        }

        let mut profile = resolved_profiles(root)?
            .into_iter()
            .find(|profile| profile.public.id == profile_id)
            .ok_or_else(|| format!("debug profile is gone: {profile_id}"))?;
        let resource = if profile.public.targeted {
            Some(prepare_target(
                project,
                root,
                target_address,
                &mut profile.configuration,
            )?)
        } else {
            None
        };

        // Native iOS is the one profile Panel launches itself: xcodebuild, simctl install, then
        // a suspended start. It happens BEFORE the adapter spawns, because the pid it produces is
        // the whole content of the attach request. A failure here must give the device back.
        let build_log = if profile.public.id == NATIVE_IOS_ID {
            let udid = resource
                .as_ref()
                .map(|found| found.device_id.clone())
                .unwrap_or_default();
            match launch_native_ios(root, &udid, &mut profile.configuration) {
                Ok(log) => Some(log),
                Err(error) => {
                    cleanup_resource(resource.as_ref());
                    return Err(error);
                }
            }
        } else {
            None
        };

        let breakpoints = absolute_breakpoints(project, root);
        let mut command = crate::platform::command(
            profile
                .argv
                .first()
                .ok_or_else(|| "debug adapter command is empty".to_string())?,
        );
        command
            .args(&profile.argv[1..])
            .current_dir(&profile.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                cleanup_resource(resource.as_ref());
                return Err(format!(
                    "could not start {}: {error}",
                    profile.public.adapter
                ));
            }
        };
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            cleanup_resource(resource.as_ref());
            return Err("debug adapter has no stdin".to_string());
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            cleanup_resource(resource.as_ref());
            return Err("debug adapter has no stdout".to_string());
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill();
            cleanup_resource(resource.as_ref());
            return Err("debug adapter has no stderr".to_string());
        };
        let session = Arc::new(DebugSession {
            project: project.to_string(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            next_seq: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            breakpoints: Mutex::new(breakpoints),
            alive: AtomicBool::new(true),
            configured: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
            phase: Mutex::new("starting".to_string()),
            thread_id: Mutex::new(None),
            resource,
            app,
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(project.to_string(), session.clone());
        spawn_reader(session.clone(), stdout, self.sessions.clone());
        spawn_stderr(session.clone(), stderr);

        let initialized = session.request(
            "initialize",
            json!({
                "clientID": "panel",
                "clientName": "Panel",
                "adapterID": profile.configuration.get("type").and_then(Value::as_str).unwrap_or("panel"),
                "pathFormat": "path",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "supportsVariableType": true,
                "supportsVariablePaging": true,
                "supportsRunInTerminalRequest": false,
                "locale": "en-US",
            }),
        );
        if let Err(error) = initialized {
            session.stop();
            self.sessions.lock().unwrap().remove(project);
            return Err(error);
        }
        if let Err(error) = session.send(&profile.request, profile.configuration.clone()) {
            session.stop();
            self.sessions.lock().unwrap().remove(project);
            return Err(error);
        }
        session.emit(json!({
            "type": "event",
            "event": "panelSession",
            "body": { "state": "starting", "profile": profile.public.name },
        }));
        // The build already happened, so its log arrives in one piece rather than streaming. It
        // still belongs in the console: a failed launch after a green build is a different bug
        // from a failed build, and only the log tells them apart.
        if let Some(log) = build_log {
            session.emit(json!({
                "type": "event",
                "event": "output",
                "body": { "category": "console", "output": log },
            }));
        }
        Ok(profile.public)
    }

    pub fn request(&self, project: &str, command: &str, arguments: Value) -> Result<Value, String> {
        let session = self.session(project)?;
        session.request(command, arguments)
    }

    pub fn set_breakpoints(
        &self,
        project: &str,
        root: &Path,
        path: &str,
        lines: Vec<u32>,
    ) -> Result<(), String> {
        save_breakpoints(project, root, path, &lines)?;
        let absolute = confined_path(root, path)?;
        if let Some(session) = self.sessions.lock().unwrap().get(project).cloned() {
            if session.alive.load(Ordering::SeqCst) {
                session.set_breakpoints(absolute.to_string_lossy().into_owned(), lines)?;
            }
        }
        Ok(())
    }

    pub fn stop(&self, project: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(project)
            .ok_or_else(|| "this project has no debug session".to_string())?;
        session.stop();
        Ok(())
    }

    pub fn stop_all(&self) -> Result<(), String> {
        let sessions: Vec<Arc<DebugSession>> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            session.stop();
        }
        Ok(())
    }

    pub fn status(&self, project: &str) -> DebugStatus {
        let session = self.sessions.lock().unwrap().get(project).cloned();
        match session {
            Some(session) if session.alive.load(Ordering::SeqCst) => {
                let phase = session.phase.lock().unwrap().clone();
                let thread_id = *session.thread_id.lock().unwrap();
                DebugStatus {
                    active: true,
                    phase,
                    thread_id,
                }
            }
            _ => DebugStatus {
                active: false,
                phase: "idle".to_string(),
                thread_id: None,
            },
        }
    }

    fn session(&self, project: &str) -> Result<Arc<DebugSession>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(project)
            .filter(|session| session.alive.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| "this project has no active debug session".to_string())
    }
}

pub fn profiles(root: &Path) -> Result<Vec<DebugProfile>, String> {
    Ok(resolved_profiles(root)?
        .into_iter()
        .map(|profile| profile.public)
        .collect())
}

fn resolved_profiles(root: &Path) -> Result<Vec<ResolvedProfile>, String> {
    let mut profiles = Vec::new();
    let app_dir = sim::project_dir(root);
    let pubspec = fs::read_to_string(app_dir.join("pubspec.yaml")).unwrap_or_default();
    let flutter = pubspec.contains("sdk: flutter") || pubspec.contains("sdk:flutter");
    if flutter && app_dir.join("lib/main.dart").is_file() {
        profiles.push(ResolvedProfile {
            public: DebugProfile {
                id: "flutter".to_string(),
                name: "Flutter app".to_string(),
                adapter: "flutter debug_adapter".to_string(),
                targeted: true,
                automatic: true,
            },
            argv: vec!["flutter".to_string(), "debug_adapter".to_string()],
            cwd: app_dir.clone(),
            request: "launch".to_string(),
            configuration: json!({
                "name": "Flutter app",
                "type": "dart",
                "request": "launch",
                "program": app_dir.join("lib/main.dart"),
                "cwd": app_dir,
            }),
        });
    } else if app_dir.join("bin/main.dart").is_file() || app_dir.join("lib/main.dart").is_file() {
        let program = if app_dir.join("bin/main.dart").is_file() {
            app_dir.join("bin/main.dart")
        } else {
            app_dir.join("lib/main.dart")
        };
        profiles.push(ResolvedProfile {
            public: DebugProfile {
                id: "dart".to_string(),
                name: "Dart program".to_string(),
                adapter: "dart debug_adapter".to_string(),
                targeted: false,
                automatic: true,
            },
            argv: vec!["dart".to_string(), "debug_adapter".to_string()],
            cwd: app_dir.clone(),
            request: "launch".to_string(),
            configuration: json!({
                "name": "Dart program",
                "type": "dart",
                "request": "launch",
                "program": program,
                "cwd": app_dir,
            }),
        });
    }

    if let Some(profile) = native_ios_profile(root) {
        profiles.push(profile);
    }

    let file = root.join(".panel/debug.json");
    if file.is_file() {
        let raw = fs::read_to_string(&file).map_err(|error| error.to_string())?;
        let manifest: DebugManifest =
            serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", file.display()))?;
        if manifest.version != 1 {
            return Err(format!(
                "unsupported debug manifest version {}",
                manifest.version
            ));
        }
        for (index, entry) in manifest.configurations.into_iter().enumerate() {
            let argv = entry
                .adapter
                .argv()
                .into_iter()
                .map(|value| expand_string(&value, root))
                .collect::<Vec<_>>();
            if argv.is_empty() {
                return Err(format!("debug profile {} has no adapter", entry.name));
            }
            let mut configuration = Value::Object(entry.configuration);
            expand_value(&mut configuration, root);
            let request = configuration
                .get("request")
                .and_then(Value::as_str)
                .unwrap_or("launch")
                .to_string();
            if let Value::Object(map) = &mut configuration {
                map.entry("name")
                    .or_insert_with(|| json!(entry.name.clone()));
                map.entry("request")
                    .or_insert_with(|| json!(request.clone()));
                map.entry("cwd")
                    .or_insert_with(|| json!(root.to_string_lossy()));
            }
            profiles.push(ResolvedProfile {
                public: DebugProfile {
                    id: if entry.id.trim().is_empty() {
                        format!("custom-{index}")
                    } else {
                        entry.id
                    },
                    name: entry.name,
                    adapter: argv.join(" "),
                    targeted: entry.targeted,
                    automatic: false,
                },
                argv,
                cwd: root.to_path_buf(),
                request,
                configuration,
            });
        }
    }
    Ok(profiles)
}

fn expand_value(value: &mut Value, root: &Path) {
    match value {
        Value::String(text) => *text = expand_string(text, root),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| expand_value(value, root)),
        Value::Object(map) => map.values_mut().for_each(|value| expand_value(value, root)),
        _ => {}
    }
}

fn expand_string(value: &str, root: &Path) -> String {
    value.replace("${workspaceFolder}", &root.to_string_lossy())
}

/// Xcode ships the adapter; nothing to install. Absent only on a machine with no Xcode, and
/// there is no iOS app to debug there either.
fn lldb_dap() -> Option<String> {
    let output = crate::platform::command("xcrun").args(["-f", "lldb-dap"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() || !Path::new(&path).is_file() {
        return None;
    }
    Some(path)
}

/*
 * A native iOS app, debugged on a simulator.
 *
 * Flutter hands its adapter a project and lets it do the whole launch. Xcode cannot: building,
 * installing and starting an app are three separate tools, and only the last of them can be made
 * to wait for a debugger. So this profile is an ATTACH — Panel does the three steps itself (see
 * `sim::native_debug_script`), gets back a suspended pid, and lldb-dap picks it up from there.
 * The payoff is that a breakpoint in `application(_:didFinishLaunchingWithOptions:)` actually
 * holds, which a plain attach-after-launch can never do.
 */
fn native_ios_profile(root: &Path) -> Option<ResolvedProfile> {
    let (dir, _) = sim::native_spec(root)?;
    if !sim::native_platforms(&dir).contains(&"ios") {
        return None;
    }
    let adapter = lldb_dap()?;
    Some(ResolvedProfile {
        public: DebugProfile {
            id: NATIVE_IOS_ID.to_string(),
            name: "iOS app".to_string(),
            adapter: "lldb-dap".to_string(),
            targeted: true,
            automatic: true,
        },
        argv: vec![adapter],
        cwd: dir.clone(),
        request: "attach".to_string(),
        configuration: json!({
            "name": "iOS app",
            "type": "lldb-dap",
            "request": "attach",
            "cwd": dir,
        }),
    })
}

/// The one profile whose launch Panel performs itself. Named so `start` can recognise it.
const NATIVE_IOS_ID: &str = "ios-native";

/**
 * Build, install and suspend the app, then tell the adapter which process to take.
 *
 * This blocks for as long as a clean Xcode build takes. `debug_start` already runs off the main
 * thread, and the phase stays "starting" throughout, so the cost is visible as a wait rather than
 * as a freeze. The build's own output is returned so the debug console can carry it.
 */
fn launch_native_ios(
    root: &Path,
    udid: &str,
    configuration: &mut Value,
) -> Result<String, String> {
    let (dir, xcodegen) = sim::native_spec(root).ok_or("this is not a native Xcode project")?;
    let script = sim::native_debug_script(udid, xcodegen);
    let shell = sim::posix_shell();
    let output = crate::platform::command(shell)
        .args(["-lc", &script])
        .current_dir(&dir)
        .output()
        .map_err(|error| format!("could not build the iOS app: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        // The last few lines are where xcodebuild puts the actual reason; the rest is a wall.
        let tail: Vec<&str> = stderr.lines().rev().take(12).collect();
        let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(if reason.trim().is_empty() {
            "the iOS build failed — open the Debug console for the full log".to_string()
        } else {
            reason
        });
    }
    let pid = stdout
        .lines()
        .find_map(|line| line.strip_prefix("PANEL_DEBUG_PID="))
        .and_then(|value| value.trim().parse::<i64>().ok())
        .ok_or("the simulator did not report a process to attach to")?;
    if let Value::Object(map) = configuration {
        map.insert("pid".to_string(), json!(pid));
        // The app is already stopped before `main` — that is what `--wait-for-debugger` bought.
        // Asking lldb to stop AGAIN at entry would strand it there with no useful frame, so the
        // adapter resumes on configurationDone and the first real stop is a breakpoint of yours.
        map.insert("stopOnEntry".to_string(), json!(false));
    }
    Ok(format!("{stdout}{stderr}"))
}

fn prepare_target(
    project: &str,
    root: &Path,
    wanted: Option<&str>,
    configuration: &mut Value,
) -> Result<DebugResource, String> {
    let kind = sim::kind_of(root).ok_or("this project has no runnable app")?;
    if kind != "flutter" && kind != "native" {
        return Err("automatic target debugging supports Flutter and native iOS projects".to_string());
    }
    let owner = format!("debug:{project}");
    let families = targets::families_for(root, kind);
    let mut target = match wanted {
        Some(address) if !address.is_empty() => targets::resolve(root, address, &owner)?,
        _ => crate::auto_target(
            root,
            kind,
            &families,
            &owner,
            false,
            false,
            crate::max_sims(),
        )?,
    };
    let booted_by_us = crate::boots_devices(&target.family) && !target.booted;
    leases::take(
        &target.id,
        &owner,
        "debug",
        &target.family,
        &target.name,
        booted_by_us,
    )?;
    let boot = match target.family.as_str() {
        "iphone" | "ipad" => sim::ensure_booted(&target.device).map(|_| None),
        "android" => android::boot(&target.id).map(Some),
        _ => Ok(None),
    };
    // A start that fails from here on hands back the lease and the device it booted, the same
    // as a debug session that ends. Releasing only the lease left that simulator up for good.
    let abandon = |target: &targets::Target| {
        cleanup_resource(Some(&DebugResource {
            owner: owner.clone(),
            address: target.id.clone(),
            device_id: target.device.clone(),
            booted_by_us,
        }))
    };
    match boot {
        Ok(Some(serial)) => target.device = serial,
        Ok(None) => {}
        Err(error) => {
            abandon(&target);
            return Err(error);
        }
    }
    if kind == "native" && !matches!(target.family.as_str(), "iphone" | "ipad") {
        abandon(&target);
        return Err(format!("a native Xcode app cannot be debugged on {}", target.family));
    }
    crate::focus_target(&target.id);
    if let Value::Object(map) = configuration {
        // Flutter's adapter takes the device; lldb-dap gets a pid instead, from the launch below.
        if kind == "flutter" {
            map.insert("deviceId".to_string(), json!(target.device));
        }
    }
    Ok(DebugResource {
        owner,
        address: target.id,
        device_id: target.device,
        booted_by_us,
    })
}

fn cleanup_resource(resource: Option<&DebugResource>) {
    let Some(resource) = resource else {
        return;
    };
    leases::release_owner(&resource.owner);
    if resource.booted_by_us && !resource.device_id.is_empty() {
        if targets::family_of(&resource.address) == "android" {
            android::shutdown_now(&resource.device_id);
        } else {
            sim::shutdown_device_now(&resource.device_id);
        }
    }
}

pub fn breakpoints(project: &str) -> BTreeMap<String, Vec<u32>> {
    let _guard = BREAKPOINT_STORE_LOCK.lock().unwrap();
    read_breakpoint_store()
        .projects
        .remove(project)
        .unwrap_or_default()
}

fn save_breakpoints(project: &str, root: &Path, path: &str, lines: &[u32]) -> Result<(), String> {
    let _guard = BREAKPOINT_STORE_LOCK.lock().unwrap();
    let relative = relative_path(root, path)?;
    let mut store = read_breakpoint_store();
    let project_store = store.projects.entry(project.to_string()).or_default();
    if lines.is_empty() {
        project_store.remove(&relative);
    } else {
        let mut lines = lines.to_vec();
        lines.retain(|line| *line > 0);
        lines.sort_unstable();
        lines.dedup();
        project_store.insert(relative, lines);
    }
    write_breakpoint_store(&store)
}

fn absolute_breakpoints(project: &str, root: &Path) -> BTreeMap<String, Vec<u32>> {
    breakpoints(project)
        .into_iter()
        .filter_map(|(path, lines)| {
            confined_path(root, &path)
                .ok()
                .map(|path| (path.to_string_lossy().into_owned(), lines))
        })
        .collect()
}

fn breakpoint_file() -> PathBuf {
    paths::module_state_dir("debugger").join("breakpoints.json")
}

fn read_breakpoint_store() -> BreakpointStore {
    fs::read_to_string(breakpoint_file())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| BreakpointStore {
            version: 1,
            projects: BTreeMap::new(),
        })
}

fn write_breakpoint_store(store: &BreakpointStore) -> Result<(), String> {
    let path = breakpoint_file();
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(&tmp, text).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

fn relative_path(root: &Path, path: &str) -> Result<String, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let raw = PathBuf::from(path);
    let full = if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    };
    let full = full.canonicalize().map_err(|error| error.to_string())?;
    full.strip_prefix(&root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "breakpoint escaped the selected project".to_string())
}

fn confined_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let raw = PathBuf::from(path);
    let full = if raw.is_absolute() {
        raw
    } else {
        root.join(raw)
    };
    let full = full.canonicalize().map_err(|error| error.to_string())?;
    full.starts_with(&root)
        .then_some(full)
        .ok_or_else(|| "breakpoint escaped the selected project".to_string())
}

fn spawn_reader(
    session: Arc<DebugSession>,
    stdout: impl Read + Send + 'static,
    sessions: Arc<Mutex<HashMap<String, Arc<DebugSession>>>>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader) {
                Ok(Some(message)) => {
                    if message.get("type").and_then(Value::as_str) == Some("event") {
                        match message.get("event").and_then(Value::as_str) {
                            Some("initialized" | "process" | "continued") => {
                                *session.phase.lock().unwrap() = "running".to_string();
                            }
                            Some("stopped") => {
                                *session.phase.lock().unwrap() = "paused".to_string();
                                *session.thread_id.lock().unwrap() = message
                                    .get("body")
                                    .and_then(|body| body.get("threadId"))
                                    .and_then(Value::as_i64);
                            }
                            Some("exited" | "terminated") => {
                                *session.phase.lock().unwrap() = "ended".to_string();
                                *session.thread_id.lock().unwrap() = None;
                            }
                            _ => {}
                        }
                    }
                    if message.get("type").and_then(Value::as_str) == Some("response") {
                        if let Some(seq) = message.get("request_seq").and_then(Value::as_i64) {
                            if let Some(waiter) = session.pending.lock().unwrap().remove(&seq) {
                                let _ = waiter.send(message.clone());
                            }
                        }
                    }
                    if message.get("type").and_then(Value::as_str) == Some("event")
                        && message.get("event").and_then(Value::as_str) == Some("initialized")
                    {
                        session.configure();
                    }
                    session.emit(message);
                }
                Ok(None) => break,
                Err(error) => {
                    session.emit(json!({
                        "type": "event",
                        "event": "output",
                        "body": { "category": "stderr", "output": format!("DAP read failed: {error}\n") },
                    }));
                    break;
                }
            }
        }
        session.alive.store(false, Ordering::SeqCst);
        session.finish();
        let project = session.project.clone();
        let mut map = sessions.lock().unwrap();
        if map
            .get(&project)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            map.remove(&project);
        }
        drop(map);
        session.emit(json!({ "type": "event", "event": "terminated", "body": {} }));
    });
}

fn spawn_stderr(session: Arc<DebugSession>, stderr: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            session.emit(json!({
                "type": "event",
                "event": "output",
                "body": { "category": "stderr", "output": format!("{line}\n") },
            }));
        }
    });
}

fn write_message(writer: &mut impl Write, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|error| error.to_string())?;
    writer.write_all(&body).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut length = None;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line
            .strip_prefix("Content-Length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
        {
            length = Some(value);
        }
    }
    let length = length.ok_or("debug adapter sent a frame without Content-Length")?;
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("debug adapter sent invalid JSON: {error}"))
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}
