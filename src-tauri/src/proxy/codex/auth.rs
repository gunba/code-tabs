use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use base64::Engine;
use rand::Rng;

// ── OAuth Configuration ─────────────────────────────────────────────

const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CALLBACK_PORT: u16 = 1455;
const SCOPES: &str = "openid profile email offline_access api.connectors.read api.connectors.invoke api.responses.write";
const FLOW_TIMEOUT_SECS: u64 = 600; // 10 minutes
const TOKEN_REFRESH_BUFFER_SECS: u64 = 60;

// ── Token types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: u64,
    pub email: Option<String>,
}

/// [PR-02] Shared OAuth-backed authentication state for the Codex provider.
pub struct CodexAuthState {
    inner: Arc<Mutex<Option<CodexTokens>>>,
    storage_path: PathBuf,
}

impl CodexAuthState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let storage_path = app_data_dir.join("codex_auth.json");
        let tokens = std::fs::read_to_string(&storage_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        Self {
            inner: Arc::new(Mutex::new(tokens)),
            storage_path,
        }
    }

    pub fn is_logged_in(&self) -> bool {
        self.inner.lock().ok().map_or(false, |t| {
            t.as_ref().map_or(false, |t| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                // Token is valid, or we have a refresh token to renew it
                now < t.expires_at || t.refresh_token.is_some()
            })
        })
    }

    pub fn get_email(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|t| t.as_ref().and_then(|t| t.email.clone()))
    }

    /// Get the current access token without refreshing. Returns None if not logged in.
    pub fn get_access_token_sync(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|t| t.as_ref().map(|t| t.access_token.clone()))
    }

    /// Get a valid access token, auto-refreshing if expired.
    pub async fn get_access_token(&self) -> Result<String, String> {
        let (token, refresh_token, expires_at) = {
            let guard = self.inner.lock().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                Some(t) => (t.access_token.clone(), t.refresh_token.clone(), t.expires_at),
                None => return Err("Not logged in".into()),
            }
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if now + TOKEN_REFRESH_BUFFER_SECS < expires_at {
            return Ok(token);
        }

        // Token expired or about to expire — refresh
        match refresh_token {
            Some(rt) => {
                let new_tokens = refresh_access_token(&rt).await?;
                self.set_tokens(new_tokens.clone());
                Ok(new_tokens.access_token)
            }
            None => Err("Token expired and no refresh token available".into()),
        }
    }

    pub fn set_tokens(&self, tokens: CodexTokens) {
        if let Ok(json) = serde_json::to_string_pretty(&tokens) {
            if let Some(parent) = self.storage_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.storage_path, json);
        }
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(tokens);
        }
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.storage_path);
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

// ── PKCE ────────────────────────────────────────────────────────────

fn generate_pkce() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill(&mut verifier_bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());

    (verifier, challenge)
}

fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    hex::encode(&bytes)
}

// Inline hex encoding to avoid adding the `hex` crate
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ── OAuth Flow ──────────────────────────────────────────────────────

/// Build the authorization URL and return it along with the PKCE verifier and state.
pub fn build_auth_url() -> (String, String, String) {
    let (verifier, challenge) = generate_pkce();
    let state = generate_state();

    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs",
        AUTHORIZE_URL,
        CLIENT_ID,
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(SCOPES),
        challenge,
        state,
    );

    (url, verifier, state)
}

/// Start the local callback server and wait for the OAuth redirect.
/// Returns the authorization code on success.
pub async fn wait_for_callback(expected_state: &str) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{CALLBACK_PORT}"))
        .await
        .map_err(|e| format!("Failed to bind callback server: {e}"))?;

    let timeout = tokio::time::Duration::from_secs(FLOW_TIMEOUT_SECS);
    let result = tokio::time::timeout(timeout, async {
        loop {
            let (mut stream, _) = listener.accept().await
                .map_err(|e| format!("Callback accept failed: {e}"))?;

            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
            let request = String::from_utf8_lossy(&buf[..n]);

            // Parse the GET request for /auth/callback?code=...&state=...
            let first_line = request.lines().next().unwrap_or("");
            if !first_line.starts_with("GET /auth/callback") {
                let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(resp.as_bytes()).await;
                continue;
            }

            // Extract query parameters
            let query = first_line.split('?').nth(1)
                .and_then(|q| q.split(' ').next())
                .unwrap_or("");

            let params: std::collections::HashMap<&str, &str> = query
                .split('&')
                .filter_map(|p| {
                    let mut parts = p.splitn(2, '=');
                    Some((parts.next()?, parts.next()?))
                })
                .collect();

            let code = params.get("code").map(|s| s.to_string());
            let state = params.get("state").map(|s| *s);

            if let (Some(code), Some(st)) = (code, state) {
                if st == expected_state {
                    let html = "<html><body style='font-family:sans-serif;background:#0b1222;color:#e6eeff;padding:24px'><h2>Login complete</h2><p>You can close this tab.</p></body></html>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{html}",
                        html.len(),
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    return Ok(code);
                }
            }

            let html = "<html><body style='font-family:sans-serif;background:#0b1222;color:#e6eeff;padding:24px'><h2>Login failed</h2><p>Invalid callback parameters.</p></body></html>";
            let resp = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{html}",
                html.len(),
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            return Err("Invalid callback parameters".into());
        }
    }).await;

    result.map_err(|_| "Login timed out (10 minutes)".to_string())?
}

/// Exchange the authorization code for tokens.
pub async fn exchange_code(code: &str, verifier: &str) -> Result<CodexTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_in: Option<u64>,
    }

    let body: TokenResponse = resp.json().await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let email = body.id_token.as_deref().and_then(extract_email_from_jwt);

    Ok(CodexTokens {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: now + body.expires_in.unwrap_or(3600),
        email,
    })
}

/// Refresh an expired access token using the refresh token.
async fn refresh_access_token(refresh_token: &str) -> Result<CodexTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| format!("Token refresh failed: {e}"))?;

    if !resp.status().is_success() {
        return Err("Token refresh failed".into());
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        id_token: Option<String>,
        expires_in: Option<u64>,
    }

    let body: TokenResponse = resp.json().await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let email = body.id_token.as_deref().and_then(extract_email_from_jwt);

    Ok(CodexTokens {
        access_token: body.access_token,
        refresh_token: body.refresh_token.or_else(|| Some(refresh_token.to_string())),
        expires_at: now + body.expires_in.unwrap_or(3600),
        email,
    })
}

/// Extract email from a JWT id_token (no signature verification — just decode claims).
fn extract_email_from_jwt(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    // JWT uses base64url without padding
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("email").and_then(|e| e.as_str()).map(|s| s.to_string())
}

// ── URL encoding ────────────────────────────────────────────────────

mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut result = String::with_capacity(input.len() * 3);
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    result.push(byte as char);
                }
                _ => {
                    result.push('%');
                    result.push_str(&format!("{:02X}", byte));
                }
            }
        }
        result
    }
}
