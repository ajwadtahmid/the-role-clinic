#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
struct Desktop {
    backend: Mutex<Option<Backend>>,
    exiting: AtomicBool,
}
struct Backend {
    child: Child,
    origin: String,
    instance_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    app: String,
    pid: u32,
    port: u16,
    instance_id: String,
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}
fn origin(state: &Desktop) -> Result<String, String> {
    state
        .backend
        .lock()
        .map_err(|_| "Backend state unavailable")?
        .as_ref()
        .map(|b| b.origin.clone())
        .ok_or("The local backend is not running".into())
}
fn authorize(window: &WebviewWindow, state: &Desktop) -> Result<String, String> {
    let expected = origin(state)?;
    if window.label() != "main"
        || window
            .url()
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization()
            != expected
    {
        return Err("Desktop access is limited to this app's exact local origin".into());
    }
    Ok(expected)
}
fn download_path(path: &str) -> bool {
    let p: Vec<_> = path.split('/').collect();
    path == "/api/master/export"
        || matches!(
            path,
            "/api/tracker/export/xlsx"
                | "/api/tracker/export/applications.csv"
                | "/api/tracker/export/qa.csv"
        )
        || (p.len() == 4
            && p[1] == "api"
            && p[2] == "backups"
            && p[3].ends_with(".sqlite")
            && p[3]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.'))
        || (p.len() == 5 && p[1] == "api" && p[2] == "jobs" && uuid(p[3]) && p[4] == "snapshot")
        || (p.len() == 6
            && p[1] == "api"
            && p[2] == "jobs"
            && uuid(p[3])
            && p[4] == "artifacts"
            && uuid(p[5]))
}
fn uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}
fn safe_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !['/', '\\', ':'].contains(c))
        .take(180)
        .collect();
    if clean.trim_matches('.').trim().is_empty() {
        "role-clinic-export".into()
    } else {
        clean
    }
}
#[tauri::command]
async fn save_download(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Desktop>,
    path: String,
    filename: Option<String>,
) -> Result<bool, String> {
    let base = authorize(&window, &state)?;
    if !path.starts_with("/api/") || path.contains('#') {
        return Err("Choose an application export".into());
    }
    let url = tauri::Url::parse(&(base + &path)).map_err(|e| e.to_string())?;
    if !download_path(url.path()) {
        return Err("This endpoint is not a downloadable export".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut response = client()?.get(url).send().map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Export failed (HTTP {})", response.status()));
        }
        const LIMIT: u64 = 256 * 1024 * 1024;
        if response.content_length().unwrap_or(0) > LIMIT {
            return Err("This export exceeds the desktop 256 MB download limit".into());
        }
        let disposition = response
            .headers()
            .get("content-disposition")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let suggested = filename
            .filter(|n| !n.is_empty())
            .or_else(|| {
                disposition.split("filename*=UTF-8''").nth(1).map(|n| {
                    percent_encoding::percent_decode_str(n)
                        .decode_utf8_lossy()
                        .into_owned()
                })
            })
            .or_else(|| {
                disposition
                    .split("filename=\"")
                    .nth(1)
                    .map(|n| n.split('"').next().unwrap_or("").to_string())
            })
            .unwrap_or_else(|| "role-clinic-export".into());
        let destination = app
            .dialog()
            .file()
            .set_file_name(safe_filename(&suggested))
            .blocking_save_file();
        let Some(destination) = destination else {
            return Ok(false);
        };
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("This export exceeds the desktop 256 MB download limit".into());
        }
        let path = destination.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, bytes).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn clipboard_write(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Desktop>,
    text: String,
) -> Result<(), String> {
    authorize(&window, &state)?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("Clipboard text is too large".into());
    }
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}
#[tauri::command]
fn open_external(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    url: String,
) -> Result<(), String> {
    authorize(&window, &state)?;
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) posting and guide links can be opened".into());
    }
    #[cfg(target_os = "linux")]
    {
        let mut child = Command::new("xdg-open")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    #[cfg(not(target_os = "linux"))]
    return Err("This desktop integration currently targets Linux".into());
    Ok(())
}
fn request_quit(app: tauri::AppHandle) {
    let state = app.state::<Desktop>();
    if state.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let state = app.state::<Desktop>();
        let info = state.backend.lock().ok().and_then(|g| {
            g.as_ref()
                .map(|b| (b.origin.clone(), b.instance_id.clone()))
        });
        if let Some((base, instance)) = info {
            let active = client()
                .and_then(|c| {
                    c.get(format!("{base}/api/app/status"))
                        .timeout(Duration::from_secs(2))
                        .send()
                        .map_err(|e| e.to_string())?
                        .json::<serde_json::Value>()
                        .map_err(|e| e.to_string())
                })
                .ok()
                .and_then(|v| v["activeRuns"].as_u64());
            let confirm_interrupt = active.is_none_or(|count| count > 0);
            let message = if active.is_none() {
                "The local backend is not responding. Quit and interrupt any unfinished work? Saved records will remain available when you reopen the app."
            } else {
                "A model run is active. Quit and interrupt it? Its incomplete run will need to be retried when you reopen the app."
            };
            if confirm_interrupt
                && !app
                    .dialog()
                    .message(message)
                    .title("Quit The Role Clinic?")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Quit and interrupt".into(),
                        "Keep working".into(),
                    ))
                    .blocking_show()
            {
                state.exiting.store(false, Ordering::SeqCst);
                return;
            }
            let response = client().and_then(|c| c.post(format!("{base}/api/app/quit")).header("Origin", &base).json(&serde_json::json!({"confirm":true,"instanceId":instance,"force":confirm_interrupt})).timeout(Duration::from_secs(2)).send().map_err(|e| e.to_string()));
            if response
                .as_ref()
                .is_ok_and(|r| r.status() == reqwest::StatusCode::CONFLICT)
            {
                state.exiting.store(false, Ordering::SeqCst);
                request_quit(app.clone());
                return;
            }
            for _ in 0..100 {
                let ended = state
                    .backend
                    .lock()
                    .map(|mut g| {
                        g.as_mut()
                            .is_none_or(|b| b.child.try_wait().ok().flatten().is_some())
                    })
                    .unwrap_or(true);
                if ended {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if let Ok(mut backend) = state.backend.lock() {
                if let Some(b) = backend.as_mut() {
                    let _ = b.child.kill();
                    let _ = b.child.wait();
                }
            }
        }
        app.exit(0);
    });
}
#[tauri::command]
fn quit_app(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, Desktop>,
) -> Result<(), String> {
    authorize(&window, &state)?;
    request_quit(app);
    Ok(())
}

