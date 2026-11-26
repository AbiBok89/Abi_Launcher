use crate::fsutil::{read_json_file, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// URL веб-портала (по умолчанию настроен на развёрнутый сервер; для локального теста замените на "http://localhost:3000"
/// или переопределите в файле `<AppData>/AbiLauncher/auth_config.json`).
pub const DEFAULT_SITE_URL: &str = "https://hm575903.webhm.cloud";

/// URL эндпоинта Yggdrasil API (authlib-injector).
/// Для локального теста замените на "http://localhost:3000/api/yggdrasil", для HTTPS-домена — "https://your-domain.ru/api/yggdrasil".
pub const DEFAULT_YGGDRASIL_URL: &str = "https://hm575903.webhm.cloud/api/yggdrasil";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub site_url: String,
    pub yggdrasil_url: String,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            site_url: DEFAULT_SITE_URL.to_string(),
            yggdrasil_url: DEFAULT_YGGDRASIL_URL.to_string(),
        }
    }
}

pub async fn load_auth_config(user_data_dir: &Path) -> AuthConfig {
    let config_path = user_data_dir.join("auth_config.json");
    let mut cfg = read_json_file::<AuthConfig>(&config_path)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();

    if let Ok(env_site) = std::env::var("AUTH_SITE_URL") {
        let trimmed = env_site.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            cfg.site_url = trimmed.to_string();
            if std::env::var("AUTH_YGGDRASIL_URL").is_err() {
                cfg.yggdrasil_url = format!("{trimmed}/api/yggdrasil");
            }
        }
    }

    if let Ok(env_ygg) = std::env::var("AUTH_YGGDRASIL_URL") {
        let trimmed = env_ygg.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            cfg.yggdrasil_url = trimmed.to_string();
        }
    }

    cfg.site_url = cfg.site_url.trim_end_matches('/').to_string();
    cfg.yggdrasil_url = cfg.yggdrasil_url.trim_end_matches('/').to_string();

    if !config_path.exists() {
        let _ = write_json_atomic(&config_path, &cfg).await;
    }

    cfg
}
