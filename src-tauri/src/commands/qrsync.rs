// EtherX — QR Sync (Rust)
// Generira QR kodove za device-to-device sinkronizaciju bez servera
// Identična logika kao qrSync.js

use qrcode::{QrCode, EcLevel};
use image::Luma;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Serialize, Deserialize)]
pub struct QrResult {
    pub ok: bool,
    pub qr_data_url: Option<String>,
    pub token: Option<String>,
    pub is_partial: bool,
    pub error: Option<String>,
}

/// Generiraj QR kod kao base64 PNG data URL
#[command]
pub async fn qr_generate(data: String) -> Result<QrResult, String> {
    // Enkodiranje u base64 (za konzistentnost s JS verzijom)
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(data.as_bytes());

    if encoded.len() > 2900 {
        // Preveliko za jedan QR — generiraj sync token
        return qr_generate_sync_token(data.len()).await;
    }

    match QrCode::with_error_correction_level(&encoded, EcLevel::M) {
        Ok(code) => {
            let image = code.render::<Luma<u8>>().build();

            // Konverzija u PNG bytes
            let mut png_bytes: Vec<u8> = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            image.write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;

            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
            let data_url = format!("data:image/png;base64,{}", b64);

            Ok(QrResult {
                ok: true,
                qr_data_url: Some(data_url),
                token: None,
                is_partial: false,
                error: None,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Generiraj sync token za velike payloade
#[command]
pub async fn qr_generate_sync_token(data_size: usize) -> Result<QrResult, String> {
    let mut token_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    let token = hex::encode(token_bytes);

    let short_payload = serde_json::json!({
        "type": "etherx-sync",
        "token": token,
        "size": data_size,
        "hint": "Connect to same network and scan",
    })
    .to_string();

    match QrCode::with_error_correction_level(&short_payload, EcLevel::M) {
        Ok(code) => {
            let image = code.render::<Luma<u8>>().build();
            let mut png_bytes: Vec<u8> = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            image.write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;

            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
            let data_url = format!("data:image/png;base64,{}", b64);

            Ok(QrResult {
                ok: true,
                qr_data_url: Some(data_url),
                token: Some(token),
                is_partial: true,
                error: None,
            })
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Dekodiraj QR payload (base64 → original string)
#[command]
pub async fn qr_decode(encoded: String) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;

    // Pokušaj parsiranja kao JSON
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::json!({ "ok": true, "data": json, "raw": text }))
    } else {
        Ok(serde_json::json!({ "ok": true, "data": text, "raw": text }))
    }
}
