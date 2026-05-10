// EtherX Browser — Tauri v2 Library Root
// Copyright © 2024–2026 kriptoentuzijasti.io. All Rights Reserved.

mod commands;
mod state;

use commands::{browser, database, passwords, adblocker, security, downloads, qrsync};
use state::AppState;
use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(Mutex::new(AppState::new()))
        .setup(|app| {
            let app_handle = app.handle().clone();
            // Inicijalizacija AdBlockera u backgroundu
            tauri::async_runtime::spawn(async move {
                if let Err(e) = adblocker::init_blocker(&app_handle).await {
                    log::warn!("[AdBlocker] Init failed (non-fatal): {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Browser navigation
            browser::navigate,
            browser::go_back,
            browser::go_forward,
            browser::reload,
            browser::stop_loading,
            browser::open_devtools,
            browser::get_user_agent,
            browser::set_user_agent,
            browser::get_window_bounds,
            browser::save_window_bounds,
            browser::open_external,
            browser::zoom_in,
            browser::zoom_out,
            browser::zoom_reset,
            // Database
            database::db_get_history,
            database::db_add_history,
            database::db_clear_history,
            database::db_get_bookmarks,
            database::db_add_bookmark,
            database::db_remove_bookmark,
            database::db_get_settings,
            database::db_set_setting,
            database::db_get_downloads,
            database::db_add_download,
            database::db_get_tabs,
            database::db_save_tabs,
            database::db_prune_history,
            database::db_get_window_bounds,
            database::db_save_window_bounds,
            // Password manager
            passwords::pm_unlock,
            passwords::pm_lock,
            passwords::pm_is_unlocked,
            passwords::pm_is_setup,
            passwords::pm_setup,
            passwords::pm_get_entries,
            passwords::pm_add_entry,
            passwords::pm_update_entry,
            passwords::pm_delete_entry,
            passwords::pm_search,
            passwords::pm_export_bitwarden,
            passwords::pm_import_bitwarden,
            passwords::pm_generate_password,
            passwords::pm_change_master_password,
            // Ad blocker
            adblocker::ab_is_enabled,
            adblocker::ab_toggle,
            adblocker::ab_get_stats,
            adblocker::ab_check_url,
            // Security
            security::sec_check_url,
            security::sec_get_cert_info,
            security::sec_upgrade_http,
            // Downloads
            downloads::dl_get_all,
            downloads::dl_clear,
            downloads::dl_open_file,
            downloads::dl_open_folder,
            // QR Sync
            qrsync::qr_generate,
            qrsync::qr_decode,
            qrsync::qr_generate_sync_token,
        ])
        .run(tauri::generate_context!())
        .expect("EtherX Browser failed to start");
}
