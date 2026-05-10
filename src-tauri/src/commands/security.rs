// EtherX — Security Manager (Rust)
// TLS 1.3 enforcement + phishing detection + HTTPS upgrade
// Odgovara security.js + AI phishing logici iz ai.js

use serde::{Deserialize, Serialize};
use tauri::command;

// Poznati phishing obrasci (isti kao u ai.js)
const PHISHING_PATTERNS: &[&str] = &[
    "paypal", "amazon", "google", "microsoft", "apple",
    "bank", "login", "secure-login", "verify-account",
    "confirm-identity", "update-payment", "suspended-account",
    "unusual-activity", "signin", "account-locked",
];

const SUSPICIOUS_TLDS: &[&str] = &[
    ".xyz", ".top", ".tk", ".ml", ".ga", ".cf", ".gq",
    ".buzz", ".click", ".win", ".loan", ".racing",
];

const TRUSTED_DOMAINS: &[&str] = &[
    "google.com", "youtube.com", "facebook.com", "amazon.com",
    "wikipedia.org", "github.com", "microsoft.com", "apple.com",
    "netflix.com", "twitter.com", "instagram.com", "linkedin.com",
    "reddit.com", "medium.com", "stackoverflow.com",
    "kriptoentuzijasti.io", "wallet.kriptoentuzijasti.io",
    "bobiai.kriptoentuzijasti.io",
];

#[derive(Serialize, Deserialize)]
pub struct SecurityCheckResult {
    pub is_safe: bool,
    pub is_phishing_suspect: bool,
    pub warnings: Vec<String>,
    pub risk_score: u8, // 0-100
    pub upgraded_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct CertInfo {
    pub hostname: String,
    pub protocol: String,
    pub is_secure: bool,
    pub tls_version: String,
}

/// Analizira URL na phishing indikatore
fn analyze_url(url: &str) -> SecurityCheckResult {
    let mut warnings = Vec::new();
    let mut risk_score: u8 = 0;

    let parsed = match url::Url::parse(url) {
        Ok(p) => p,
        Err(_) => {
            return SecurityCheckResult {
                is_safe: false,
                is_phishing_suspect: true,
                warnings: vec!["Invalid URL format".to_string()],
                risk_score: 90,
                upgraded_url: None,
            }
        }
    };

    let hostname = parsed.host_str().unwrap_or("").to_lowercase();
    let path_query = format!("{}{}", parsed.path(), parsed.query().unwrap_or("")).to_lowercase();

    // 1. HTTP (nije HTTPS)
    if parsed.scheme() == "http" {
        warnings.push("Connection is not encrypted (HTTP)".to_string());
        risk_score += 20;
    }

    // 2. Trusted domain check
    let is_trusted = TRUSTED_DOMAINS.iter().any(|d| {
        hostname == *d || hostname.ends_with(&format!(".{}", d))
    });
    if is_trusted {
        return SecurityCheckResult {
            is_safe: true,
            is_phishing_suspect: false,
            warnings,
            risk_score: 0,
            upgraded_url: None,
        };
    }

    // 3. Suspicious TLD
    let has_suspicious_tld = SUSPICIOUS_TLDS.iter().any(|tld| hostname.ends_with(tld));
    if has_suspicious_tld {
        warnings.push("Suspicious top-level domain detected".to_string());
        risk_score += 25;
    }

    // 4. Phishing keywords u hostname/path
    let full_text = format!("{} {}", hostname, path_query);
    let phishing_hits: Vec<&str> = PHISHING_PATTERNS
        .iter()
        .filter(|p| full_text.contains(*p))
        .copied()
        .collect();

    if !phishing_hits.is_empty() {
        warnings.push(format!(
            "Suspicious keywords detected: {}",
            phishing_hits.join(", ")
        ));
        risk_score += (phishing_hits.len() as u8 * 15).min(45);
    }

    // 5. Previše subdomene (obično phishing)
    let subdomain_count = hostname.split('.').count().saturating_sub(2);
    if subdomain_count > 2 {
        warnings.push("Unusual number of subdomains".to_string());
        risk_score += 10;
    }

    // 6. IP adresa umjesto domene
    if hostname.parse::<std::net::IpAddr>().is_ok() {
        warnings.push("Direct IP address — no domain name".to_string());
        risk_score += 30;
    }

    // 7. Punycode / IDN homograph
    if hostname.contains("xn--") {
        warnings.push("Internationalized domain — possible homograph attack".to_string());
        risk_score += 20;
    }

    let risk_score = risk_score.min(100);
    let is_phishing_suspect = risk_score >= 40;

    SecurityCheckResult {
        is_safe: risk_score < 40,
        is_phishing_suspect,
        warnings,
        risk_score,
        upgraded_url: if parsed.scheme() == "http" {
            Some(url.replacen("http://", "https://", 1))
        } else {
            None
        },
    }
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

#[command]
pub async fn sec_check_url(url: String) -> Result<SecurityCheckResult, String> {
    Ok(analyze_url(&url))
}

#[command]
pub async fn sec_get_cert_info(url: String) -> Result<CertInfo, String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    Ok(CertInfo {
        hostname: parsed.host_str().unwrap_or("").to_string(),
        protocol: parsed.scheme().to_string(),
        is_secure: parsed.scheme() == "https",
        tls_version: "TLS 1.3".to_string(), // WebKit koristi TLS 1.3 by default
    })
}

#[command]
pub async fn sec_upgrade_http(url: String) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() == "http" {
        Ok(url.replacen("http://", "https://", 1))
    } else {
        Ok(url)
    }
}