fn start_backend(app: &tauri::AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("backend");
    let node = root.join("runtime/node");
    let mut child = Command::new(node)
        .arg(root.join("app/apps/server/src/start-desktop.js"))
        .current_dir(&root)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("ROLE_CLINIC_RELEASE_PATH", &root)
        .env("NODE_ENV", "production")
        .env("PORT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start the bundled backend: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Backend readiness pipe is unavailable")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("ROLE_CLINIC_DESKTOP_READY=") {
                let _ = tx.send(serde_json::from_str::<Ready>(value).map_err(|e| e.to_string()));
            } else if let Some(value) = line.strip_prefix("ROLE_CLINIC_DESKTOP_ERROR=") {
                let _ = tx.send(Err(value.to_string()));
            } else {
                eprintln!("{line}");
            }
        }
    });
    let ready = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(r)) => r,
        other => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(match other {
                Ok(Err(e)) => e,
                _ => "The local backend did not become ready. Check app.log in your data folder."
                    .into(),
            });
        }
    };
    if ready.app != "the-role-clinic"
        || ready.pid != child.id()
        || ready.port == 0
        || ready.instance_id.is_empty()
    {
        let _ = child.kill();
        return Err("Unexpected backend identity".into());
    }
    let base = format!("http://127.0.0.1:{}", ready.port);
    let state = app.state::<Desktop>();
    *state
        .backend
        .lock()
        .map_err(|_| "Backend state unavailable")? = Some(Backend {
        child,
        origin: base.clone(),
        instance_id: ready.instance_id,
    });
    if state.exiting.load(Ordering::SeqCst) {
        return Ok(());
    }
    app.get_webview_window("main")
        .ok_or("The desktop window is unavailable")?
        .navigate(tauri::Url::parse(&base).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn main() {
    let app = tauri::Builder::default()
        .manage(Desktop::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); } }))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![save_download, clipboard_write, open_external, quit_app])
        .setup(|app| {
            let navigation = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).title("The Role Clinic").inner_size(1280., 900.).min_inner_size(800., 600.)
                .on_navigation(move |url| {
                    // Startup assets have no capabilities. Once ready, only our own exact port is navigable.
                    if matches!(url.scheme(), "tauri" | "asset") || url.host_str() == Some("tauri.localhost") { return true; }
                    origin(&navigation.state::<Desktop>()).is_ok_and(|base| url.origin().ascii_serialization() == base)
                }).on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = start_backend(&handle) {
                    if !handle.state::<Desktop>().exiting.load(Ordering::SeqCst) { handle.dialog().message(error).title("The Role Clinic could not start").kind(MessageDialogKind::Error).blocking_show(); }
                    handle.state::<Desktop>().exiting.store(true, Ordering::SeqCst); handle.exit(1); return;
                }
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    let state = handle.state::<Desktop>(); if state.exiting.load(Ordering::SeqCst) { break; }
                    let ended = state.backend.lock().ok().and_then(|mut g| g.as_mut().and_then(|b| b.child.try_wait().ok().flatten()));
                    if let Some(status) = ended {
                        if !status.success() { handle.dialog().message("The local backend stopped unexpectedly. Reopen The Role Clinic to recover your saved workspace and retry any interrupted run.").title("The Role Clinic stopped").kind(MessageDialogKind::Error).blocking_show(); }
                        state.exiting.store(true, Ordering::SeqCst); handle.exit(if status.success() { 0 } else { 1 }); break;
                    }
                }
            }); Ok(())
        })
        .on_window_event(|window, event| { if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); request_quit(window.app_handle().clone()); } })
        .build(tauri::generate_context!()).expect("The desktop window could not be initialized");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Desktop>().exiting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app.clone());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_export_routes_are_downloadable() {
        assert!(download_path("/api/master/export"));
        assert!(download_path("/api/tracker/export/xlsx"));
        assert!(!download_path("/api/settings"));
        assert!(!download_path("/api/master/export/../profile"));
        assert!(!download_path("/api/backups/../../settings.json"));
        assert!(!download_path("//example.com/api/master/export"));
    }
    #[test]
    fn filenames_cannot_set_the_destination_directory() {
        assert_eq!(safe_filename("../../secret\n.txt"), "....secret.txt");
        assert_eq!(safe_filename("..."), "role-clinic-export");
    }
}
