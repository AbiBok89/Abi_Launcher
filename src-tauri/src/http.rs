use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{ensure_dir, rename_with_retry};
use crate::log::AppLogger;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CACHE_CONTROL, LOCATION, RANGE, USER_AGENT};
use reqwest::{Client, Response, StatusCode};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

pub const APP_USER_AGENT: &str = "AbiLauncher (+https://github.com/AbiBok89/Abi_Launcher)";

pub const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "cdn.modrinth.com",
];

pub fn build_http_client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .build()
        .expect("http client build")
}

pub fn is_allowed_url(value: &str) -> bool {
    let Ok(u) = Url::parse(value) else {
        return false;
    };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    let Some(host) = u.host_str() else {
        return false;
    };
    let lower = host.to_ascii_lowercase();
    ALLOWED_DOWNLOAD_HOSTS.contains(&lower.as_str())
}

fn safe_host(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

pub fn describe_reqwest_error(e: &reqwest::Error, url: &str) -> LauncherError {
    let host = safe_host(url);
    if e.is_timeout() {
        return LauncherError::new(
            ErrorCode::GithubUnavailable,
            "Сервер не отвечает",
            format!("{host} не ответил вовремя."),
        )
        .with_hint("Проверьте интернет, VPN или прокси и повторите попытку.");
    }
    let msg = e.to_string().to_lowercase();
    if msg.contains("dns") || msg.contains("lookup") || msg.contains("resolve") {
        return LauncherError::new(
            ErrorCode::Offline,
            "Нет подключения к интернету",
            format!("Не удалось найти сервер {host}. Похоже, нет интернета или не работает DNS."),
        )
        .with_hint("Проверьте подключение и нажмите «Повторить проверку».");
    }
    LauncherError::new(
        ErrorCode::GithubUnavailable,
        "Сервер недоступен",
        format!("Не удалось подключиться к {host}: {e}"),
    )
    .with_hint("Проверьте подключение к интернету и повторите попытку.")
}

pub fn describe_http_status(status: StatusCode, url: &str) -> LauncherError {
    let host = safe_host(url);
    let code = status.as_u16();
    if code == 404 {
        return LauncherError::new(
            ErrorCode::GithubUnavailable,
            "Файл не найден",
            format!("Сервер {host} ответил «не найдено» (404) для {url}."),
        )
        .with_hint("Проверьте адрес репозитория и что файл опубликован (релиз не в статусе черновика).");
    }
    if code == 403 || code == 429 {
        return LauncherError::new(
            ErrorCode::GithubUnavailable,
            "Превышен лимит запросов",
            format!("{host} временно ограничил запросы (HTTP {code})."),
        )
        .with_hint("Подождите несколько минут и повторите попытку.");
    }
    LauncherError::new(
        ErrorCode::GithubUnavailable,
        "Ошибка сервера",
        format!("{host} вернул HTTP {code}."),
    )
    .with_hint("Повторите попытку позже.")
}

#[derive(Clone, Copy)]
pub enum HostPolicy {
    PackAssetsOnly,
    LauncherUpdaterMeta,
    AnyHttps,
}

impl HostPolicy {
    pub fn check(&self, url: &str) -> bool {
        match self {
            HostPolicy::PackAssetsOnly => is_allowed_url(url),
            HostPolicy::LauncherUpdaterMeta => {
                if is_allowed_url(url) {
                    return true;
                }
                let Ok(u) = Url::parse(url) else {
                    return false;
                };
                u.scheme() == "https"
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.host_str()
                        .is_some_and(|h| h.eq_ignore_ascii_case("api.github.com"))
                    && u.path()
                        .eq_ignore_ascii_case("/repos/AbiBok89/Abi_Launcher/releases/latest")
            }
            HostPolicy::AnyHttps => {
                let Ok(u) = Url::parse(url) else {
                    return false;
                };
                u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
            }
        }
    }
}

pub async fn safe_get(
    client: &Client,
    url: &str,
    policy: HostPolicy,
    extra_headers: Option<HeaderMap>,
    timeout: Duration,
    cancel: &CancelToken,
) -> AppResult<Response> {
    let mut current = url.to_string();
    for _hop in 0..6 {
        cancel.check()?;
        if !policy.check(&current) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Запрещённый адрес загрузки",
                format!("Адрес {current} не входит в список разрешённых."),
            )
            .with_hint("Владелец сборки должен размещать файлы на GitHub (Releases или raw)."));
        }

        let mut req = client
            .get(&current)
            .timeout(timeout)
            .header(USER_AGENT, APP_USER_AGENT)
            .header(CACHE_CONTROL, "no-cache");
        if let Some(ref h) = extra_headers {
            req = req.headers(h.clone());
        }

        let res = tokio::select! {
            _ = cancel.cancelled() => return Err(LauncherError::cancelled()),
            r = req.send() => r.map_err(|e| describe_reqwest_error(&e, &current))?,
        };

        let status = res.status();
        if status.is_redirection() {
            if let Some(loc) = res.headers().get(LOCATION).and_then(|v| v.to_str().ok()) {
                let base = Url::parse(&current).map_err(|e| {
                    LauncherError::new(ErrorCode::GithubUnavailable, "Некорректный редирект", e.to_string())
                })?;
                current = base
                    .join(loc)
                    .map_err(|e| {
                        LauncherError::new(
                            ErrorCode::GithubUnavailable,
                            "Некорректный редирект",
                            e.to_string(),
                        )
                    })?
                    .to_string();
                continue;
            }
        }
        return Ok(res);
    }
    Err(LauncherError::new(
        ErrorCode::GithubUnavailable,
        "Слишком много перенаправлений",
        format!("Адрес {url} перенаправляет по кругу."),
    ))
}

