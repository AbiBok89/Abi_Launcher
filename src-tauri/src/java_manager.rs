use crate::archive::{extract_archive_safe, ArchiveFormat};
use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{abs_lexical, ensure_dir, remove_quiet, rename_with_retry};
use crate::http::{
    download_verified, fetch_text, hash_file, is_allowed_url, ChecksumAlgo, DownloadSpec,
    HostPolicy,
};
use crate::log::AppLogger;
use crate::types::{JavaInfoView, Stage};
use regex::Regex;
use reqwest::Client;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct RuntimeProgressUpdate {
    pub stage: Stage,
    pub label: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub speed: u64,
}

const MOJANG_JAVA_ALL_URL: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

fn java_exe_name() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

pub fn required_java_major(
    minecraft_version: &str,
    manifest_java_major: Option<u32>,
    resolved_java_major: Option<u32>,
) -> u32 {
    if let Some(m) = manifest_java_major.filter(|&v| v >= 8) {
        return m;
    }
    if let Some(r) = resolved_java_major.filter(|&v| v >= 8) {
        return r;
    }
    let re = Regex::new(r"^1\.(\d+)(?:\.(\d+))?").unwrap();
    let Some(caps) = re.captures(minecraft_version.trim()) else {
        return 21;
    };
    let minor: u32 = caps[1].parse().unwrap_or(21);
    let patch: u32 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    if minor <= 16 {
        8
    } else if minor < 20 || (minor == 20 && patch <= 4) {
        17
    } else {
        21
    }
}

pub fn managed_runtime_dir(install_dir: &Path, major: u32) -> PathBuf {
    let plat = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "ia32"
    };
    install_dir
        .join("runtimes")
        .join(format!("java-{major}-{plat}-{arch}"))
}

pub fn managed_java_executable(runtime_dir: &Path) -> PathBuf {
    runtime_dir.join("bin").join(java_exe_name())
}

fn parse_major_version(ver: &str) -> Option<u32> {
    if ver.starts_with("1.8") {
        return Some(8);
    }
    let re = Regex::new(r"^(\d+)").unwrap();
    re.captures(ver.trim())
        .and_then(|c| c[1].parse::<u32>().ok())
}

pub async fn probe_java_executable(java_path: &Path) -> AppResult<JavaInfoView> {
    let abs = abs_lexical(java_path);
    if !tokio::fs::try_exists(&abs).await.unwrap_or(false) {
        return Err(
            LauncherError::new(
                ErrorCode::Java,
                "Файл Java не найден",
                format!("Исполняемый файл «{}» не существует.", abs.display()),
            )
            .with_hint("Выберите правильный файл java.exe / java или переключитесь на автоматическую Java."),
        );
    }

    let mut cmd = Command::new(&abs);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let out = cmd.output().await.map_err(|e| {
        LauncherError::new(
            ErrorCode::Java,
            "Не удалось проверить Java",
            format!("Ошибка запуска «{}»: {e}", abs.display()),
        )
    })?;

    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    let ver_re = Regex::new(r#"version\s+"([^"]+)""#).unwrap();
    let Some(caps) = ver_re.captures(&text) else {
        return Err(
            LauncherError::new(
                ErrorCode::Java,
                "Не удалось проверить Java",
                format!("Файл «{}» не вернул версию Java.", abs.display()),
            )
            .with_hint("Выберите корректный исполняемый файл Java или включите автоматическую установку."),
        );
    };
    let version = caps[1].to_string();
    let major = parse_major_version(&version).ok_or_else(|| {
        LauncherError::new(
            ErrorCode::Java,
            "Неизвестная версия Java",
            format!("Строка версии: {version}"),
        )
    })?;

    Ok(JavaInfoView {
        path: abs.to_string_lossy().into_owned(),
        version,
        major_version: major,
        managed: false,
    })
}

async fn list_managed_executables(install_dir: &Path) -> Vec<PathBuf> {
    let runtimes_root = install_dir.join("runtimes");
    let Ok(mut rd) = tokio::fs::read_dir(&runtimes_root).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        if let Ok(ft) = entry.file_type().await {
            if ft.is_dir() {
                let exe = managed_java_executable(&entry.path());
                if tokio::fs::try_exists(&exe).await.unwrap_or(false) {
                    out.push(exe);
                }
            }
        }
    }
    out
}

