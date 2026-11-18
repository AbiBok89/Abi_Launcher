use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::ensure_dir;
use crate::http::{
    describe_reqwest_error, download_verified, hash_file, is_allowed_url, safe_get, ChecksumAlgo,
    DownloadSpec, HostPolicy,
};
use crate::log::AppLogger;
use crate::types::{InstallMode, LauncherReleaseAssetInfo, LauncherUpdatePhase, LauncherUpdateState};
use chrono::Utc;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT};
use reqwest::Client;
use serde::Deserialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const LAUNCHER_GITHUB_REPO: &str = "AbiBok89/Abi_Launcher";
pub const LAUNCHER_RELEASE_API_URL: &str =
    "https://api.github.com/repos/AbiBok89/Abi_Launcher/releases/latest";
pub const LAUNCHER_RELEASES_PAGE_URL: &str =
    "https://github.com/AbiBok89/Abi_Launcher/releases";

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubReleaseAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

fn parse_semver(raw: &str) -> Option<(Vec<u64>, Vec<String>)> {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    let (core, pre_opt) = match cleaned.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (cleaned, None),
    };
    if core.is_empty() || !core.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let nums = core.split('.').filter_map(|p| p.parse::<u64>().ok()).collect();
    let pre = pre_opt
        .map(|p| {
            p.split('.')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some((nums, pre))
}

pub fn compare_semver(a_raw: &str, b_raw: &str) -> Ordering {
    let Some((an, ap)) = parse_semver(a_raw) else {
        return a_raw.trim().cmp(b_raw.trim());
    };
    let Some((bn, bp)) = parse_semver(b_raw) else {
        return a_raw.trim().cmp(b_raw.trim());
    };
    let len = an.len().max(bn.len());
    for i in 0..len {
        let da = *an.get(i).unwrap_or(&0);
        let db = *bn.get(i).unwrap_or(&0);
        if da != db {
            return da.cmp(&db);
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let plen = ap.len().max(bp.len());
            for i in 0..plen {
                match (ap.get(i), bp.get(i)) {
                    (None, None) => break,
                    (None, Some(_)) => return Ordering::Less,
                    (Some(_), None) => return Ordering::Greater,
                    (Some(pa), Some(pb)) => match (pa.parse::<u64>(), pb.parse::<u64>()) {
                        (Ok(na), Ok(nb)) => {
                            if na != nb {
                                return na.cmp(&nb);
                            }
                        }
                        (Ok(_), Err(_)) => return Ordering::Less,
                        (Err(_), Ok(_)) => return Ordering::Greater,
                        (Err(_), Err(_)) => {
                            let c = pa.cmp(pb);
                            if c != Ordering::Equal {
                                return c;
                            }
                        }
                    },
                }
            }
            Ordering::Equal
        }
    }
}

pub fn parse_sha256_digest(digest: Option<&str>) -> Option<String> {
    let raw = digest?.trim();
    let hex = raw.strip_prefix("sha256:").or_else(|| raw.strip_prefix("SHA256:"))?;
    let re = Regex::new(r"^[a-fA-F0-9]{64}$").unwrap();
    if re.is_match(hex) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

pub fn select_launcher_asset(
    assets: &[GitHubReleaseAsset],
    os: &str,
    arch: &str,
    install_mode: InstallMode,
) -> Option<LauncherReleaseAssetInfo> {
    let valid: Vec<&GitHubReleaseAsset> = assets
        .iter()
        .filter(|a| a.size > 0 && is_allowed_url(&a.browser_download_url))
        .collect();

    let find_by = |preds: &[fn(&str, &str) -> bool]| -> Option<LauncherReleaseAssetInfo> {
        for pred in preds {
            if let Some(hit) = valid.iter().find(|a| pred(&a.name.to_ascii_lowercase(), arch)) {
                return Some(LauncherReleaseAssetInfo {
                    name: hit.name.clone(),
                    url: hit.browser_download_url.clone(),
                    size: hit.size,
                    sha256: parse_sha256_digest(hit.digest.as_deref()),
                });
            }
        }
        None
    };

    if os == "windows" {
        if install_mode == InstallMode::Portable {
            return find_by(&[
                |n, arch| n.ends_with(".exe") && n.contains("portable") && (arch == "aarch64" && n.contains("arm64") || arch != "aarch64" && !n.contains("arm64")),
                |n, _| n.ends_with(".exe") && n.contains("portable"),
                |n, arch| n.ends_with(".exe") && (arch == "aarch64" && n.contains("arm64") || arch != "aarch64" && !n.contains("arm64")),
                |n, _| n.ends_with(".exe"),
            ]);
        }
        return find_by(&[
            |n, arch| n.ends_with(".exe") && !n.contains("portable") && (arch == "aarch64" && n.contains("arm64") || arch != "aarch64" && !n.contains("arm64")),
            |n, _| n.ends_with(".exe") && n.contains("portable"),
            |n, _| n.ends_with(".exe"),
        ]);
    }

    if os == "linux" {
        return find_by(&[
            |n, _| n.ends_with(".appimage"),
            |n, _| n.ends_with(".deb"),
            |n, _| n.ends_with(".tar.gz"),
        ]);
    }

    None
}

fn sanitize_asset_filename(name: &str) -> AppResult<String> {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let re = Regex::new(r"^[A-Za-z0-9._-]+$").unwrap();
    if base.is_empty() || base == "." || base == ".." || !re.is_match(base) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Некорректное имя файла обновления",
            format!("Имя ассета «{name}» отклонено проверкой безопасности."),
        ));
    }
    Ok(base.to_string())
}