pub async fn read_limited(
    res: Response,
    max_bytes: usize,
    cancel: &CancelToken,
) -> AppResult<Vec<u8>> {
    if let Some(len) = res.content_length() {
        if len as usize > max_bytes {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Слишком большой ответ",
                format!("Ответ сервера превышает {max_bytes} байт."),
            ));
        }
    }
    let mut out = Vec::new();
    let mut stream = res.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Err(LauncherError::cancelled()),
            next = stream.next() => match next {
                None => break,
                Some(Err(e)) => return Err(LauncherError::new(ErrorCode::GithubUnavailable, "Ошибка чтения ответа", e.to_string())),
                Some(Ok(chunk)) => {
                    if out.len() + chunk.len() > max_bytes {
                        return Err(LauncherError::new(
                            ErrorCode::ManifestInvalid,
                            "Слишком большой ответ",
                            format!("Ответ сервера превышает {max_bytes} байт."),
                        ));
                    }
                    out.extend_from_slice(&chunk);
                }
            }
        }
    }
    Ok(out)
}

pub async fn fetch_text(
    client: &Client,
    url: &str,
    policy: HostPolicy,
    max_bytes: usize,
    timeout: Duration,
    accept: Option<&str>,
    cancel: &CancelToken,
) -> AppResult<String> {
    let mut headers = HeaderMap::new();
    if let Some(acc) = accept {
        if let Ok(v) = HeaderValue::from_str(acc) {
            headers.insert(ACCEPT, v);
        }
    }
    let res = safe_get(client, url, policy, Some(headers), timeout, cancel).await?;
    if !res.status().is_success() {
        return Err(describe_http_status(res.status(), url));
    }
    let bytes = read_limited(res, max_bytes, cancel).await?;
    String::from_utf8(bytes).map_err(|e| {
        LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Некорректная кодировка текста",
            e.to_string(),
        )
    })
}

pub async fn fetch_buffer(
    client: &Client,
    url: &str,
    policy: HostPolicy,
    max_bytes: usize,
    timeout: Duration,
    cancel: &CancelToken,
) -> AppResult<Vec<u8>> {
    let res = safe_get(client, url, policy, None, timeout, cancel).await?;
    if !res.status().is_success() {
        return Err(describe_http_status(res.status(), url));
    }
    read_limited(res, max_bytes, cancel).await
}

#[derive(Clone, Copy)]
pub enum ChecksumAlgo {
    Sha256,
    Sha1,
}

pub async fn hash_file(path: &Path, algo: ChecksumAlgo, cancel: &CancelToken) -> AppResult<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    match algo {
        ChecksumAlgo::Sha256 => {
            let mut hasher = Sha256::new();
            loop {
                cancel.check()?;
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex::encode(hasher.finalize()))
        }
        ChecksumAlgo::Sha1 => {
            let mut hasher = Sha1::new();
            loop {
                cancel.check()?;
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex::encode(hasher.finalize()))
        }
    }
}

pub fn sha256_text(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    hex::encode(h.finalize())
}

pub struct DownloadSpec<'a> {
    pub urls: &'a [String],
    pub dest: &'a Path,
    pub expected_size: Option<u64>,
    pub expected_hash: Option<(ChecksumAlgo, &'a str)>,
    pub policy: HostPolicy,
    pub attempts: usize,
}

