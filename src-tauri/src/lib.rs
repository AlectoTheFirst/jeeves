use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// The running sidecar brain. `None` when the brain is not running.
struct Brain(Mutex<Option<CommandChild>>);

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

/// Start the brain and relay each stdout line to the webview as a "brain" event.
fn spawn_brain(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (mut rx, child) = app
        .shell()
        .sidecar("jeeves-brain")?
        .kill_on_drop(true)
        .spawn()?;
    *app.state::<Brain>().0.lock().map_err(|e| e.to_string())? = Some(child);

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
                    let _ = handle.emit("brain-exit", payload.code);
                }
                CommandEvent::Error(err) => eprintln!("[brain] error: {err}"),
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Brain(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![brain_send])
        .setup(|app| {
            spawn_brain(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Jeeves app");
}
