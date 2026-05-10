// EtherX — Download Manager (Rust)
// Tauri ima ugrađenu download podršku kroz webview, ali mi pratimo napredak

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{command, AppHandle, Manager};
use crate::state::{AppState, DownloadInfo};

#[command]
pub async fn dl_get_all(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<DownloadInfo>, String> {
    Ok(state.lock().unwrap().downloads.clone())
}

#[command]
pub async fn dl_clear(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<serde_json::Value, String> {
    state.lock().unwrap().downloads.clear();
    Ok(serde_json::json!({ "ok": true }))
}

#[command]
pub async fn dl_open_file(path: String) -> Result<serde_json::Value, String> {
    // Sanitizacija putanje — dopuštamo samo apsolutne putanje na lokalnom FS
    let path_obj = std::path::Path::new(&path);
    if !path_obj.exists() {
        return Err(format!("File not found: {}", path));
    }
    if !path_obj.is_absolute() {
        return Err("Only absolute paths are allowed".to_string());
    }
    open::that(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}

#[command]
pub async fn dl_open_folder(path: String) -> Result<serde_json::Value, String> {
    let path_obj = std::path::Path::new(&path);

    // Otvori folder koji sadrži datoteku
    let folder = if path_obj.is_file() {
        path_obj.parent().unwrap_or(path_obj)
    } else {
        path_obj
    };

    if !folder.exists() {
        return Err(format!("Folder not found: {}", folder.display()));
    }

    open::that(folder).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ok": true }))
}
