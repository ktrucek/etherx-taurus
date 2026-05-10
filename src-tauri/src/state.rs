// EtherX — Shared application state (thread-safe)

use std::collections::HashMap;

pub struct AppState {
    /// Ad blocker stats: blocked / allowed counts
    pub ab_blocked: u64,
    pub ab_allowed: u64,
    pub ab_enabled: bool,

    /// Download tracking: id → DownloadInfo
    pub downloads: Vec<DownloadInfo>,

    /// Window bounds
    pub window_bounds: Option<WindowBounds>,

    /// Per-tab incognito flag (tabId → bool)
    pub incognito_tabs: HashMap<String, bool>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DownloadInfo {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub save_path: String,
    pub total_bytes: i64,
    pub received_bytes: i64,
    pub status: String, // started | progressing | paused | completed | failed
    pub ts: i64,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            ab_blocked: 0,
            ab_allowed: 0,
            ab_enabled: true,
            downloads: Vec::new(),
            window_bounds: None,
            incognito_tabs: HashMap::new(),
        }
    }
}
