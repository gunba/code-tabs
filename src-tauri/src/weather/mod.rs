//! Weather scene driven by Cloudflare-derived country code.
//!
//! Anthropic and OpenAI both serve through Cloudflare, so their responses
//! carry a `cf-ipcountry` header naming the user's edge POP country. The
//! proxy (`src-tauri/src/proxy/mod.rs`) hands us each country it sees via
//! [`set_country`]; we pick coordinates for that country, fetch current
//! conditions from Open-Meteo every ~30 minutes, persist the latest
//! payload to `<appdata>/weather.json`, and emit a `weather-changed`
//! Tauri event the renderer subscribes to.
//!
//! No API key is required: Open-Meteo is open and free for non-commercial
//! use. A failed fetch retries after one minute; success holds for 30 min.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const WEATHER_CACHE_FILE: &str = "weather.json";
const POLL_INTERVAL: Duration = Duration::from_secs(30 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(60);

static COUNTRY: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CACHE: OnceLock<Mutex<Option<WeatherPayload>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeatherPayload {
    pub country: String,
    pub label: String,
    #[serde(rename = "weatherCode")]
    pub weather_code: i32,
    #[serde(rename = "tempC")]
    pub temp_c: f64,
    #[serde(rename = "windKph")]
    pub wind_kph: f64,
    #[serde(rename = "precipMm")]
    pub precip_mm: f64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
}

/// (lat, lon, label) for ~50 frequent countries. Unknown codes fall back
/// to Sydney so the scene always has something plausible to render.
pub fn coords_for(cc: &str) -> (f64, f64, &'static str) {
    match cc {
        "AU" => (-33.87, 151.21, "Sydney"),
        "NZ" => (-41.29, 174.78, "Wellington"),
        "US" => (38.90, -77.04, "Washington D.C."),
        "CA" => (45.42, -75.69, "Ottawa"),
        "MX" => (19.43, -99.13, "Mexico City"),
        "BR" => (-15.79, -47.88, "Brasília"),
        "AR" => (-34.61, -58.38, "Buenos Aires"),
        "CL" => (-33.45, -70.67, "Santiago"),
        "GB" => (51.51, -0.13, "London"),
        "IE" => (53.35, -6.26, "Dublin"),
        "FR" => (48.86, 2.35, "Paris"),
        "DE" => (52.52, 13.41, "Berlin"),
        "ES" => (40.42, -3.70, "Madrid"),
        "PT" => (38.72, -9.14, "Lisbon"),
        "IT" => (41.90, 12.50, "Rome"),
        "NL" => (52.37, 4.90, "Amsterdam"),
        "BE" => (50.85, 4.35, "Brussels"),
        "CH" => (46.95, 7.45, "Bern"),
        "AT" => (48.21, 16.37, "Vienna"),
        "SE" => (59.33, 18.07, "Stockholm"),
        "NO" => (59.91, 10.75, "Oslo"),
        "DK" => (55.68, 12.57, "Copenhagen"),
        "FI" => (60.17, 24.94, "Helsinki"),
        "IS" => (64.15, -21.94, "Reykjavik"),
        "PL" => (52.23, 21.01, "Warsaw"),
        "CZ" => (50.08, 14.44, "Prague"),
        "HU" => (47.50, 19.04, "Budapest"),
        "RO" => (44.43, 26.10, "Bucharest"),
        "GR" => (37.98, 23.73, "Athens"),
        "TR" => (39.93, 32.86, "Ankara"),
        "RU" => (55.75, 37.62, "Moscow"),
        "UA" => (50.45, 30.52, "Kyiv"),
        "IN" => (28.61, 77.21, "New Delhi"),
        "PK" => (33.69, 73.05, "Islamabad"),
        "CN" => (39.90, 116.41, "Beijing"),
        "TW" => (25.03, 121.57, "Taipei"),
        "HK" => (22.32, 114.17, "Hong Kong"),
        "JP" => (35.68, 139.69, "Tokyo"),
        "KR" => (37.57, 126.98, "Seoul"),
        "SG" => (1.35, 103.82, "Singapore"),
        "TH" => (13.75, 100.50, "Bangkok"),
        "VN" => (21.03, 105.85, "Hanoi"),
        "MY" => (3.14, 101.69, "Kuala Lumpur"),
        "ID" => (-6.21, 106.85, "Jakarta"),
        "PH" => (14.60, 120.98, "Manila"),
        "AE" => (24.45, 54.39, "Abu Dhabi"),
        "SA" => (24.71, 46.68, "Riyadh"),
        "IL" => (31.78, 35.22, "Jerusalem"),
        "EG" => (30.04, 31.24, "Cairo"),
        "ZA" => (-25.75, 28.19, "Pretoria"),
        "NG" => (9.08, 7.40, "Abuja"),
        "KE" => (-1.29, 36.82, "Nairobi"),
        _ => (-33.87, 151.21, "Sydney"),
    }
}

fn country_slot() -> &'static Mutex<Option<String>> {
    COUNTRY.get_or_init(|| Mutex::new(None))
}

