mod faces;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The running sidecar brain. `None` when the brain is not running.
struct Brain(Mutex<Option<CommandChild>>);

/// Restart bookkeeping for the brain.
struct Supervisor {
    /// Set when the app quits. Then a brain exit is expected.
    quitting: AtomicBool,
    /// When the current brain started, and the count of fast failures in a row.
    state: Mutex<(Instant, u32)>,
}

/// A brain that ran this long counts as healthy. Its exit starts a new count.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// After this many fast failures in a row, stop and show a fault.
const MAX_FAST_FAILURES: u32 = 5;

#[derive(Clone, Serialize)]
struct BrainExit {
    code: Option<i32>,
    /// True if a new brain starts after `delay_ms`.
    restarting: bool,
    delay_ms: u64,
    attempt: u32,
}

/// The wait before restart number `attempt` (1-based): 1 s, 2 s, 4 s, ... at most 30 s.
fn restart_delay(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.saturating_sub(1).min(5)).min(Duration::from_secs(30))
}

/// Run an AppleScript with arguments. The arguments go in `argv`, never into the script text.
fn osascript(lines: &[&str], args: &[&str]) -> std::io::Result<std::process::Output> {
    let mut command = std::process::Command::new("/usr/bin/osascript");
    for line in lines {
        command.args(["-e", line]);
    }
    command.args(args).output()
}

/// Run an osascript chooser and return the POSIX path, or `None` if the user cancels.
/// The always-on-top window steps back while the chooser is open.
pub(crate) async fn run_chooser(app: &AppHandle, script: &'static str, prompt: &'static str) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main");
    // The always-on-top window would cover the chooser.
    if let Some(w) = &window {
        let _ = w.set_always_on_top(false);
    }
    let output = tauri::async_runtime::spawn_blocking(move || {
        osascript(
            &[
                "on run argv",
                // The chooser belongs to osascript. Bring it to the front, without
                // the Automation permission that System Events needs.
                "activate",
                script,
                "end run",
            ],
            &[prompt],
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    if let Some(w) = &window {
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
    let output = output?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Cancel is AppleScript error -128. Anything else is a fault to show.
        return if stderr.contains("-128") { Ok(None) } else { Err(stderr.trim().to_string()) };
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().trim_end_matches('/').to_string();
    Ok((!path.is_empty()).then_some(path))
}

/// Show a folder chooser. Returns the POSIX path, or `None` if the user cancels.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    run_chooser(
        &app,
        "return POSIX path of (choose folder with prompt (item 1 of argv))",
        "Choose a project folder for Jeeves",
    )
    .await
}

/// Show a macOS notification.
#[tauri::command]
async fn notify(title: String, body: String) -> Result<(), String> {
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(400).collect();
    tauri::async_runtime::spawn_blocking(move || {
        osascript(
            &[
                "on run argv",
                "display notification (item 2 of argv) with title (item 1 of argv)",
                "end run",
            ],
            &[&title, &body],
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
    .map(|_| ())
}

/// Send 1 protocol line from the webview to the brain stdin.
#[tauri::command]
fn brain_send(line: String, brain: State<'_, Brain>) -> Result<(), String> {
    if line.contains('\n') {
        return Err("a protocol line must not contain a newline".into());
    }
    let mut guard = brain.0.lock().map_err(|e| e.to_string())?;
    let child = guard.as_mut().ok_or("brain is not running")?;
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    child.write(&buf).map_err(|e| e.to_string())
}

/// Keychain service name for all Jeeves secrets.
const KEYCHAIN_SERVICE: &str = "jeeves";

/// Read 1 secret from the macOS Keychain. `None` if it is not there.
fn read_secret(account: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let secret = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!secret.is_empty()).then_some(secret)
}

/// Start the brain and relay each stdout line to the webview as a "brain" event.
fn spawn_brain(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let mut command = app.shell().sidecar("jeeves-brain")?.kill_on_drop(true);
    // A Keychain secret wins over an environment variable with the same name.
    for (account, var) in [("elevenlabs", "ELEVENLABS_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")] {
        if let Some(secret) = read_secret(account) {
            command = command.env(var, secret);
        }
    }
    let (mut rx, child) = command.spawn()?;
    *app.state::<Brain>().0.lock().map_err(|e| e.to_string())? = Some(child);
    if let Ok(mut state) = app.state::<Supervisor>().state.lock() {
        state.0 = Instant::now();
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                    if !line.is_empty() {
                        let _ = handle.emit("brain", line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[brain] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[brain] stopped, code {:?}", payload.code);
                    if let Ok(mut guard) = handle.state::<Brain>().0.lock() {
                        guard.take();
                    }
                    on_brain_exit(&handle, payload.code);
                }
                CommandEvent::Error(err) => eprintln!("[brain] error: {err}"),
                _ => {}
            }
        }
    });
    Ok(())
}

/// Tell the webview, and start a new brain after a wait, unless the app quits
/// or the brain failed too often in a row.
fn on_brain_exit(app: &AppHandle, code: Option<i32>) {
    let supervisor = app.state::<Supervisor>();
    if supervisor.quitting.load(Ordering::SeqCst) {
        return;
    }
    let attempt = match supervisor.state.lock() {
        Ok(mut state) => {
            state.1 = if state.0.elapsed() >= HEALTHY_RUN { 1 } else { state.1 + 1 };
            state.1
        }
        Err(_) => MAX_FAST_FAILURES + 1,
    };
    let restarting = attempt <= MAX_FAST_FAILURES;
    let delay = restart_delay(attempt);
    let _ = app.emit(
        "brain-exit",
        BrainExit { code, restarting, delay_ms: delay.as_millis() as u64, attempt },
    );
    if !restarting {
        eprintln!("[brain] stopped {attempt} times in a row, no more restarts");
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(delay).await;
        if handle.state::<Supervisor>().quitting.load(Ordering::SeqCst) {
            return;
        }
        eprintln!("[brain] restart {attempt}");
        if let Err(err) = spawn_brain(&handle) {
            eprintln!("[brain] restart failed: {err}");
            on_brain_exit(&handle, None);
        }
    });
}

/// Sleep without a blocked runtime thread.
async fn tokio_sleep(delay: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Brain(Mutex::new(None)))
        .manage(Supervisor { quitting: AtomicBool::new(false), state: Mutex::new((Instant::now(), 0)) })
        .invoke_handler(tauri::generate_handler![
            brain_send,
            pick_folder,
            notify,
            faces::face_list,
            faces::face_read,
            faces::face_install,
            faces::face_remove
        ])
        .setup(|app| {
            spawn_brain(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Jeeves app")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<Supervisor>().quitting.store(true, Ordering::SeqCst);
            }
        });
}