fn collect_system_java_candidates() -> Vec<PathBuf> {
    let mut cands = Vec::new();
    let exe_name = java_exe_name();

    if let Ok(jh) = std::env::var("JAVA_HOME") {
        if !jh.trim().is_empty() {
            cands.push(PathBuf::from(jh.trim()).join("bin").join(exe_name));
        }
    }

    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let p = dir.join(exe_name);
            if p.is_file() {
                cands.push(p);
            }
        }
    }

    #[cfg(windows)]
    {
        for env_key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(env_key) {
                for vendor in [
                    "Eclipse Adoptium",
                    "AdoptOpenJDK",
                    "Java",
                    "Zulu",
                    "BellSoft",
                    "Microsoft",
                    "Semeru",
                ] {
                    let root = PathBuf::from(&base).join(vendor);
                    if let Ok(rd) = std::fs::read_dir(&root) {
                        for e in rd.flatten() {
                            let exe = e.path().join("bin").join(exe_name);
                            if exe.is_file() {
                                cands.push(exe);
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        for root in ["/usr/lib/jvm", "/usr/java", "/opt/java"] {
            if let Ok(rd) = std::fs::read_dir(root) {
                for e in rd.flatten() {
                    let exe = e.path().join("bin").join(exe_name);
                    if exe.is_file() {
                        cands.push(exe);
                    }
                }
            }
        }
    }

    cands
}

pub async fn discover_java_installations(install_dir: &Path) -> Vec<JavaInfoView> {
    let managed = list_managed_executables(install_dir).await;
    let system = collect_system_java_candidates();
    let runtimes_root = abs_lexical(&install_dir.join("runtimes"));

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for p in managed.into_iter().chain(system) {
        let abs = abs_lexical(&p);
        let key = if cfg!(windows) {
            abs.to_string_lossy().to_lowercase()
        } else {
            abs.to_string_lossy().into_owned()
        };
        if seen.insert(key) {
            candidates.push(abs);
        }
    }

    let mut out = Vec::new();
    for path in candidates {
        if let Ok(mut info) = probe_java_executable(&path).await {
            let p_abs = abs_lexical(Path::new(&info.path));
            info.managed = p_abs.starts_with(&runtimes_root);
            out.push(info);
        }
    }
    out.sort_by(|a, b| {
        b.managed
            .cmp(&a.managed)
            .then_with(|| b.major_version.cmp(&a.major_version))
    });
    out
}

fn mojang_platform_key() -> Option<&'static str> {
    if cfg!(windows) {
        if cfg!(target_arch = "x86_64") {
            Some("windows-x64")
        } else if cfg!(target_arch = "aarch64") {
            Some("windows-arm64")
        } else {
            Some("windows-x86")
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "x86_64") {
            Some("linux")
        } else {
            Some("linux-i386")
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            Some("mac-os-arm64")
        } else {
            Some("mac-os")
        }
    } else {
        None
    }
}

fn mojang_target_candidates(major: u32) -> &'static [&'static str] {
    if major >= 21 {
        &["java-runtime-delta"]
    } else if major == 17 {
        &[
            "java-runtime-gamma",
            "java-runtime-gamma-snapshot",
            "java-runtime-beta",
        ]
    } else if major == 16 {
        &["java-runtime-alpha"]
    } else if major == 8 {
        &["jre-legacy"]
    } else {
        &[]
    }
}

#[derive(Deserialize)]
struct MojangRuntimeEntry {
    manifest: MojangRuntimeManifestRef,
    version: MojangRuntimeVersion,
}

#[derive(Deserialize)]
struct MojangRuntimeManifestRef {
    url: String,
    #[allow(dead_code)]
    sha1: String,
}

#[derive(Deserialize)]
struct MojangRuntimeVersion {
    name: String,
}

#[derive(Deserialize)]
struct MojangFilesManifest {
    files: HashMap<String, MojangRuntimeFile>,
}

#[derive(Deserialize)]
struct MojangRuntimeFile {
    #[serde(rename = "type")]
    file_type: String,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    downloads: Option<MojangRuntimeDownloads>,
}

#[derive(Deserialize)]
struct MojangRuntimeDownloads {
    #[serde(default)]
    raw: Option<MojangRawDownload>,
}

#[derive(Deserialize)]
struct MojangRawDownload {
    sha1: String,
    size: u64,
    url: String,
}

async fn try_install_mojang_java<F>(
    client: &Client,
    log: &AppLogger,
    major: u32,
    dest_dir: &Path,
    cancel: &CancelToken,
    on_progress: &F,
) -> AppResult<bool>
where
    F: Fn(RuntimeProgressUpdate) + Send + Sync + 'static,
{
    let Some(plat_key) = mojang_platform_key() else {
        return Ok(false);
    };
    let candidates = mojang_target_candidates(major);
    if candidates.is_empty() {
        return Ok(false);
    }

    let raw = match fetch_text(
        client,
        MOJANG_JAVA_ALL_URL,
        HostPolicy::AnyHttps,
        4 * 1024 * 1024,
        Duration::from_secs(20),
        None,
        cancel,
    )
    .await
    {
        Ok(t) => t,
        Err(e) if e.is_cancelled() => return Err(e),
        Err(e) => {
            log.warn("java", format!("Не удалось получить индекс Java от Mojang: {e}"));
            return Ok(false);
        }
    };

    let all: HashMap<String, HashMap<String, Vec<MojangRuntimeEntry>>> =
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(false),
        };
    let Some(plat_map) = all.get(plat_key) else {
        return Ok(false);
    };

    let mut chosen: Option<&MojangRuntimeEntry> = None;
    for target in candidates {
        if let Some(list) = plat_map.get(*target) {
            if let Some(first) = list.first() {
                if parse_major_version(&first.version.name) == Some(major) {
                    chosen = Some(first);
                    break;
                }
            }
        }
    }
    let Some(target) = chosen else {
        return Ok(false);
    };

    on_progress(RuntimeProgressUpdate {
        stage: Stage::Java,
        label: format!("Загрузка официальной Java {major} ({})", target.version.name),
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0,
    });

    let mf_raw = match fetch_text(
        client,
        &target.manifest.url,
        HostPolicy::AnyHttps,
        16 * 1024 * 1024,
        Duration::from_secs(25),
        None,
        cancel,
    )
    .await
    {
        Ok(t) => t,
        Err(e) if e.is_cancelled() => return Err(e),
        Err(e) => {
            log.warn("java", format!("Не удалось загрузить манифест Mojang Java: {e}"));
            return Ok(false);
        }
    };

    let manifest: MojangFilesManifest = match serde_json::from_str(&mf_raw) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };

    ensure_dir(dest_dir).await?;
    let mut download_items = Vec::new();
    for (rel, item) in manifest.files {
        if rel.contains("..") || rel.starts_with('/') || rel.contains('\\') {
            continue;
        }
        let mut target_path = dest_dir.to_path_buf();
        for seg in rel.split('/') {
            target_path.push(seg);
        }
        if item.file_type == "directory" {
            ensure_dir(&target_path).await?;
        } else if item.file_type == "file" {
            if let Some(raw_dl) = item.downloads.and_then(|d| d.raw) {
                download_items.push((target_path, raw_dl, item.executable));
            }
        }
    }

    let total_bytes: u64 = download_items.iter().map(|(_, d, _)| d.size).sum();
    let total_files = download_items.len();
    let bytes_done = Arc::new(Mutex::new(0u64));
    let files_done = Arc::new(Mutex::new(0usize));
    let queue = Arc::new(Mutex::new(download_items));

    let mut set = tokio::task::JoinSet::new();
    let workers = 6usize.min(total_files.max(1));
    let label_str = format!("Установка Java {major}");

    for _ in 0..workers {
        let q = queue.clone();
        let c = client.clone();
        let l = log.clone();
        let tok = cancel.clone();
        let bd = bytes_done.clone();
        let fd = files_done.clone();
        let lbl = label_str.clone();
        set.spawn(async move {
            loop {
                tok.check()?;
                let item = { q.lock().unwrap().pop() };
                let Some((dest, dl, executable)) = item else {
                    return Ok::<(), LauncherError>(());
                };
                if let Ok(meta) = tokio::fs::metadata(&dest).await {
                    if meta.is_file() && meta.len() == dl.size {
                        if let Ok(h) = hash_file(&dest, ChecksumAlgo::Sha1, &tok).await {
                            if h.eq_ignore_ascii_case(&dl.sha1) {
                                *bd.lock().unwrap() += dl.size;
                                *fd.lock().unwrap() += 1;
                                continue;
                            }
                        }
                    }
                }
                let urls = [dl.url];
                download_verified(
                    &c,
                    &l,
                    DownloadSpec {
                        urls: &urls,
                        dest: &dest,
                        expected_size: Some(dl.size),
                        expected_hash: Some((ChecksumAlgo::Sha1, &dl.sha1)),
                        policy: HostPolicy::AnyHttps,
                        attempts: 3,
                    },
                    &tok,
                    |delta| {
                        let mut g = bd.lock().unwrap();
                        if delta >= 0 {
                            *g += delta as u64;
                        } else {
                            *g = g.saturating_sub((-delta) as u64);
                        }
                    },
                )
                .await?;
                #[cfg(unix)]
                if executable {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = tokio::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).await;
                }
                let _ = executable;
                *fd.lock().unwrap() += 1;
                let _ = (&lbl, total_bytes, total_files);
            }
        });
    }

    // Периодическое обновление прогресса в UI
    let prog_cancel = cancel.clone();
    loop {
        tokio::select! {
            _ = prog_cancel.cancelled() => {
                set.abort_all();
                return Err(LauncherError::cancelled());
            }
            joined = set.join_next() => match joined {
                None => break,
                Some(res) => {
                    res.map_err(|e| LauncherError::new(ErrorCode::Java, "Ошибка установки Java", e.to_string()))??;
                    on_progress(RuntimeProgressUpdate {
                        stage: Stage::Java,
                        label: label_str.clone(),
                        bytes_done: *bytes_done.lock().unwrap(),
                        bytes_total: total_bytes,
                        files_done: *files_done.lock().unwrap(),
                        files_total: total_files,
                        speed: 0,
                    });
                }
            }
        }
    }

    Ok(true)
}