fn cache_slot() -> &'static Mutex<Option<WeatherPayload>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Called fire-and-forget by the proxy on each upstream response. Two-letter
/// ISO codes only; `XX` (Cloudflare's "unknown") and other lengths are ignored.
pub fn set_country(cc: &str) {
    if cc.len() != 2 {
        return;
    }
    let upper = cc.to_uppercase();
    if upper == "XX" {
        return;
    }
    if let Ok(mut guard) = country_slot().lock() {
        *guard = Some(upper);
    }
}

fn current_country() -> Option<String> {
    country_slot().lock().ok().and_then(|g| g.clone())
}

#[derive(Deserialize)]
struct OpenMeteoResp {
    current: Option<OpenMeteoCurrent>,
}

#[derive(Deserialize)]
struct OpenMeteoCurrent {
    temperature_2m: Option<f64>,
    weather_code: Option<i32>,
    wind_speed_10m: Option<f64>,
    precipitation: Option<f64>,
}

async fn fetch_open_meteo(lat: f64, lon: f64) -> Result<(i32, f64, f64, f64), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("code-tabs")
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,weather_code,wind_speed_10m,precipitation"
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let body: OpenMeteoResp = resp.json().await.map_err(|e| e.to_string())?;
    let cur = body.current.ok_or_else(|| "missing current block".to_string())?;
    Ok((
        cur.weather_code.unwrap_or(0),
        cur.temperature_2m.unwrap_or(0.0),
        cur.wind_speed_10m.unwrap_or(0.0),
        cur.precipitation.unwrap_or(0.0),
    ))
}

fn cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(WEATHER_CACHE_FILE))
}

fn load_cached(app: &AppHandle) -> Option<WeatherPayload> {
    let path = cache_path(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_cached(app: &AppHandle, payload: &WeatherPayload) {
    let Some(path) = cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(payload) {
        let _ = std::fs::write(&path, json);
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Spawn the long-lived poll loop and rehydrate any cached payload from
/// disk so the renderer has something to draw on first paint, before
/// the user's first API call. Idempotent: safe to call once at startup.
pub fn init(app: AppHandle) {
    if let Some(cached) = load_cached(&app) {
        if let Ok(mut g) = cache_slot().lock() {
            *g = Some(cached.clone());
        }
        if let Ok(mut g) = country_slot().lock() {
            *g = Some(cached.country.clone());
        }
    }

    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(cc) = current_country() {
                let (lat, lon, label) = coords_for(&cc);
                match fetch_open_meteo(lat, lon).await {
                    Ok((code, temp, wind, precip)) => {
                        let payload = WeatherPayload {
                            country: cc,
                            label: label.to_string(),
                            weather_code: code,
                            temp_c: temp,
                            wind_kph: wind,
                            precip_mm: precip,
                            updated_at: now_secs(),
                        };
                        if let Ok(mut g) = cache_slot().lock() {
                            *g = Some(payload.clone());
                        }
                        save_cached(&app, &payload);
                        let _ = app.emit("weather-changed", &payload);
                        tokio::time::sleep(POLL_INTERVAL).await;
                        continue;
                    }
                    Err(_) => {
                        tokio::time::sleep(RETRY_INTERVAL).await;
                        continue;
                    }
                }
            }
            tokio::time::sleep(RETRY_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub fn get_current_weather() -> Option<WeatherPayload> {
    cache_slot().lock().ok().and_then(|g| g.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coords_known_country() {
        let (lat, _, label) = coords_for("AU");
        assert!((lat + 33.87).abs() < 0.1);
        assert_eq!(label, "Sydney");
    }

    #[test]
    fn coords_unknown_falls_back_to_sydney() {
        let (_, _, label) = coords_for("ZZ");
        assert_eq!(label, "Sydney");
    }

    #[test]
    fn set_country_lowercases_and_stores() {
        if let Ok(mut g) = country_slot().lock() {
            *g = None;
        }
        set_country("au");
        assert_eq!(current_country().as_deref(), Some("AU"));
    }

    #[test]
    fn set_country_ignores_xx_and_short() {
        if let Ok(mut g) = country_slot().lock() {
            *g = None;
        }
        set_country("XX");
        assert!(current_country().is_none());
        set_country("X");
        assert!(current_country().is_none());
        set_country("xx");
        assert!(current_country().is_none());
    }
}
