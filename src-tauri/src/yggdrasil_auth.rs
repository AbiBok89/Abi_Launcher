use crate::auth_config::AuthConfig;
use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{ensure_dir, read_json_file, write_json_atomic};
use crate::log::AppLogger;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

const AUTHLIB_UPSTREAM_LATEST: &str = "https://authlib-injector.yushi.moe/artifact/latest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    pub client_token: String,
    pub site_url: String,
    pub yggdrasil_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YggdrasilErrorResponse {
    error: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YggdrasilAuthResponse {
    access_token: String,
    client_token: String,
    selected_profile: YggdrasilProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YggdrasilProfile {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SiteInjectorMeta {
    sha256: String,
    download_url: String,
}

#[derive(Debug, Deserialize)]
struct UpstreamInjectorMeta {
    download_url: String,
    checksums: Option<UpstreamInjectorChecksums>,
}

#[derive(Debug, Deserialize)]
struct UpstreamInjectorChecksums {
    sha256: Option<String>,
}

pub struct YggdrasilAuthStore {
    file_path: PathBuf,
    http: Client,
    cached: Mutex<Option<AuthSession>>,
}

fn generate_client_token() -> String {
    let ts = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let mut h = Sha256::new();
    h.update(format!("client:{}:{ts}", std::process::id()).as_bytes());
    hex::encode(&h.finalize()[..16])
}

impl YggdrasilAuthStore {
    pub fn new(user_data_dir: PathBuf, http: Client) -> Self {
        Self {
            file_path: user_data_dir.join("auth_session.json"),
            http,
            cached: Mutex::new(None),
        }
    }

    pub async fn get_session(&self) -> Option<AuthSession> {
        {
            let g = self.cached.lock().await;
            if let Some(ref s) = *g {
                return Some(s.clone());
            }
        }
        let loaded: Option<AuthSession> = read_json_file(&self.file_path).await.ok().flatten();
        if let Some(ref s) = loaded {
            let mut g = self.cached.lock().await;
            *g = Some(s.clone());
        }
        loaded
    }

    async fn save_session(&self, session: &AuthSession) -> AppResult<()> {
        write_json_atomic(&self.file_path, session).await?;
        let mut g = self.cached.lock().await;
        *g = Some(session.clone());
        Ok(())
    }

    async fn clear_session(&self) {
        let _ = tokio::fs::remove_file(&self.file_path).await;
        let mut g = self.cached.lock().await;
        *g = None;
    }

    pub async fn login(
        &self,
        cfg: &AuthConfig,
        username_or_email: &str,
        password: &str,
    ) -> AppResult<AuthSession> {
        let login = username_or_email.trim();
        if login.is_empty() || password.is_empty() {
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Пустые данные входа",
                "Введите логин/email и пароль.",
            ));
        }

        let client_token = self
            .get_session()
            .await
            .map(|s| s.client_token)
            .unwrap_or_else(generate_client_token);

        let url = format!("{}/authserver/authenticate", cfg.yggdrasil_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "agent": { "name": "Minecraft", "version": 1 },
                "username": login,
                "password": password,
                "clientToken": client_token,
                "requestUser": false
            }))
            .send()
            .await
            .map_err(|e| {
                LauncherError::new(
                    ErrorCode::Offline,
                    "Сервер авторизации недоступен",
                    format!("Не удалось подключиться к {}: {e}", cfg.yggdrasil_url),
                )
                .with_hint("Убедитесь, что сайт/сервер авторизации запущен и доступен.")
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_dto = resp.json::<YggdrasilErrorResponse>().await.ok();
            let msg = err_dto
                .and_then(|d| d.error_message.or(d.error))
                .unwrap_or_else(|| format!("Сервер авторизации вернул статус {status}"));
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Ошибка входа",
                msg,
            ));
        }

        let auth: YggdrasilAuthResponse = resp.json().await.map_err(|e| {
            LauncherError::new(
                ErrorCode::DownloadFailed,
                "Некорректный ответ сервера",
                format!("Ошибка разбора ответа авторизации: {e}"),
            )
        })?;

        let session = AuthSession {
            username: auth.selected_profile.name,
            uuid: auth.selected_profile.id,
            access_token: auth.access_token,
            client_token: auth.client_token,
            site_url: cfg.site_url.clone(),
            yggdrasil_url: cfg.yggdrasil_url.clone(),
        };

        self.save_session(&session).await?;
        Ok(session)
    }

    pub async fn validate_or_refresh(&self, cfg: &AuthConfig) -> AppResult<Option<AuthSession>> {
        let Some(mut session) = self.get_session().await else {
            return Ok(None);
        };

        // Синхронизируем актуальные URL из конфига
        session.site_url = cfg.site_url.clone();
        session.yggdrasil_url = cfg.yggdrasil_url.clone();

        let validate_url = format!("{}/authserver/validate", cfg.yggdrasil_url);
        let val_res = self
            .http
            .post(&validate_url)
            .json(&serde_json::json!({
                "accessToken": session.access_token,
                "clientToken": session.client_token
            }))
            .send()
            .await;

        match val_res {
            Ok(resp) if resp.status().as_u16() == 204 || resp.status().is_success() => {
                return Ok(Some(session));
            }
            Err(_) => {
                // Если сервер временно недоступен — не сбрасываем локальную сессию молча
                return Ok(Some(session));
            }
            Ok(_) => {
                // Токен невалиден или истёк — пробуем refresh
            }
        }

        let refresh_url = format!("{}/authserver/refresh", cfg.yggdrasil_url);
        let ref_res = self
            .http
            .post(&refresh_url)
            .json(&serde_json::json!({
                "accessToken": session.access_token,
                "clientToken": session.client_token
            }))
            .send()
            .await;

        match ref_res {
            Ok(resp) if resp.status().is_success() => {
                let auth: YggdrasilAuthResponse = resp.json().await.map_err(|e| {
                    LauncherError::new(
                        ErrorCode::DownloadFailed,
                        "Ошибка обновления сессии",
                        e.to_string(),
                    )
                })?;
                let refreshed = AuthSession {
                    username: auth.selected_profile.name,
                    uuid: auth.selected_profile.id,
                    access_token: auth.access_token,
                    client_token: auth.client_token,
                    site_url: cfg.site_url.clone(),
                    yggdrasil_url: cfg.yggdrasil_url.clone(),
                };
                self.save_session(&refreshed).await?;
                Ok(Some(refreshed))
            }
            Ok(_) => {
                self.clear_session().await;
                Ok(None)
            }
            Err(_) => Ok(Some(session)),
        }
    }

    pub async fn logout(&self, cfg: &AuthConfig) -> AppResult<()> {
        if let Some(session) = self.get_session().await {
            let url = format!("{}/authserver/invalidate", cfg.yggdrasil_url);
            let _ = self
                .http
                .post(&url)
                .json(&serde_json::json!({
                    "accessToken": session.access_token,
                    "clientToken": session.client_token
                }))
                .send()
                .await;
        }
        self.clear_session().await;
        Ok(())
    }
}

