// EtherX — Password Manager (Rust)
// AES-256-GCM + PBKDF2-SHA256 (600k iteracija)
// Identična sigurnosna arhitektura kao originalni passwordManager.js
//
// DISCLAIMER: kriptoentuzijasti.io nema pristup niti jednoj pohranjenoj lozinci.
// Svi podaci su šifrirani AES-256-GCM ključem izvedenim isključivo iz
// korisničke master lozinke (PBKDF2). Šifrirani blob pohranjuje se lokalno.

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng as AesOsRng},
    Aes256Gcm, Key, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{command, AppHandle, Manager};

// Globalni in-memory session key (nikad nije pohranjen na disku)
static SESSION_KEY: OnceLock<Mutex<Option<[u8; 32]>>> = OnceLock::new();

fn session_key_store() -> &'static Mutex<Option<[u8; 32]>> {
    SESSION_KEY.get_or_init(|| Mutex::new(None))
}

const PBKDF2_ITERATIONS: u32 = 600_000; // OWASP preporuka
const SALT_LEN: usize = 32;
const IV_LEN: usize = 12;
const KEY_LEN: usize = 32; // 256-bit

// ─── Data Models ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    pub id: String,
    pub site: String,
    pub username: String,
    pub password: Option<String>, // None kada je vault locked (lista bez lozinki)
    pub notes: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct VaultEntryInput {
    pub site: String,
    pub username: String,
    pub password: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct BitwardenExport {
    pub encrypted: bool,
    pub items: Vec<BitwardenItem>,
}

#[derive(Serialize, Deserialize)]
pub struct BitwardenItem {
    #[serde(rename = "type")]
    pub item_type: i32,
    pub name: String,
    pub login: BitwardenLogin,
}

#[derive(Serialize, Deserialize)]
pub struct BitwardenLogin {
    pub username: String,
    pub password: String,
    pub uris: Vec<BitwardenUri>,
}

#[derive(Serialize, Deserialize)]
pub struct BitwardenUri {
    pub uri: String,
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

fn derive_key(master_password: &str, salt: &[u8]) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(master_password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

fn encrypt(key: &[u8; KEY_LEN], plaintext: &str) -> Result<(Vec<u8>, [u8; IV_LEN]), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut iv = [0u8; IV_LEN];
    rand::thread_rng().fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;
    Ok((ciphertext, iv))
}

fn decrypt(key: &[u8; KEY_LEN], ciphertext: &[u8], iv: &[u8; IV_LEN]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(iv);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — wrong master password?".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

// ─── Vault state helpers ──────────────────────────────────────────────────────

fn get_session_key() -> Option<[u8; 32]> {
    session_key_store().lock().unwrap().clone()
}

fn set_session_key(key: [u8; 32]) {
    *session_key_store().lock().unwrap() = Some(key);
}

fn clear_session_key() {
    let mut guard = session_key_store().lock().unwrap();
    if let Some(ref mut k) = *guard {
        // Sigurno brisanje iz memorije (zeroize)
        for byte in k.iter_mut() {
            *byte = 0;
        }
    }
    *guard = None;
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[command]
pub async fn pm_is_setup(app: AppHandle) -> Result<bool, String> {
    // Provjeri postoji li vault_meta u etherx_passwords.db
    // Frontend koristi tauri-plugin-sql direktno
    Ok(false) // Frontend treba provjeriti via SQL plugin
}

#[command]
pub async fn pm_is_unlocked() -> bool {
    get_session_key().is_some()
}

#[command]
pub async fn pm_setup(master_password: String) -> Result<serde_json::Value, String> {
    if master_password.len() < 8 {
        return Err("Master password must be at least 8 characters".to_string());
    }

    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt_hex = hex::encode(salt);

    let key = derive_key(&master_password, &salt);
    set_session_key(key);

    Ok(serde_json::json!({
        "ok": true,
        "salt": salt_hex,
        "iterations": PBKDF2_ITERATIONS
    }))
}

#[command]
pub async fn pm_unlock(master_password: String, salt_hex: String) -> Result<serde_json::Value, String> {
    if master_password.is_empty() {
        return Err("Master password required".to_string());
    }

    let salt = hex::decode(&salt_hex).map_err(|e| format!("Invalid salt: {}", e))?;
    let key = derive_key(&master_password, &salt);

    // Ključ se čuva u RAM-u, nikad na disku
    set_session_key(key);

    Ok(serde_json::json!({ "ok": true }))
}

#[command]
pub async fn pm_lock() -> serde_json::Value {
    clear_session_key();
    serde_json::json!({ "ok": true })
}

#[command]
pub async fn pm_get_entries() -> Result<serde_json::Value, String> {
    if get_session_key().is_none() {
        return Err("Vault is locked".to_string());
    }
    // Frontend dohvaća metapodatke iz SQLite, ovdje samo provjeravamo lock status
    Ok(serde_json::json!({ "ok": true, "unlocked": true }))
}

#[command]
pub async fn pm_add_entry(entry: VaultEntryInput) -> Result<serde_json::Value, String> {
    let key = get_session_key().ok_or("Vault is locked")?;

    let payload = serde_json::json!({
        "password": entry.password,
        "username": entry.username,
        "site": entry.site,
        "notes": entry.notes,
    })
    .to_string();

    let (ciphertext, iv) = encrypt(&key, &payload)?;
    let id = uuid::Uuid::new_v4().to_string();

    Ok(serde_json::json!({
        "ok": true,
        "id": id,
        "site": entry.site,
        "username": entry.username,
        "encrypted": hex::encode(&ciphertext),
        "iv": hex::encode(&iv),
    }))
}

#[command]
pub async fn pm_update_entry(
    id: String,
    entry: VaultEntryInput,
) -> Result<serde_json::Value, String> {
    let key = get_session_key().ok_or("Vault is locked")?;

    let payload = serde_json::json!({
        "password": entry.password,
        "username": entry.username,
        "site": entry.site,
        "notes": entry.notes,
    })
    .to_string();

    let (ciphertext, iv) = encrypt(&key, &payload)?;

    Ok(serde_json::json!({
        "ok": true,
        "id": id,
        "encrypted": hex::encode(&ciphertext),
        "iv": hex::encode(&iv),
    }))
}

#[command]
pub async fn pm_delete_entry(id: String) -> Result<serde_json::Value, String> {
    if get_session_key().is_none() {
        return Err("Vault is locked".to_string());
    }
    Ok(serde_json::json!({ "ok": true, "id": id }))
}

#[command]
pub async fn pm_search(query: String) -> Result<serde_json::Value, String> {
    if get_session_key().is_none() {
        return Err("Vault is locked".to_string());
    }
    Ok(serde_json::json!({ "ok": true, "query": query }))
}

#[command]
pub async fn pm_decrypt_entry(
    encrypted_hex: String,
    iv_hex: String,
) -> Result<serde_json::Value, String> {
    let key = get_session_key().ok_or("Vault is locked")?;
    let ciphertext = hex::decode(&encrypted_hex).map_err(|e| e.to_string())?;
    let iv_bytes = hex::decode(&iv_hex).map_err(|e| e.to_string())?;

    if iv_bytes.len() != IV_LEN {
        return Err("Invalid IV length".to_string());
    }
    let mut iv = [0u8; IV_LEN];
    iv.copy_from_slice(&iv_bytes);

    let plaintext = decrypt(&key, &ciphertext, &iv)?;
    let data: serde_json::Value = serde_json::from_str(&plaintext)
        .map_err(|e| format!("Invalid vault data: {}", e))?;

    Ok(data)
}

#[command]
pub async fn pm_export_bitwarden() -> Result<serde_json::Value, String> {
    if get_session_key().is_none() {
        return Err("Vault is locked".to_string());
    }
    // Frontend dekriptira svaki entry i gradi Bitwarden JSON format
    Ok(serde_json::json!({ "ok": true, "format": "bitwarden" }))
}

#[command]
pub async fn pm_import_bitwarden(json: String) -> Result<serde_json::Value, String> {
    let key = get_session_key().ok_or("Vault is locked")?;

    let export: BitwardenExport =
        serde_json::from_str(&json).map_err(|e| format!("Invalid Bitwarden JSON: {}", e))?;

    let mut imported = 0usize;
    let mut results = Vec::new();

    for item in export.items.iter() {
        if item.item_type != 1 {
            continue; // samo Login stavke
        }
        let site = item.login.uris.first().map(|u| u.uri.as_str()).unwrap_or(&item.name);
        let payload = serde_json::json!({
            "password": item.login.password,
            "username": item.login.username,
            "site": site,
        })
        .to_string();

        if let Ok((ciphertext, iv)) = encrypt(&key, &payload) {
            let id = uuid::Uuid::new_v4().to_string();
            results.push(serde_json::json!({
                "id": id,
                "site": site,
                "username": item.login.username,
                "encrypted": hex::encode(&ciphertext),
                "iv": hex::encode(&iv),
            }));
            imported += 1;
        }
    }

    Ok(serde_json::json!({ "ok": true, "imported": imported, "entries": results }))
}

#[command]
pub async fn pm_generate_password(
    length: Option<usize>,
    include_symbols: Option<bool>,
    include_numbers: Option<bool>,
    include_uppercase: Option<bool>,
) -> Result<String, String> {
    let length = length.unwrap_or(20).min(128).max(8);
    let symbols = include_symbols.unwrap_or(true);
    let numbers = include_numbers.unwrap_or(true);
    let uppercase = include_uppercase.unwrap_or(true);

    let mut charset = String::from("abcdefghijklmnopqrstuvwxyz");
    if uppercase {
        charset.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    }
    if numbers {
        charset.push_str("0123456789");
    }
    if symbols {
        charset.push_str("!@#$%^&*()-_=+[]{}|;:,.<>?");
    }

    let chars: Vec<char> = charset.chars().collect();
    let mut password = String::with_capacity(length);
    let mut rng = rand::thread_rng();

    for _ in 0..length {
        let idx = (rand::random::<u32>() as usize) % chars.len();
        password.push(chars[idx]);
    }

    Ok(password)
}

#[command]
pub async fn pm_change_master_password(
    old_password: String,
    new_password: String,
    salt_hex: String,
) -> Result<serde_json::Value, String> {
    if new_password.len() < 8 {
        return Err("New master password must be at least 8 characters".to_string());
    }

    // Provjeri staru lozinku
    let salt = hex::decode(&salt_hex).map_err(|e| format!("Invalid salt: {}", e))?;
    let old_key = derive_key(&old_password, &salt);

    let current = get_session_key().ok_or("Vault is locked")?;
    if current != old_key {
        return Err("Old master password is incorrect".to_string());
    }

    // Generiraj novi salt i ključ
    let mut new_salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut new_salt);
    let new_salt_hex = hex::encode(new_salt);
    let new_key = derive_key(&new_password, &new_salt);
    set_session_key(new_key);

    Ok(serde_json::json!({
        "ok": true,
        "newSalt": new_salt_hex,
        "iterations": PBKDF2_ITERATIONS,
        "note": "All entries must be re-encrypted with new key — frontend handles this"
    }))
}