pub async fn download_verified<F>(
    client: &Client,
    log: &AppLogger,
    spec: DownloadSpec<'_>,
    cancel: &CancelToken,
    mut on_bytes: F,
) -> AppResult<()>
where
    F: FnMut(i64) + Send,
{
    if spec.urls.is_empty() {
        return Err(LauncherError::new(
            ErrorCode::DownloadFailed,
            "Нет ссылки для загрузки",
            format!("Файл {} не имеет адреса загрузки.", spec.dest.display()),
        ));
    }
    if let Some(parent) = spec.dest.parent() {
        ensure_dir(parent).await?;
    }
    let part = Path::new(&format!("{}.part", spec.dest.display())).to_path_buf();
    let short_name = spec
        .dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();

    let attempts = spec.attempts.max(1);
    let mut last_err: Option<LauncherError> = None;

    for attempt in 1..=attempts {
        cancel.check()?;
        let url = &spec.urls[(attempt - 1) % spec.urls.len()];
        match download_once(client, url, &part, spec.expected_size, spec.policy, cancel, &mut on_bytes).await {
            Ok(()) => {
                let meta = tokio::fs::metadata(&part).await?;
                if let Some(exp_size) = spec.expected_size {
                    if meta.len() != exp_size {
                        let _ = tokio::fs::remove_file(&part).await;
                        last_err = Some(LauncherError::new(
                            ErrorCode::Integrity,
                            "Повреждённый файл",
                            format!(
                                "Размер {url} не совпал: {} вместо {exp_size}.",
                                meta.len()
                            ),
                        ));
                        continue;
                    }
                }
                if let Some((algo, expected)) = spec.expected_hash {
                    let actual = hash_file(&part, algo, cancel).await?;
                    if !actual.eq_ignore_ascii_case(expected) {
                        let _ = tokio::fs::remove_file(&part).await;
                        last_err = Some(
                            LauncherError::new(
                                ErrorCode::Integrity,
                                "Повреждённый файл",
                                format!("Контрольная сумма файла {short_name} не совпала с манифестом."),
                            )
                            .with_hint("Файл будет скачан заново. Если ошибка повторяется — пересоберите манифест."),
                        );
                        continue;
                    }
                }
                rename_with_retry(&part, spec.dest).await?;
                return Ok(());
            }
            Err(e) => {
                if e.is_cancelled() || cancel.is_aborted() {
                    return Err(LauncherError::cancelled());
                }
                let retriable = e.code != ErrorCode::ManifestInvalid;
                last_err = Some(e.clone());
                if !retriable || attempt == attempts {
                    break;
                }
                let delay_ms = 500u64.saturating_mul(1 << (attempt - 1).min(4)).min(8000);
                log.warn(
                    "http",
                    format!("Повтор загрузки {short_name} через {delay_ms} мс ({attempt}/{attempts}): {e}"),
                );
                tokio::select! {
                    _ = cancel.cancelled() => return Err(LauncherError::cancelled()),
                    _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                }
            }
        }
    }

    let err = last_err.unwrap_or_else(|| {
        LauncherError::new(
            ErrorCode::DownloadFailed,
            "Не удалось скачать файл",
            short_name.clone(),
        )
    });
    if matches!(err.code, ErrorCode::Integrity | ErrorCode::ManifestInvalid) {
        return Err(err);
    }
    Err(LauncherError::new(
        ErrorCode::DownloadFailed,
        "Не удалось скачать файл",
        format!("{short_name}: {}", err.message),
    )
    .with_hint("Скачанные части сохранены — нажмите «Повторить», загрузка продолжится."))
}

async fn download_once<F>(
    client: &Client,
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    policy: HostPolicy,
    cancel: &CancelToken,
    on_bytes: &mut F,
) -> AppResult<()>
where
    F: FnMut(i64) + Send,
{
    let mut existing = match tokio::fs::metadata(part).await {
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    if let Some(exp) = expected_size {
        if existing > exp {
            let _ = tokio::fs::remove_file(part).await;
            existing = 0;
        } else if existing == exp && exp > 0 {
            return Ok(());
        }
    } else if existing > 0 {
        let _ = tokio::fs::remove_file(part).await;
        existing = 0;
    }

    let mut headers = HeaderMap::new();
    if existing > 0 {
        if let Ok(v) = HeaderValue::from_str(&format!("bytes={existing}-")) {
            headers.insert(RANGE, v);
        }
    }

    let res = safe_get(
        client,
        url,
        policy,
        Some(headers),
        Duration::from_secs(30 * 60),
        cancel,
    )
    .await?;

    if res.status().as_u16() == 416 {
        let _ = tokio::fs::remove_file(part).await;
        return Err(LauncherError::new(
            ErrorCode::DownloadFailed,
            "Ошибка докачки",
            "Сервер отклонил продолжение загрузки, начнём заново.",
        ));
    }
    if !res.status().is_success() {
        return Err(describe_http_status(res.status(), url));
    }

    let append = res.status().as_u16() == 206 && existing > 0;
    if !append && existing > 0 {
        on_bytes(-(existing as i64));
        existing = 0;
    }

    let mut file = if append {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(part)
            .await?
    } else {
        tokio::fs::File::create(part).await?
    };

    let mut written = existing;
    let mut stream = res.bytes_stream();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Err(LauncherError::cancelled()),
            next = stream.next() => match next {
                None => break,
                Some(Err(e)) => return Err(describe_reqwest_error(&e, url)),
                Some(Ok(chunk)) => {
                    written += chunk.len() as u64;
                    if let Some(exp) = expected_size {
                        if written > exp {
                            return Err(LauncherError::new(
                                ErrorCode::Integrity,
                                "Повреждённый файл",
                                "Сервер прислал больше данных, чем указано в манифесте.",
                            ));
                        }
                    }
                    file.write_all(&chunk).await?;
                    on_bytes(chunk.len() as i64);
                }
            }
        }
    }
    file.flush().await?;
    Ok(())
}