async fn file_exists_valid(path: &Path, expected_size: u64, sha256: Option<&str>) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !meta.is_file() || meta.len() != expected_size {
        return false;
    }
    if let Some(expected) = sha256 {
        let tok = CancelToken::new();
        if let Ok(actual) = hash_file(path, ChecksumAlgo::Sha256, &tok).await {
            return actual.eq_ignore_ascii_case(expected);
        }
        return false;
    }
    true
}

type StateEmitter = Arc<dyn Fn(LauncherUpdateState) + Send + Sync>;

pub fn detect_install_mode(current_exe: Option<&Path>) -> (InstallMode, Option<PathBuf>) {
    if cfg!(debug_assertions) {
        return (InstallMode::Manual, None);
    }
    #[cfg(windows)]
    {
        if let Some(exe) = current_exe {
            if let Some(parent) = exe.parent() {
                if parent.join("uninstall.exe").is_file() {
                    return (InstallMode::Installer, Some(exe.to_path_buf()));
                }
            }
            return (InstallMode::Portable, Some(exe.to_path_buf()));
        }
    }
    let _ = current_exe;
    (InstallMode::Manual, None)
}

pub struct LauncherUpdater {
    user_data_dir: PathBuf,
    http: Client,
    log: AppLogger,
    metadata_url: String,
    policy: HostPolicy,
    state: Mutex<LauncherUpdateState>,
    active_cancel: Mutex<Option<CancelToken>>,
    emitter: Mutex<Option<StateEmitter>>,
    current_exe: Option<PathBuf>,
    on_quit: Arc<dyn Fn() + Send + Sync>,
}

impl LauncherUpdater {
    pub fn new(
        current_version: String,
        user_data_dir: PathBuf,
        http: Client,
        log: AppLogger,
        on_quit: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let exe = std::env::current_exe().ok();
        let (install_mode, portable_exe) = detect_install_mode(exe.as_deref());
        Self {
            user_data_dir,
            http,
            log,
            metadata_url: LAUNCHER_RELEASE_API_URL.to_string(),
            policy: HostPolicy::LauncherUpdaterMeta,
            state: Mutex::new(LauncherUpdateState {
                phase: LauncherUpdatePhase::Idle,
                current_version,
                latest_version: None,
                release_name: None,
                release_notes: None,
                release_url: None,
                published_at: None,
                asset: None,
                downloaded_path: None,
                progress_bytes_done: 0,
                progress_bytes_total: 0,
                progress_speed: 0,
                error: None,
                can_auto_install: install_mode != InstallMode::Manual,
                install_mode,
                checked_at: None,
            }),
            active_cancel: Mutex::new(None),
            emitter: Mutex::new(None),
            current_exe: portable_exe,
            on_quit,
        }
    }

    pub fn set_emitter<F>(&self, f: F)
    where
        F: Fn(LauncherUpdateState) + Send + Sync + 'static,
    {
        if let Ok(mut g) = self.emitter.lock() {
            *g = Some(Arc::new(f));
        }
    }

    pub fn get_state(&self) -> LauncherUpdateState {
        self.state.lock().unwrap().clone()
    }

    fn update_state<F>(&self, f: F) -> LauncherUpdateState
    where
        F: FnOnce(&mut LauncherUpdateState),
    {
        let snap = {
            let mut g = self.state.lock().unwrap();
            f(&mut g);
            g.clone()
        };
        if let Ok(g) = self.emitter.lock() {
            if let Some(ref emit) = *g {
                emit(snap.clone());
            }
        }
        snap
    }