#[derive(Deserialize)]
struct AdoptiumAsset {
    #[serde(default)]
    binary: Option<AdoptiumBinary>,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    #[serde(default)]
    package: Option<AdoptiumPackage>,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    #[serde(default)]
    checksum: Option<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

fn adoptium_os_arch() -> (&'static str, &'static str) {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "x64"
    };
    (os, arch)
}

async fn install_adoptium_java<F>(
    client: &Client,
    log: &AppLogger,
    major: u32,
    dest_dir: &Path,
    cancel: &CancelToken,
    on_progress: &F,
) -> AppResult<()>
where
    F: Fn(RuntimeProgressUpdate) + Send + Sync + 'static,
{
    let (os, arch) = adoptium_os_arch();
    let api_url = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse"
    );

    on_progress(RuntimeProgressUpdate {
        stage: Stage::Java,
        label: format!("Поиск Eclipse Temurin Java {major} ({os}/{arch})"),
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0,
    });

    let text = fetch_text(
        client,
        &api_url,
        HostPolicy::AnyHttps,
        2 * 1024 * 1024,
        Duration::from_secs(20),
        None,
        cancel,
    )
    .await
    .map_err(|e| {
        if e.is_cancelled() {
            e
        } else {
            LauncherError::new(
                ErrorCode::Java,
                format!("Не удалось скачать Java {major}"),
                format!("Не удалось получить ссылку на Java {major} для {os}/{arch}."),
            )
            .with_hint("Проверьте интернет-соединение или установите Java вручную и укажите путь в настройках.")
        }
    })?;

    let releases: Vec<AdoptiumAsset> = serde_json::from_str(&text).unwrap_or_default();
    let pkg = releases
        .into_iter()
        .next()
        .and_then(|r| r.binary)
        .and_then(|b| b.package)
        .ok_or_else(|| {
            LauncherError::new(
                ErrorCode::Java,
                format!("Java {major} не найдена"),
                format!("Для платформы {os}/{arch} не найден готовый пакет Java {major}."),
            )
            .with_hint("Установите Java вручную и укажите путь к ней в настройках.")
        })?;

    let (Some(link), Some(checksum), Some(size)) = (pkg.link, pkg.checksum, pkg.size) else {
        return Err(LauncherError::new(
            ErrorCode::Java,
            format!("Java {major} не найдена"),
            "Неполные метаданные Adoptium.",
        ));
    };

    if !is_allowed_java_url(&link) {
        return Err(LauncherError::new(
            ErrorCode::Java,
            "Неразрешённый адрес Java",
            link,
        ));
    }

    let is_zip = link.ends_with(".zip") || pkg.name.as_deref().is_some_and(|n| n.ends_with(".zip"));
    let ext = if is_zip { "zip" } else { "tar.gz" };
    let archive_tmp = dest_dir
        .parent()
        .unwrap_or(dest_dir)
        .join(format!(".download-java-{major}.{ext}"));

    let mut downloaded: i64 = 0;
    let urls = [link];
    download_verified(
        client,
        log,
        DownloadSpec {
            urls: &urls,
            dest: &archive_tmp,
            expected_size: Some(size),
            expected_hash: Some((ChecksumAlgo::Sha256, &checksum.to_lowercase())),
            policy: HostPolicy::AnyHttps,
            attempts: 4,
        },
        cancel,
        |delta| {
            downloaded = (downloaded + delta).max(0);
            on_progress(RuntimeProgressUpdate {
                stage: Stage::Java,
                label: format!("Загрузка Java {major} (Adoptium Temurin)"),
                bytes_done: downloaded as u64,
                bytes_total: size,
                files_done: 0,
                files_total: 1,
                speed: 0,
            });
        },
    )
    .await?;

    on_progress(RuntimeProgressUpdate {
        stage: Stage::Java,
        label: format!("Распаковка Java {major}"),
        bytes_done: size,
        bytes_total: size,
        files_done: 0,
        files_total: 1,
        speed: 0,
    });

    remove_quiet(dest_dir).await;
    ensure_dir(dest_dir).await?;
    let fmt = if is_zip {
        ArchiveFormat::Zip
    } else {
        ArchiveFormat::TarGz
    };
    extract_archive_safe(&archive_tmp, dest_dir, fmt, 1, cancel).await?;
    remove_quiet(&archive_tmp).await;
    Ok(())
}

