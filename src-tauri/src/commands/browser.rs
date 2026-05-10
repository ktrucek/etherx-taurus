// EtherX — Browser navigation commands (Tauri v2)
// Koristi Tauri WebviewWindow za upravljanje tabovima

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager, State, WebviewWindowBuilder, WebviewUrl};
use std::sync::Mutex;
use crate::state::AppState;

#[derive(Serialize, Deserialize)]
pub struct NavResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// Otvori URL u novom ili postojećem prozoru (svaki tab = WebviewWindow)
#[command]
pub async fn navigate(
    app: AppHandle,
    label: String,
    url: String,
) -> Result<NavResult, String> {
    // Validacija URL-a
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let scheme = parsed.scheme();
    let allowed = matches!(scheme, "http" | "https" | "about" | "data" | "blob");
    if !allowed {
        return Err(format!("Blocked scheme: {}", scheme));
    }

    // Automatski upgrade HTTP → HTTPS
    let final_url = if scheme == "http" {
        url.replacen("http://", "https://", 1)
    } else {
        url.clone()
    };

    if let Some(win) = app.get_webview_window(&label) {
        let nav_url: url::Url = final_url.parse().map_err(|e: url::ParseError| e.to_string())?;
        win.navigate(nav_url).map_err(|e| e.to_string())?;
    }

    Ok(NavResult { ok: true, error: None })
}

#[command]
pub async fn go_back(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("history.back()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn go_forward(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("history.forward()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn reload(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("location.reload()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn stop_loading(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("window.stop()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn open_devtools(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window(&label) {
        win.open_devtools();
    }
    Ok(())
}

#[command]
pub async fn zoom_in(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1).toString()")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn zoom_out(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("document.body.style.zoom = Math.max(0.5, parseFloat(document.body.style.zoom || 1) - 0.1).toString()")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn zoom_reset(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.eval("document.body.style.zoom = '1'")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn get_user_agent() -> String {
    // Simulira moderan Chrome UA
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 EtherX/2.4.131".to_string()
}

#[command]
pub async fn set_user_agent(
    app: AppHandle,
    label: String,
    ua: String,
) -> Result<(), String> {
    // Nema direktnog UA override-a u Tauri webview — inject via JS
    let js = format!(
        r#"Object.defineProperty(navigator, 'userAgent', {{ get: () => '{}' }});"#,
        ua.replace('\'', "\\'")
    );
    if let Some(win) = app.get_webview_window(&label) {
        win.eval(&js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[command]
pub async fn get_window_bounds(
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    if let Some(win) = app.get_webview_window("main") {
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let size = win.outer_size().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "x": pos.x,
            "y": pos.y,
            "width": size.width,
            "height": size.height,
        }))
    } else {
        Err("Main window not found".to_string())
    }
}

#[command]
pub async fn save_window_bounds(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let size = win.outer_size().map_err(|e| e.to_string())?;
        let mut st = state.lock().unwrap();
        st.window_bounds = Some(crate::state::WindowBounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        });
    }
    Ok(())
}

#[command]
pub async fn open_external(url: String) -> Result<(), String> {
    // Validacija — dopuštamo samo http/https/mailto
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {
            open::that(&url).map_err(|e| e.to_string())?;
        }
        s => return Err(format!("Blocked external scheme: {}", s)),
    }
    Ok(())
}