    pub async fn check_for_updates(&self) -> LauncherUpdateState {
        {
            let cur = self.get_state();
            if matches!(
                cur.phase,
                LauncherUpdatePhase::Checking | LauncherUpdatePhase::Downloading
            ) {
                return cur;
            }
        }
        self.update_state(|s| {
            s.phase = LauncherUpdatePhase::Checking;
            s.error = None;
        });

        let cancel = CancelToken::new();
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );

        let res = match safe_get(
            &self.http,
            &self.metadata_url,
            self.policy,
            Some(headers),
            Duration::from_secs(15),
            &cancel,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                self.log
                    .warn("updater", format!("Не удалось проверить обновление лаунчера: {e}"));
                return self.update_state(|s| {
                    s.phase = LauncherUpdatePhase::Error;
                    s.error = Some(e.to_string());
                    s.checked_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                });
            }
        };

        if res.status().as_u16() == 404 {
            self.log
                .info("updater", "Официальных релизов лаунчера на GitHub пока нет.");
            return self.update_state(|s| {
                s.phase = LauncherUpdatePhase::UpToDate;
                s.latest_version = None;
                s.release_name = None;
                s.release_notes = None;
                s.release_url = Some(LAUNCHER_RELEASES_PAGE_URL.to_string());
                s.published_at = None;
                s.asset = None;
                s.downloaded_path = None;
                s.error = None;
                s.checked_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            });
        }

        if !res.status().is_success() {
            let status = res.status().as_u16();
            return self.update_state(|s| {
                s.phase = LauncherUpdatePhase::Error;
                s.error = Some(format!("GitHub ответил HTTP {status}."));
                s.checked_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            });
        }

        let body_bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => {
                let err = describe_reqwest_error(&e, &self.metadata_url);
                return self.update_state(|s| {
                    s.phase = LauncherUpdatePhase::Error;
                    s.error = Some(err.to_string());
                    s.checked_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                });
            }
        };

        let parsed: GitHubLatestRelease = match serde_json::from_slice(&body_bytes) {
            Ok(p) => p,
            Err(e) => {
                return self.update_state(|s| {
                    s.phase = LauncherUpdatePhase::Error;
                    s.error = Some(format!("Некорректный JSON релиза GitHub: {e}"));
                    s.checked_at = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                });
            }
        };

        let latest_ver = parsed.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
        let cur_st = self.get_state();
        let asset = select_launcher_asset(
            &parsed.assets,
            std::env::consts::OS,
            std::env::consts::ARCH,
            cur_st.install_mode,
        );
        let release_url = parsed
            .html_url
            .unwrap_or_else(|| LAUNCHER_RELEASES_PAGE_URL.to_string());
        let checked_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        if compare_semver(&latest_ver, &cur_st.current_version) != Ordering::Greater {
            return self.update_state(|s| {
                s.phase = LauncherUpdatePhase::UpToDate;
                s.latest_version = Some(latest_ver);
                s.release_name = parsed.name.or(Some(parsed.tag_name));
                s.release_notes = parsed.body;
                s.release_url = Some(release_url);
                s.published_at = parsed.published_at;
                s.asset = asset;
                s.downloaded_path = None;
                s.error = None;
                s.checked_at = Some(checked_at);
            });
        }

        let mut downloaded_path = None;
        if let Some(ref a) = asset {
            if let Ok(cand) = self.target_download_path(&latest_ver, &a.name) {
                if file_exists_valid(&cand, a.size, a.sha256.as_deref()).await {
                    downloaded_path = Some(cand.to_string_lossy().into_owned());
                }
            }
        }

        self.log.info(
            "updater",
            format!("Найдено обновление AbiLauncher: {} -> {latest_ver}", cur_st.current_version),
        );

        let asset_size = asset.as_ref().map(|a| a.size).unwrap_or(0);
        let has_dl = downloaded_path.is_some();
        self.update_state(|s| {
            s.phase = if has_dl {
                LauncherUpdatePhase::Downloaded
            } else {
                LauncherUpdatePhase::Available
            };
            s.latest_version = Some(latest_ver);
            s.release_name = parsed.name.or(Some(parsed.tag_name));
            s.release_notes = parsed.body;
            s.release_url = Some(release_url);
            s.published_at = parsed.published_at;
            s.asset = asset;
            s.downloaded_path = downloaded_path;
            s.progress_bytes_done = if has_dl { asset_size } else { 0 };
            s.progress_bytes_total = asset_size;
            s.progress_speed = 0;
            s.error = None;
            s.checked_at = Some(checked_at);
        })
    }

    fn target_download_path(&self, version: &str, asset_name: &str) -> AppResult<PathBuf> {
        let safe_ver: String = version
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let safe_file = sanitize_asset_filename(asset_name)?;
        Ok(self.user_data_dir.join("updates").join(safe_ver).join(safe_file))
    }

    pub async fn download_update(&self) -> AppResult<LauncherUpdateState> {
        let st = self.get_state();
        if st.phase == LauncherUpdatePhase::Downloading {
            return Ok(st);
        }
        let asset = st.asset.ok_or_else(|| {
            LauncherError::new(
                ErrorCode::DownloadFailed,
                "Файл обновления не найден",
                "В последнем релизе GitHub отсутствует установочный файл для вашей ОС.",
            )
        })?;
        let latest_version = st.latest_version.ok_or_else(|| {
            LauncherError::new(ErrorCode::DownloadFailed, "Версия неизвестна", "Проверьте обновления повторно.")
        })?;

        let dest = self.target_download_path(&latest_version, &asset.name)?;
        if file_exists_valid(&dest, asset.size, asset.sha256.as_deref()).await {
            return Ok(self.update_state(|s| {
                s.phase = LauncherUpdatePhase::Downloaded;
                s.downloaded_path = Some(dest.to_string_lossy().into_owned());
                s.progress_bytes_done = asset.size;
                s.progress_bytes_total = asset.size;
                s.progress_speed = 0;
                s.error = None;
            }));
        }

        let cancel = CancelToken::new();
        *self.active_cancel.lock().unwrap() = Some(cancel.clone());
        self.update_state(|s| {
            s.phase = LauncherUpdatePhase::Downloading;
            s.downloaded_path = None;
            s.progress_bytes_done = 0;
            s.progress_bytes_total = asset.size;
            s.progress_speed = 0;
            s.error = None;
        });

        let mut done: i64 = 0;
        let mut window_bytes: u64 = 0;
        let mut window_start = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut speed = 0u64;

        let urls = [asset.url.clone()];
        let res = download_verified(
            &self.http,
            &self.log,
            DownloadSpec {
                urls: &urls,
                dest: &dest,
                expected_size: Some(asset.size),
                expected_hash: asset
                    .sha256
                    .as_deref()
                    .map(|h| (ChecksumAlgo::Sha256, h)),
                policy: HostPolicy::PackAssetsOnly,
                attempts: 4,
            },
            &cancel,
            |delta| {
                done = (done + delta).max(0);
                if delta > 0 {
                    window_bytes += delta as u64;
                }
                let now = Instant::now();
                let elapsed = now.duration_since(window_start).as_millis() as u64;
                if elapsed >= 400 {
                    speed = window_bytes.saturating_mul(1000) / elapsed;
                    window_bytes = 0;
                    window_start = now;
                }
                if now.duration_since(last_emit).as_millis() >= 120 || done as u64 >= asset.size {
                    last_emit = now;
                    self.update_state(|s| {
                        s.progress_bytes_done = done as u64;
                        s.progress_bytes_total = asset.size;
                        s.progress_speed = speed;
                    });
                }
            },
        )
        .await;

        *self.active_cancel.lock().unwrap() = None;

        match res {
            Ok(()) => {
                self.log
                    .info("updater", format!("Обновление лаунчера скачано: {}", dest.display()));
                Ok(self.update_state(|s| {
                    s.phase = LauncherUpdatePhase::Downloaded;
                    s.downloaded_path = Some(dest.to_string_lossy().into_owned());
                    s.progress_bytes_done = asset.size;
                    s.progress_bytes_total = asset.size;
                    s.progress_speed = 0;
                    s.error = None;
                }))
            }
            Err(e) if e.is_cancelled() => Ok(self.update_state(|s| {
                s.phase = LauncherUpdatePhase::Available;
                s.progress_bytes_done = 0;
                s.progress_speed = 0;
                s.error = None;
            })),
            Err(e) => {
                let msg = e.to_string();
                Ok(self.update_state(|s| {
                    s.phase = LauncherUpdatePhase::Error;
                    s.error = Some(msg);
                    s.progress_speed = 0;
                }))
            }
        }
    }

    pub fn cancel_download(&self) {
        if let Some(ref c) = *self.active_cancel.lock().unwrap() {
            c.abort();
        }
    }

    pub async fn install_downloaded_update(&self) -> AppResult<()> {
        let st = self.get_state();
        let file_str = st.downloaded_path.ok_or_else(|| {
            LauncherError::new(
                ErrorCode::DownloadFailed,
                "Обновление не скачано",
                "Сначала скачайте обновление.",
            )
        })?;
        let asset = st.asset.ok_or_else(|| {
            LauncherError::new(ErrorCode::DownloadFailed, "Нет метаданных обновления", "")
        })?;
        let file = PathBuf::from(&file_str);
        if !file_exists_valid(&file, asset.size, asset.sha256.as_deref()).await {
            self.update_state(|s| {
                s.phase = LauncherUpdatePhase::Available;
                s.downloaded_path = None;
            });
            return Err(LauncherError::new(
                ErrorCode::Integrity,
                "Файл обновления повреждён",
                "Проверка размера или SHA-256 не прошла. Нажмите «Скачать обновление» ещё раз.",
            ));
        }

        if cfg!(not(windows)) {
            return Err(LauncherError::new(
                ErrorCode::Unknown,
                "Автоматическая установка недоступна",
                "На вашей ОС откройте страницу релиза и запустите скачанный файл вручную.",
            ));
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            match st.install_mode {
                InstallMode::Portable => {
                    let target_exe = self.current_exe.as_ref().ok_or_else(|| {
                        LauncherError::new(
                            ErrorCode::Unknown,
                            "Путь к текущему .exe неизвестен",
                            "Не удалось определить расположение запущенного файла.",
                        )
                    })?;
                    let updates_root = self.user_data_dir.join("updates");
                    ensure_dir(&updates_root).await?;
                    let script_path = updates_root.join("apply-portable-update.ps1");
                    let script = [
                        "param(",
                        "  [Parameter(Mandatory=$true)][int]$WaitPid,",
                        "  [Parameter(Mandatory=$true)][string]$SourceFile,",
                        "  [Parameter(Mandatory=$true)][string]$TargetFile",
                        ")",
                        "$deadline = (Get-Date).AddSeconds(25)",
                        "while ((Get-Date) -lt $deadline) {",
                        "  if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }",
                        "  Start-Sleep -Milliseconds 300",
                        "}",
                        "Start-Sleep -Milliseconds 400",
                        "$backup = \"$TargetFile.bak\"",
                        "for ($i = 0; $i -lt 20; $i++) {",
                        "  try {",
                        "    if (Test-Path -LiteralPath $TargetFile) {",
                        "      Move-Item -LiteralPath $TargetFile -Destination $backup -Force",
                        "    }",
                        "    Move-Item -LiteralPath $SourceFile -Destination $TargetFile -Force",
                        "    if (Test-Path -LiteralPath $backup) {",
                        "      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue",
                        "    }",
                        "    Start-Process -FilePath $TargetFile",
                        "    exit 0",
                        "  } catch {",
                        "    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $TargetFile)) {",
                        "      Move-Item -LiteralPath $backup -Destination $TargetFile -Force -ErrorAction SilentlyContinue",
                        "    }",
                        "    Start-Sleep -Milliseconds 500",
                        "  }",
                        "}",
                    ]
                    .join("\r\n");
                    tokio::fs::write(&script_path, script.as_bytes()).await?;

                    std::process::Command::new("powershell.exe")
                        .args([
                            "-NoProfile",
                            "-ExecutionPolicy",
                            "Bypass",
                            "-WindowStyle",
                            "Hidden",
                            "-File",
                        ])
                        .arg(&script_path)
                        .arg("-WaitPid")
                        .arg(std::process::id().to_string())
                        .arg("-SourceFile")
                        .arg(&file)
                        .arg("-TargetFile")
                        .arg(target_exe)
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn()
                        .map_err(|e| {
                            LauncherError::new(
                                ErrorCode::Unknown,
                                "Не удалось запустить обновление",
                                e.to_string(),
                            )
                        })?;
                    (self.on_quit)();
                    Ok(())
                }
                InstallMode::Installer => {
                    std::process::Command::new(&file).spawn().map_err(|e| {
                        LauncherError::new(
                            ErrorCode::Unknown,
                            "Не удалось запустить установщик",
                            e.to_string(),
                        )
                    })?;
                    (self.on_quit)();
                    Ok(())
                }
                InstallMode::Manual => Err(LauncherError::new(
                    ErrorCode::Unknown,
                    "Режим разработки",
                    "В режиме разработки автоустановка отключена — обновитесь из релиза GitHub.",
                )),
            }
        }
        #[cfg(not(windows))]
        Ok(())
    }
}
