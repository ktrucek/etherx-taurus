// EtherX — Ad Blocker (Rust)
// Koristi `adblock` crate koji podržava EasyList/ABP filter format
// Identična funkcionalnost kao @cliqz/adblocker-electron

use adblock::{
    Engine,
    lists::{FilterSet, ParseOptions},
};
use std::sync::{Mutex, OnceLock};
use tauri::{command, AppHandle, Manager};
use crate::state::AppState;

// Wrapper koji omogućuje Send za adblock::Engine (koji interno koristi Rc)
// SAFETY: Mutex osigurava isključivi pristup — nikad se ne pristupa s više niti istovremeno
struct SendableEngine(Engine);
unsafe impl Send for SendableEngine {}

// Globalni engine (lazy init)
static BLOCKER_ENGINE: OnceLock<Mutex<Option<SendableEngine>>> = OnceLock::new();

fn blocker() -> &'static Mutex<Option<SendableEngine>> {
    BLOCKER_ENGINE.get_or_init(|| Mutex::new(None))
}

// EasyList + EasyPrivacy filteri (bundled fallback)
const EASYLIST_FILTERS: &str = include_str!("../../../src/assets/filters/filters.txt");

/// Poziva se pri startu aplikacije (iz lib.rs setup)
pub async fn init_blocker(app: &AppHandle) -> anyhow::Result<()> {
    log::info!("[AdBlocker] Initializing...");

    // Pokušaj download svježih lista
    let filter_text = match fetch_filter_lists().await {
        Ok(text) => {
            log::info!("[AdBlocker] Downloaded fresh filter lists");
            text
        }
        Err(e) => {
            log::warn!("[AdBlocker] Download failed ({}), using bundled filters", e);
            EASYLIST_FILTERS.to_string()
        }
    };

    let mut filter_set = FilterSet::new(false);
    filter_set.add_filters(
        filter_text.lines().map(|l| l.to_string()).collect::<Vec<_>>().as_slice(),
        ParseOptions::default(),
    );
    let engine = Engine::from_filter_set(filter_set, true);

    *blocker().lock().unwrap() = Some(SendableEngine(engine));
    log::info!("[AdBlocker] Ready");
    Ok(())
}

async fn fetch_filter_lists() -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    // EasyList + EasyPrivacy kombinirano
    let easylist = client
        .get("https://easylist.to/easylist/easylist.txt")
        .send()
        .await?
        .text()
        .await?;

    let easyprivacy = client
        .get("https://easylist.to/easylist/easyprivacy.txt")
        .send()
        .await?
        .text()
        .await?;

    Ok(format!("{}\n{}", easylist, easyprivacy))
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[command]
pub async fn ab_is_enabled(state: tauri::State<'_, Mutex<AppState>>) -> Result<bool, String> {
    Ok(state.lock().unwrap().ab_enabled)
}

#[command]
pub async fn ab_toggle(
    state: tauri::State<'_, Mutex<AppState>>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let mut st = state.lock().unwrap();
    st.ab_enabled = enabled;
    Ok(serde_json::json!({ "ok": true, "enabled": enabled }))
}

#[command]
pub async fn ab_get_stats(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<serde_json::Value, String> {
    let st = state.lock().unwrap();
    Ok(serde_json::json!({
        "blocked": st.ab_blocked,
        "allowed": st.ab_allowed,
        "enabled": st.ab_enabled,
    }))
}

#[command]
pub async fn ab_check_url(
    state: tauri::State<'_, Mutex<AppState>>,
    url: String,
    source_url: Option<String>,
    request_type: Option<String>,
) -> Result<serde_json::Value, String> {
    // Validacija
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let mut st = state.lock().unwrap();
    if !st.ab_enabled {
        st.ab_allowed += 1;
        return Ok(serde_json::json!({ "blocked": false, "reason": "adblocker_disabled" }));
    }

    let engine_guard = blocker().lock().unwrap();
    let engine_opt: Option<&SendableEngine> = engine_guard.as_ref();
    if let Some(sendable) = engine_opt {
        let engine = &sendable.0;
        let source = source_url.unwrap_or_default();
        let req_type = request_type.as_deref().unwrap_or("other");

        let blocker_req = adblock::request::Request::new(&url, &source, req_type)
            .map_err(|e| e.to_string())?;

        let result = engine.check_network_request(&blocker_req);
        let blocked = result.matched;

        if blocked {
            st.ab_blocked += 1;
            log::debug!("[AdBlocker] BLOCKED: {}", url);
        } else {
            st.ab_allowed += 1;
        }

        Ok(serde_json::json!({
            "blocked": blocked,
            "redirect": result.redirect,
            "important": result.important,
        }))
    } else {
        // Engine nije inicijaliziran — dopusti
        st.ab_allowed += 1;
        Ok(serde_json::json!({ "blocked": false, "reason": "engine_not_ready" }))
    }
}