async fn sha256_file_hex(path: &Path) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Some(hex::encode(hasher.finalize()))
}

pub async fn ensure_authlib_injector(
    http: &Client,
    shared_dir: &Path,
    site_url: &str,
    log: &AppLogger,
    cancel: &CancelToken,
) -> AppResult<PathBuf> {
    ensure_dir(shared_dir).await?;
    let jar_path = shared_dir.join("authlib-injector.jar");

    // 1. Пытаемся получить метаданные с нашего сайта
    let site_meta_url = format!("{}/api/launcher/authlib-injector", site_url.trim_end_matches('/'));
    let mut download_url: Option<String> = None;
    let mut expected_sha: Option<String> = None;

    if let Ok(resp) = http.get(&site_meta_url).send().await {
        if resp.status().is_success() {
            if let Ok(meta) = resp.json::<SiteInjectorMeta>().await {
                download_url = Some(meta.download_url);
                expected_sha = Some(meta.sha256.to_lowercase());
            }
        }
    }

    // 2. Fallback на официальный релиз yushi.moe, если сайт не ответил
    if download_url.is_none() {
        if let Ok(resp) = http.get(AUTHLIB_UPSTREAM_LATEST).send().await {
            if resp.status().is_success() {
                if let Ok(up) = resp.json::<UpstreamInjectorMeta>().await {
                    download_url = Some(up.download_url);
                    expected_sha = up.checksums.and_then(|c| c.sha256.map(|s| s.to_lowercase()));
                }
            }
        }
    }

    // 3. Проверяем уже скачанный authlib-injector.jar
    if jar_path.is_file() {
        if let Some(ref exp) = expected_sha {
            if let Some(actual) = sha256_file_hex(&jar_path).await {
                if actual.eq_ignore_ascii_case(exp) {
                    return Ok(jar_path);
                }
            }
        } else {
            return Ok(jar_path);
        }
    }

    let Some(dl_url) = download_url else {
        return Err(LauncherError::new(
            ErrorCode::DownloadFailed,
            "Не удалось получить authlib-injector.jar",
            "Ни сайт авторизации, ни зеркало authlib-injector.yushi.moe не ответили.",
        ));
    };

    cancel.check()?;
    log.info("auth", format!("Загрузка authlib-injector.jar из {dl_url}"));

    let resp = http.get(&dl_url).send().await.map_err(|e| {
        LauncherError::new(
            ErrorCode::DownloadFailed,
            "Ошибка загрузки authlib-injector",
            e.to_string(),
        )
    })?;
    if !resp.status().is_success() {
        return Err(LauncherError::new(
            ErrorCode::DownloadFailed,
            "Ошибка загрузки authlib-injector",
            format!("HTTP {} при загрузке {}", resp.status(), dl_url),
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| {
        LauncherError::new(
            ErrorCode::DownloadFailed,
            "Ошибка чтения authlib-injector",
            e.to_string(),
        )
    })?;

    if let Some(ref exp) = expected_sha {
        let mut h = Sha256::new();
        h.update(&bytes);
        let actual = hex::encode(h.finalize());
        if !actual.eq_ignore_ascii_case(exp) {
            return Err(LauncherError::new(
                ErrorCode::Integrity,
                "Ошибка контрольной суммы authlib-injector",
                format!("Ожидалось {exp}, получено {actual}"),
            ));
        }
    }

    let tmp_path = shared_dir.join("authlib-injector.jar.part");
    tokio::fs::write(&tmp_path, &bytes).await?;
    let _ = tokio::fs::remove_file(&jar_path).await;
    tokio::fs::rename(&tmp_path, &jar_path).await?;

    Ok(jar_path)
}