fn is_allowed_java_url(url: &str) -> bool {
    if is_allowed_url(url) {
        return true;
    }
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    if u.scheme() != "https" {
        return false;
    }
    let Some(h) = u.host_str() else {
        return false;
    };
    matches!(
        h.to_ascii_lowercase().as_str(),
        "api.adoptium.net" | "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com"
    )
}

pub async fn ensure_java_runtime<F>(
    client: &Client,
    log: &AppLogger,
    major: u32,
    install_dir: &Path,
    custom_java_path: Option<&str>,
    cancel: &CancelToken,
    on_progress: F,
) -> AppResult<JavaInfoView>
where
    F: Fn(RuntimeProgressUpdate) + Send + Sync + 'static,
{
    cancel.check()?;
    if let Some(custom) = custom_java_path.map(str::trim).filter(|s| !s.is_empty()) {
        let info = probe_java_executable(Path::new(custom)).await?;
        if info.major_version != major {
            return Err(
                LauncherError::new(
                    ErrorCode::Java,
                    "Несовместимая версия Java",
                    format!(
                        "Выбрана Java {} ({}), а для этой сборки требуется Java {major}.",
                        info.major_version, info.version
                    ),
                )
                .with_hint("Сбросьте выбор Java на «Автоматически» или выберите совместимую Java в настройках."),
            );
        }
        return Ok(info);
    }

    let target_dir = managed_runtime_dir(install_dir, major);
    let exe = managed_java_executable(&target_dir);
    if tokio::fs::try_exists(&exe).await.unwrap_or(false) {
        if let Ok(mut info) = probe_java_executable(&exe).await {
            if info.major_version == major {
                info.managed = true;
                return Ok(info);
            }
        }
    }

    for cand in list_managed_executables(install_dir).await {
        if let Ok(mut info) = probe_java_executable(&cand).await {
            if info.major_version == major {
                info.managed = true;
                return Ok(info);
            }
        }
    }

    log.info(
        "java",
        format!("Автоматическая установка Java {major} в {}", target_dir.display()),
    );
    let staging = PathBuf::from(format!("{}.installing", target_dir.display()));
    remove_quiet(&staging).await;

    let res: AppResult<JavaInfoView> = async {
        let ok_mojang =
            try_install_mojang_java(client, log, major, &staging, cancel, &on_progress).await?;
        if !ok_mojang {
            remove_quiet(&staging).await;
            install_adoptium_java(client, log, major, &staging, cancel, &on_progress).await?;
        }
        let mut check_exe = managed_java_executable(&staging);
        if !tokio::fs::try_exists(&check_exe).await.unwrap_or(false) {
            let mac_exe = staging
                .join("Contents")
                .join("Home")
                .join("bin")
                .join(java_exe_name());
            if tokio::fs::try_exists(&mac_exe).await.unwrap_or(false) {
                check_exe = mac_exe;
            }
        }
        let _ = probe_java_executable(&check_exe).await?;
        remove_quiet(&target_dir).await;
        rename_with_retry(&staging, &target_dir).await?;
        let final_exe = managed_java_executable(&target_dir);
        let mut info = probe_java_executable(&final_exe).await?;
        info.managed = true;
        Ok(info)
    }
    .await;

    if res.is_err() {
        remove_quiet(&staging).await;
    }
    res
}
