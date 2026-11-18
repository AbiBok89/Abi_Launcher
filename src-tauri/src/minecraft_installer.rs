use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{ensure_dir, read_json_file, write_json_atomic};
use crate::http::{
    download_verified, fetch_text, hash_file, ChecksumAlgo, DownloadSpec, HostPolicy,
};
use crate::java_manager::{
    ensure_java_runtime, probe_java_executable, required_java_major, RuntimeProgressUpdate,
};
use crate::log::AppLogger;
use crate::mc_version::{
    library_path, parse_version, version_jar_path, version_json_path, LibraryInfo, RawLibrary,
    RawVersionJson, ResolvedLibrary, ResolvedVersion,
};
use crate::paths::LAUNCHER_META_DIR;
use crate::types::{JavaInfoView, Loader, ManifestJson, Stage};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;
use zip::ZipArchive;

pub type ProgressCallback = Arc<dyn Fn(RuntimeProgressUpdate) + Send + Sync>;

const MOJANG_VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const MOJANG_RESOURCES_BASE: &str = "https://resources.download.minecraft.net";
const FABRIC_META_BASE: &str = "https://meta.fabricmc.net/v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMarker {
    pub schema_version: u32,
    pub version_id: String,
    pub minecraft: String,
    pub loader: Loader,
    pub java_major: u32,
    pub java_path: String,
}

#[derive(Debug, Clone)]
pub struct PreparedRuntime {
    pub resolved: ResolvedVersion,
    pub java: JavaInfoView,
    pub shared_dir: PathBuf,
    pub version_id: String,
}

#[derive(Debug, Deserialize)]
struct VersionManifestV2 {
    versions: Vec<VersionManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct VersionManifestEntry {
    id: String,
    url: String,
    #[serde(default)]
    sha1: String,
}

#[derive(Debug, Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct AssetIndexJson {
    objects: HashMap<String, AssetObject>,
}

#[derive(Debug, Deserialize)]
struct InstallProfileDataEntry {
    #[serde(default)]
    client: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallProfileProcessor {
    jar: String,
    #[serde(default)]
    classpath: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    outputs: Option<HashMap<String, String>>,
    #[serde(default)]
    sides: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct ModernInstallProfile {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    minecraft: Option<String>,
    #[serde(default)]
    json: Option<String>,
    #[serde(default)]
    data: HashMap<String, InstallProfileDataEntry>,
    #[serde(default)]
    libraries: Vec<RawLibrary>,
    #[serde(default)]
    processors: Vec<InstallProfileProcessor>,
}

#[derive(Debug, Deserialize)]
struct LegacyInstallMeta {
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "filePath")]
    file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LegacyInstallProfile {
    install: LegacyInstallMeta,
    #[serde(rename = "versionInfo")]
    version_info: Value,
}

pub fn shared_minecraft_dir(install_dir: &Path) -> PathBuf {
    install_dir.join("shared")
}

pub fn runtime_marker_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join(LAUNCHER_META_DIR).join("runtime.json")
}

fn emit(
    cb: &ProgressCallback,
    stage: Stage,
    label: impl Into<String>,
    bytes_done: u64,
    bytes_total: u64,
    files_done: usize,
    files_total: usize,
    speed: u64,
) {
    cb(RuntimeProgressUpdate {
        stage,
        label: label.into(),
        bytes_done,
        bytes_total,
        files_done,
        files_total,
        speed,
    });
}

fn maven_fallback_urls(rel_path: &str, primary: Option<&str>, extra_bases: &[&str]) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(p) = primary {
        let trimmed = p.trim();
        if !trimmed.is_empty() && trimmed.starts_with("https://") {
            urls.push(trimmed.to_string());
        }
    }
    let clean = rel_path.trim_start_matches('/');
    for base in extra_bases {
        let u = format!("{}/{clean}", base.trim_end_matches('/'));
        if !urls.contains(&u) {
            urls.push(u);
        }
    }
    for base in [
        "https://libraries.minecraft.net",
        "https://maven.minecraftforge.net",
        "https://maven.neoforged.net/releases",
        "https://repo1.maven.org/maven2",
    ] {
        let u = format!("{base}/{clean}");
        if !urls.contains(&u) {
            urls.push(u);
        }
    }
    urls
}

async fn verify_file_matches(
    path: &Path,
    expected_sha1: &str,
    expected_size: Option<u64>,
    check_sha1: bool,
    cancel: &CancelToken,
) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if let Some(sz) = expected_size {
        if sz > 0 && meta.len() != sz {
            return false;
        }
    } else if meta.len() == 0 {
        return false;
    }
    if check_sha1 && !expected_sha1.is_empty() {
        if let Ok(actual) = hash_file(path, ChecksumAlgo::Sha1, cancel).await {
            return actual.eq_ignore_ascii_case(expected_sha1);
        }
        return false;
    }
    true
}

#[derive(Clone)]
struct DownloadTaskItem {
    urls: Vec<String>,
    dest: PathBuf,
    expected_size: Option<u64>,
    expected_sha1: String,
}

async fn download_items_parallel(
    client: &Client,
    log: &AppLogger,
    items: Vec<DownloadTaskItem>,
    stage: Stage,
    label: &str,
    concurrency: usize,
    cancel: &CancelToken,
    on_progress: &ProgressCallback,
) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let total_files = items.len();
    let total_bytes: u64 = items
        .iter()
        .map(|i| i.expected_size.unwrap_or(0))
        .sum();
    let files_done = Arc::new(AtomicUsize::new(0));
    let bytes_done = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_millis(200)));
    let queue = Arc::new(Mutex::new(items.into_iter()));
    let label_owned = label.to_string();

    emit(on_progress, stage, &label_owned, 0, total_bytes, 0, total_files, 0);

    let workers = concurrency.clamp(1, total_files);
    let mut handles = Vec::with_capacity(workers);

    for _ in 0..workers {
        let client = client.clone();
        let log = log.clone();
        let queue = Arc::clone(&queue);
        let cancel = cancel.clone();
        let files_done = Arc::clone(&files_done);
        let bytes_done = Arc::clone(&bytes_done);
        let last_emit = Arc::clone(&last_emit);
        let on_progress = Arc::clone(on_progress);
        let label = label_owned.clone();

        handles.push(tokio::spawn(async move {
            loop {
                cancel.check()?;
                let next = {
                    let mut q = queue.lock().await;
                    q.next()
                };
                let Some(item) = next else {
                    break;
                };
                let sha_ref = if item.expected_sha1.is_empty() {
                    None
                } else {
                    Some((ChecksumAlgo::Sha1, item.expected_sha1.as_str()))
                };

                let bytes_done_c = Arc::clone(&bytes_done);
                let files_done_c = Arc::clone(&files_done);
                let last_emit_c = Arc::clone(&last_emit);
                let on_progress_c = Arc::clone(&on_progress);
                let label_c = label.clone();

                let mut item_bytes: u64 = 0;
                download_verified(
                    &client,
                    &log,
                    DownloadSpec {
                        urls: &item.urls,
                        dest: &item.dest,
                        expected_size: item.expected_size,
                        expected_hash: sha_ref,
                        policy: HostPolicy::AnyHttps,
                        attempts: item.urls.len().max(3),
                    },
                    &cancel,
                    |delta| {
                        let prev = if delta >= 0 {
                            bytes_done_c.fetch_add(delta as u64, Ordering::Relaxed) + delta as u64
                        } else {
                            let sub = (-delta) as u64;
                            bytes_done_c.fetch_sub(sub.min(bytes_done_c.load(Ordering::Relaxed)), Ordering::Relaxed);
                            bytes_done_c.load(Ordering::Relaxed)
                        };
                        if delta >= 0 {
                            item_bytes = item_bytes.saturating_add(delta as u64);
                        }
                        if total_bytes > 0 {
                            if let Ok(mut le) = last_emit_c.try_lock() {
                                if le.elapsed() >= Duration::from_millis(90) {
                                    *le = Instant::now();
                                    let elapsed = started.elapsed().as_secs_f64().max(0.2);
                                    let spd = (prev as f64 / elapsed) as u64;
                                    emit(
                                        &on_progress_c,
                                        stage,
                                        &label_c,
                                        prev,
                                        total_bytes,
                                        files_done_c.load(Ordering::Relaxed),
                                        total_files,
                                        spd,
                                    );
                                }
                            }
                        }
                    },
                )
                .await?;

                let done_cnt = files_done.fetch_add(1, Ordering::Relaxed) + 1;
                let done_b = bytes_done.load(Ordering::Relaxed);
                let mut le = last_emit.lock().await;
                if done_cnt == total_files || le.elapsed() >= Duration::from_millis(75) {
                    *le = Instant::now();
                    let elapsed = started.elapsed().as_secs_f64().max(0.2);
                    let spd = (done_b as f64 / elapsed) as u64;
                    emit(
                        &on_progress,
                        stage,
                        &label,
                        done_b,
                        total_bytes,
                        done_cnt,
                        total_files,
                        spd,
                    );
                }
            }
            AppResult::Ok(())
        }));
    }

    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(e) => {
                return Err(LauncherError::new(
                    ErrorCode::MinecraftInstall,
                    "Сбой загрузки файлов Minecraft",
                    e.to_string(),
                ));
            }
        }
    }
    Ok(())
}

async fn ensure_vanilla_version_json(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    mc_ver: &str,
    cancel: &CancelToken,
) -> AppResult<()> {
    let dest = version_json_path(shared_dir, mc_ver);
    if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
        if let Ok(bytes) = tokio::fs::read(&dest).await {
            if serde_json::from_slice::<RawVersionJson>(&bytes).is_ok() {
                return Ok(());
            }
        }
    }

    let manifest_raw = fetch_text(
        client,
        MOJANG_VERSION_MANIFEST_URL,
        HostPolicy::AnyHttps,
        16 * 1024 * 1024,
        Duration::from_secs(20),
        None,
        cancel,
    )
    .await?;

    let manifest: VersionManifestV2 = serde_json::from_str(&manifest_raw).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Ошибка списка версий Minecraft",
            e.to_string(),
        )
    })?;

    let entry = manifest
        .versions
        .into_iter()
        .find(|v| v.id == mc_ver)
        .ok_or_else(|| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Версия Minecraft не найдена",
                format!("Версия Minecraft {mc_ver} отсутствует в официальном манифесте Mojang."),
            )
        })?;

    let sha = if entry.sha1.is_empty() {
        None
    } else {
        Some((ChecksumAlgo::Sha1, entry.sha1.as_str()))
    };
    let urls = vec![entry.url];
    download_verified(
        client,
        log,
        DownloadSpec {
            urls: &urls,
            dest: &dest,
            expected_size: None,
            expected_hash: sha,
            policy: HostPolicy::AnyHttps,
            attempts: 3,
        },
        cancel,
        |_| {},
    )
    .await
}

async fn ensure_libraries_list(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    libs: &[ResolvedLibrary],
    extra_mavens: &[&str],
    check_sha1: bool,
    stage: Stage,
    label: &str,
    cancel: &CancelToken,
    on_progress: &ProgressCallback,
) -> AppResult<()> {
    let mut missing = Vec::new();
    let mut seen_paths = HashSet::new();

    for lib in libs {
        if lib.download.path.is_empty() || !seen_paths.insert(lib.download.path.clone()) {
            continue;
        }
        let dest = library_path(shared_dir, &lib.download.path);
        let exp_size = if lib.download.size > 0 {
            Some(lib.download.size as u64)
        } else {
            None
        };
        if verify_file_matches(&dest, &lib.download.sha1, exp_size, check_sha1, cancel).await {
            continue;
        }
        let primary = if lib.download.url.trim().is_empty() {
            None
        } else {
            Some(lib.download.url.as_str())
        };
        let urls = maven_fallback_urls(&lib.download.path, primary, extra_mavens);
        missing.push(DownloadTaskItem {
            urls,
            dest,
            expected_size: exp_size,
            expected_sha1: lib.download.sha1.clone(),
        });
    }

    if !missing.is_empty() {
        log.info(
            "minecraft",
            format!("Загрузка библиотек ({label}): {} шт.", missing.len()),
        );
        download_items_parallel(client, log, missing, stage, label, 6, cancel, on_progress).await?;
    }
    Ok(())
}

async fn install_vanilla_assets_and_client(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    mc_ver: &str,
    check_hashes: bool,
    cancel: &CancelToken,
    on_progress: &ProgressCallback,
) -> AppResult<ResolvedVersion> {
    emit(
        on_progress,
        Stage::Minecraft,
        format!("Установка Minecraft {mc_ver}"),
        0,
        0,
        0,
        0,
        0,
    );
    ensure_vanilla_version_json(client, log, shared_dir, mc_ver, cancel).await?;
    let resolved = parse_version(shared_dir, mc_ver).await?;

    // client.jar
    if let Some(client_dl) = resolved.downloads.get("client") {
        let jar = version_jar_path(shared_dir, &resolved.minecraft_version);
        let exp_sz = if client_dl.size > 0 {
            Some(client_dl.size as u64)
        } else {
            None
        };
        if !verify_file_matches(&jar, &client_dl.sha1, exp_sz, check_hashes, cancel).await {
            emit(
                on_progress,
                Stage::Minecraft,
                format!("Загрузка клиента Minecraft {mc_ver}"),
                0,
                client_dl.size.max(0) as u64,
                0,
                1,
                0,
            );
            let urls = vec![client_dl.url.clone()];
            let sha = if client_dl.sha1.is_empty() {
                None
            } else {
                Some((ChecksumAlgo::Sha1, client_dl.sha1.as_str()))
            };
            let on_p = Arc::clone(on_progress);
            let total_sz = client_dl.size.max(0) as u64;
            let done_acc = Arc::new(AtomicU64::new(0));
            let label = format!("Загрузка клиента Minecraft {mc_ver}");
            download_verified(
                client,
                log,
                DownloadSpec {
                    urls: &urls,
                    dest: &jar,
                    expected_size: exp_sz,
                    expected_hash: sha,
                    policy: HostPolicy::AnyHttps,
                    attempts: 3,
                },
                cancel,
                move |d| {
                    let cur = if d >= 0 {
                        done_acc.fetch_add(d as u64, Ordering::Relaxed) + d as u64
                    } else {
                        done_acc.load(Ordering::Relaxed)
                    };
                    emit(&on_p, Stage::Minecraft, &label, cur, total_sz, 0, 1, 0);
                },
            )
            .await?;
        }
    }

    // Logging XML
    if let Some(ref log_cfg) = resolved.logging {
        let xml_path = shared_dir
            .join("assets")
            .join("log_configs")
            .join(&log_cfg.file.id);
        let exp_sz = if log_cfg.file.size > 0 {
            Some(log_cfg.file.size)
        } else {
            None
        };
        if !verify_file_matches(&xml_path, &log_cfg.file.sha1, exp_sz, check_hashes, cancel).await {
            let urls = vec![log_cfg.file.url.clone()];
            let sha = if log_cfg.file.sha1.is_empty() {
                None
            } else {
                Some((ChecksumAlgo::Sha1, log_cfg.file.sha1.as_str()))
            };
            download_verified(
                client,
                log,
                DownloadSpec {
                    urls: &urls,
                    dest: &xml_path,
                    expected_size: exp_sz,
                    expected_hash: sha,
                    policy: HostPolicy::AnyHttps,
                    attempts: 3,
                },
                cancel,
                |_| {},
            )
            .await?;
        }
    }

    // Vanilla libraries
    ensure_libraries_list(
        client,
        log,
        shared_dir,
        &resolved.libraries,
        &["https://libraries.minecraft.net"],
        check_hashes,
        Stage::Minecraft,
        "Библиотеки Minecraft",
        cancel,
        on_progress,
    )
    .await?;

    // Asset index + objects
    if let Some(ref ai) = resolved.asset_index {
        let indexes_dir = shared_dir.join("assets").join("indexes");
        ensure_dir(&indexes_dir).await?;
        let by_id = indexes_dir.join(format!("{}.json", ai.id));
        let by_sha = indexes_dir.join(format!("{}.json", ai.sha1));

        let idx_ok = verify_file_matches(&by_id, &ai.sha1, Some(ai.size), true, cancel).await;
        if !idx_ok {
            let urls = vec![ai.url.clone()];
            let sha = if ai.sha1.is_empty() {
                None
            } else {
                Some((ChecksumAlgo::Sha1, ai.sha1.as_str()))
            };
            download_verified(
                client,
                log,
                DownloadSpec {
                    urls: &urls,
                    dest: &by_id,
                    expected_size: Some(ai.size),
                    expected_hash: sha,
                    policy: HostPolicy::AnyHttps,
                    attempts: 3,
                },
                cancel,
                |_| {},
            )
            .await?;
        }
        if !ai.sha1.is_empty() && by_sha != by_id {
            if !verify_file_matches(&by_sha, &ai.sha1, Some(ai.size), false, cancel).await {
                let _ = tokio::fs::copy(&by_id, &by_sha).await;
            }
        }

        let idx_raw = tokio::fs::read(&by_id).await?;
        let idx_json: AssetIndexJson = serde_json::from_slice(&idx_raw).map_err(|e| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Повреждённый индекс ресурсов Minecraft",
                e.to_string(),
            )
        })?;

        let objects_root = shared_dir.join("assets").join("objects");
        let mut seen_hashes = HashSet::new();
        let mut missing_assets = Vec::new();

        for obj in idx_json.objects.into_values() {
            if obj.hash.len() < 4 || !seen_hashes.insert(obj.hash.clone()) {
                continue;
            }
            let prefix = &obj.hash[0..2];
            let obj_path = objects_root.join(prefix).join(&obj.hash);
            if verify_file_matches(&obj_path, &obj.hash, Some(obj.size), check_hashes, cancel).await {
                continue;
            }
            let url = format!("{MOJANG_RESOURCES_BASE}/{prefix}/{}", obj.hash);
            missing_assets.push(DownloadTaskItem {
                urls: vec![url],
                dest: obj_path,
                expected_size: Some(obj.size),
                expected_sha1: obj.hash,
            });
        }

        if !missing_assets.is_empty() {
            log.info(
                "minecraft",
                format!("Загрузка ресурсов Minecraft: {} файлов", missing_assets.len()),
            );
            download_items_parallel(
                client,
                log,
                missing_assets,
                Stage::Minecraft,
                "Ресурсы Minecraft",
                8,
                cancel,
                on_progress,
            )
            .await?;
        }
    }

    Ok(resolved)
}

async fn install_fabric_loader(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    mc_ver: &str,
    loader_ver: &str,
    check_hashes: bool,
    cancel: &CancelToken,
    on_progress: &ProgressCallback,
) -> AppResult<String> {
    emit(
        on_progress,
        Stage::Loader,
        format!("Установка Fabric {loader_ver}"),
        0,
        0,
        0,
        0,
        0,
    );

    let url = format!("{FABRIC_META_BASE}/versions/loader/{mc_ver}/{loader_ver}/profile/json");
    let expected_id = format!("{mc_ver}-fabric{loader_ver}");
    let cached_json = version_json_path(shared_dir, &expected_id);

    let raw_text = if tokio::fs::try_exists(&cached_json).await.unwrap_or(false) {
        match tokio::fs::read_to_string(&cached_json).await {
            Ok(s) if serde_json::from_str::<RawVersionJson>(&s).is_ok() => s,
            _ => {
                fetch_text(
                    client,
                    &url,
                    HostPolicy::AnyHttps,
                    8 * 1024 * 1024,
                    Duration::from_secs(20),
                    None,
                    cancel,
                )
                .await?
            }
        }
    } else {
        fetch_text(
            client,
            &url,
            HostPolicy::AnyHttps,
            8 * 1024 * 1024,
            Duration::from_secs(20),
            None,
            cancel,
        )
        .await?
    };

    let mut parsed_val: Value = serde_json::from_str(&raw_text).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Некорректный профиль Fabric",
            e.to_string(),
        )
    })?;
    let json_id = parsed_val
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| expected_id.clone());

    if json_id != expected_id {
        if let Some(obj) = parsed_val.as_object_mut() {
            obj.insert("id".to_string(), Value::String(expected_id.clone()));
        }
    }
    let out_path = version_json_path(shared_dir, &expected_id);
    if !tokio::fs::try_exists(&out_path).await.unwrap_or(false) {
        write_json_atomic(&out_path, &parsed_val).await?;
    }

    let resolved = parse_version(shared_dir, &expected_id).await?;
    ensure_libraries_list(
        client,
        log,
        shared_dir,
        &resolved.libraries,
        &["https://maven.fabricmc.net", "https://libraries.minecraft.net"],
        check_hashes,
        Stage::Loader,
        "Библиотеки Fabric",
        cancel,
        on_progress,
    )
    .await?;

    Ok(expected_id)
}

fn parse_mc_minor(mc_ver: &str) -> Option<u32> {
    let mut parts = mc_ver.trim().split('.');
    let major = parts.next()?;
    if major != "1" {
        return None;
    }
    parts.next()?.parse::<u32>().ok()
}

fn forge_artifact_version(mc_ver: &str, forge_ver: &str) -> String {
    let minor = parse_mc_minor(mc_ver).unwrap_or(20);
    if matches!(minor, 7 | 8) {
        format!("{mc_ver}-{forge_ver}-{mc_ver}")
    } else if forge_ver.starts_with(&format!("{mc_ver}-")) {
        forge_ver.to_string()
    } else {
        format!("{mc_ver}-{forge_ver}")
    }
}

fn extract_installer_zip_contents(
    installer_jar: &Path,
    shared_dir: &Path,
    cache_extract_dir: &Path,
    cancel: &CancelToken,
) -> AppResult<(Option<Vec<u8>>, Option<Vec<u8>>, HashMap<String, PathBuf>)> {
    let file = File::open(installer_jar).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Не удалось открыть installer.jar",
            e.to_string(),
        )
    })?;
    let mut zip = ZipArchive::new(file).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Повреждённый installer.jar",
            e.to_string(),
        )
    })?;

    let mut install_profile_bytes = None;
    let mut version_json_bytes = None;
    let mut extracted_data_files: HashMap<String, PathBuf> = HashMap::new();
    let libs_root = shared_dir.join("libraries");

    for i in 0..zip.len() {
        cancel.check()?;
        let mut entry = zip.by_index(i).map_err(|e| {
            LauncherError::new(ErrorCode::MinecraftInstall, "Ошибка чтения архива установщика", e.to_string())
        })?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() || name.contains("..") || name.starts_with('/') {
            continue;
        }
        if name == "install_profile.json" {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            install_profile_bytes = Some(buf);
        } else if name == "version.json" {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            version_json_bytes = Some(buf);
        } else if let Some(rel_maven) = name.strip_prefix("maven/") {
            if rel_maven.is_empty() {
                continue;
            }
            let dest = library_path(shared_dir, rel_maven);
            if !dest.starts_with(&libs_root) {
                continue;
            }
            if let Some(p) = dest.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut out = File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
        } else if name.starts_with("data/") {
            let mut dest = cache_extract_dir.to_path_buf();
            for seg in name.split('/') {
                if !seg.is_empty() && seg != "." && seg != ".." {
                    dest.push(seg);
                }
            }
            if let Some(p) = dest.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut out = File::create(&dest)?;
            std::io::copy(&mut entry, &mut out)?;
            extracted_data_files.insert(format!("/{name}"), dest);
        }
    }

    Ok((install_profile_bytes, version_json_bytes, extracted_data_files))
}

fn read_jar_main_class(jar_path: &Path) -> AppResult<String> {
    let file = File::open(jar_path).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Не найден JAR процессор",
            format!("{}: {e}", jar_path.display()),
        )
    })?;
    let mut zip = ZipArchive::new(file).map_err(|e| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Повреждённый JAR процессор",
            format!("{}: {e}", jar_path.display()),
        )
    })?;
    let mut mf = zip.by_name("META-INF/MANIFEST.MF").map_err(|_| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Не найден MANIFEST.MF в процессоре",
            jar_path.display().to_string(),
        )
    })?;
    let mut text = String::new();
    mf.read_to_string(&mut text)?;
    let unfolded = text.replace("\r\n ", "").replace("\n ", "");
    for line in unfolded.lines() {
        let trimmed = line.trim_end();
        if let Some(val) = trimmed.strip_prefix("Main-Class:") {
            let cls = val.trim();
            if !cls.is_empty() {
                return Ok(cls.to_string());
            }
        }
    }
    Err(LauncherError::new(
        ErrorCode::MinecraftInstall,
        "В процессоре не указан Main-Class",
        jar_path.display().to_string(),
    ))
}

async fn ensure_maven_coord_downloaded(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    coord: &str,
    extra_mavens: &[&str],
    cancel: &CancelToken,
) -> AppResult<PathBuf> {
    let clean = coord.trim().trim_start_matches('[').trim_end_matches(']');
    let info = LibraryInfo::resolve(clean);
    let dest = library_path(shared_dir, &info.path);
    if tokio::fs::try_exists(&dest).await.unwrap_or(false) {
        if let Ok(m) = tokio::fs::metadata(&dest).await {
            if m.is_file() && m.len() > 0 {
                return Ok(dest);
            }
        }
    }
    let urls = maven_fallback_urls(&info.path, None, extra_mavens);
    download_verified(
        client,
        log,
        DownloadSpec {
            urls: &urls,
            dest: &dest,
            expected_size: None,
            expected_hash: None,
            policy: HostPolicy::AnyHttps,
            attempts: urls.len().max(2),
        },
        cancel,
        |_| {},
    )
    .await?;
    Ok(dest)
}

fn resolve_maven_bracket_or_literal(shared_dir: &Path, raw: &str) -> String {
    let s = raw.trim();
    if let Some(inner) = s.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        let info = LibraryInfo::resolve(inner);
        return library_path(shared_dir, &info.path)
            .to_string_lossy()
            .into_owned();
    }
    if let Some(inner) = s.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return inner.to_string();
    }
    s.to_string()
}

fn expand_forge_tokens(raw: &str, vars: &HashMap<String, String>, shared_dir: &Path) -> String {
    let mut out = raw.to_string();
    for (k, v) in vars {
        let pat = format!("{{{k}}}");
        if out.contains(&pat) {
            out = out.replace(&pat, v);
        }
    }
    resolve_maven_bracket_or_literal(shared_dir, &out)
}

async fn verify_processor_outputs(
    outputs: &Option<HashMap<String, String>>,
    vars: &HashMap<String, String>,
    shared_dir: &Path,
    cancel: &CancelToken,
) -> bool {
    let Some(map) = outputs else {
        return false;
    };
    if map.is_empty() {
        return false;
    }
    for (k_tmpl, v_tmpl) in map {
        let out_path_str = expand_forge_tokens(k_tmpl, vars, shared_dir);
        let out_path = PathBuf::from(&out_path_str);
        let Ok(meta) = tokio::fs::metadata(&out_path).await else {
            return false;
        };
        if !meta.is_file() || meta.len() == 0 {
            return false;
        }
        let expected_sha = expand_forge_tokens(v_tmpl, vars, shared_dir)
            .trim_matches('\'')
            .to_lowercase();
        let is_tsrg = out_path_str.ends_with(".tsrg");
        if !is_tsrg && expected_sha.len() == 40 && expected_sha.chars().all(|c| c.is_ascii_hexdigit()) {
            let Ok(actual) = hash_file(&out_path, ChecksumAlgo::Sha1, cancel).await else {
                return false;
            };
            if !actual.eq_ignore_ascii_case(&expected_sha) {
                return false;
            }
        }
    }
    true
}

async fn install_forge_or_neoforge(
    client: &Client,
    log: &AppLogger,
    shared_dir: &Path,
    mc_ver: &str,
    loader: &Loader,
    java_exe: &Path,
    check_hashes: bool,
    cancel: &CancelToken,
    on_progress: &ProgressCallback,
) -> AppResult<String> {
    let (is_neo, raw_loader_ver) = match loader {
        Loader::Forge { version } => (false, version.clone()),
        Loader::Neoforge { version } => (true, version.clone()),
        _ => {
            return Err(LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Внутренняя ошибка загрузчика",
                "Ожидался Forge или NeoForge.",
            ))
        }
    };

    let (title, artifact, installer_dest, installer_urls, cache_dir, primary_maven): (
        String,
        String,
        PathBuf,
        Vec<String>,
        PathBuf,
        &'static str,
    ) = if is_neo {
        let rel = format!(
            "net/neoforged/neoforge/{raw_loader_ver}/neoforge-{raw_loader_ver}-installer.jar"
        );
        let dest = library_path(shared_dir, &rel);
        let url = format!("https://maven.neoforged.net/releases/{rel}");
        let cache = shared_dir
            .join(".installer-cache")
            .join(format!("neoforge-{raw_loader_ver}"));
        (
            format!("NeoForge {raw_loader_ver}"),
            raw_loader_ver.clone(),
            dest,
            vec![url],
            cache,
            "https://maven.neoforged.net/releases",
        )
    } else {
        let art = forge_artifact_version(mc_ver, &raw_loader_ver);
        let rel = format!("net/minecraftforge/forge/{art}/forge-{art}-installer.jar");
        let dest = library_path(shared_dir, &rel);
        let alt_art = format!("{mc_ver}-{raw_loader_ver}-{mc_ver}");
        let mut urls = vec![format!("https://maven.minecraftforge.net/{rel}")];
        if alt_art != art {
            urls.push(format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{alt_art}/forge-{alt_art}-installer.jar"
            ));
        }
        let cache = shared_dir
            .join(".installer-cache")
            .join(format!("forge-{art}"));
        (
            format!("Forge {raw_loader_ver}"),
            art,
            dest,
            urls,
            cache,
            "https://maven.minecraftforge.net",
        )
    };

    // Пробуем понять, нужно ли запускать установку (проверяем уже установленную версию)
    let expected_version_id = if is_neo {
        format!("neoforge-{raw_loader_ver}")
    } else {
        format!("{mc_ver}-forge-{raw_loader_ver}")
    };

    emit(
        on_progress,
        Stage::Loader,
        format!("Установка {title}"),
        0,
        0,
        0,
        0,
        0,
    );

    if !tokio::fs::try_exists(&installer_dest).await.unwrap_or(false) {
        log.info(
            "minecraft",
            format!("Скачивание установщика {title}: {}", installer_urls[0]),
        );
        download_verified(
            client,
            log,
            DownloadSpec {
                urls: &installer_urls,
                dest: &installer_dest,
                expected_size: None,
                expected_hash: None,
                policy: HostPolicy::AnyHttps,
                attempts: 3,
            },
            cancel,
            |_| {},
        )
        .await?;
    }

    let inst_clone = installer_dest.clone();
    let shared_clone = shared_dir.to_path_buf();
    let cache_clone = cache_dir.clone();
    let cancel_bg = cancel.clone();

    let (install_profile_bytes, version_json_bytes, extracted_data) =
        tokio::task::spawn_blocking(move || {
            extract_installer_zip_contents(&inst_clone, &shared_clone, &cache_clone, &cancel_bg)
        })
        .await
        .map_err(|e| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Ошибка распаковки установщика",
                e.to_string(),
            )
        })??;

    let profile_bytes = install_profile_bytes.ok_or_else(|| {
        LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Некорректный установщик",
            format!("В архиве {} отсутствует install_profile.json.", installer_dest.display()),
        )
    })?;

    if let Ok(modern) = serde_json::from_slice::<ModernInstallProfile>(&profile_bytes) {
        let ver_bytes = version_json_bytes.ok_or_else(|| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Некорректный установщик",
                "В архиве установщика отсутствует version.json.",
            )
        })?;
        let ver_val: Value = serde_json::from_slice(&ver_bytes).map_err(|e| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Повреждённый version.json установщика",
                e.to_string(),
            )
        })?;
        let final_ver_id = ver_val
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or(modern.version.as_deref())
            .unwrap_or(&expected_version_id)
            .to_string();

        let ver_out = version_json_path(shared_dir, &final_ver_id);
        write_json_atomic(&ver_out, &ver_val).await?;
        let prof_out = ver_out
            .parent()
            .unwrap_or(shared_dir)
            .join("install_profile.json");
        if let Some(p) = prof_out.parent() {
            ensure_dir(p).await?;
        }
        tokio::fs::write(&prof_out, &profile_bytes).await?;

        // Скачиваем libraries из install_profile.json
        let profile_libs = crate::mc_version::resolve_libraries(&modern.libraries);
        ensure_libraries_list(
            client,
            log,
            shared_dir,
            &profile_libs,
            &[primary_maven],
            check_hashes,
            Stage::Loader,
            &format!("Библиотеки установщика {title}"),
            cancel,
            on_progress,
        )
        .await?;

        // Собираем переменные подстановки для процессоров
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("SIDE".to_string(), "client".to_string());
        vars.insert(
            "MINECRAFT_JAR".to_string(),
            version_jar_path(shared_dir, mc_ver)
                .to_string_lossy()
                .into_owned(),
        );
        vars.insert(
            "ROOT".to_string(),
            shared_dir.to_string_lossy().into_owned(),
        );
        vars.insert("MINECRAFT_VERSION".to_string(), mc_ver.to_string());
        vars.insert(
            "LIBRARY_DIR".to_string(),
            shared_dir.join("libraries").to_string_lossy().into_owned(),
        );
        vars.insert(
            "INSTALLER".to_string(),
            installer_dest.to_string_lossy().into_owned(),
        );
        for (k, entry) in &modern.data {
            if let Some(ref c) = entry.client {
                let resolved_val = if let Some(ext) = extracted_data.get(c) {
                    ext.to_string_lossy().into_owned()
                } else {
                    resolve_maven_bracket_or_literal(shared_dir, c)
                };
                vars.insert(k.clone(), resolved_val);
            }
        }
        let _ = (modern.path, modern.minecraft, modern.json);

        // Выполняем client-процессоры
        let client_procs: Vec<&InstallProfileProcessor> = modern
            .processors
            .iter()
            .filter(|p| {
                p.sides
                    .as_ref()
                    .is_none_or(|s| s.is_empty() || s.iter().any(|x| x == "client"))
            })
            .collect();

        let total_procs = client_procs.len();
        for (idx, proc_def) in client_procs.into_iter().enumerate() {
            cancel.check()?;
            emit(
                on_progress,
                Stage::Loader,
                format!("Сборка {title} ({}/{total_procs})", idx + 1),
                0,
                0,
                idx,
                total_procs,
                0,
            );

            if verify_processor_outputs(&proc_def.outputs, &vars, shared_dir, cancel).await {
                continue;
            }

            let proc_jar = ensure_maven_coord_downloaded(
                client,
                log,
                shared_dir,
                &proc_def.jar,
                &[primary_maven],
                cancel,
            )
            .await?;

            let mut cp_entries = vec![proc_jar.to_string_lossy().into_owned()];
            for dep in &proc_def.classpath {
                let dep_path = ensure_maven_coord_downloaded(
                    client,
                    log,
                    shared_dir,
                    dep,
                    &[primary_maven],
                    cancel,
                )
                .await?;
                cp_entries.push(dep_path.to_string_lossy().into_owned());
            }

            let main_class = read_jar_main_class(&proc_jar)?;
            let sep = if cfg!(windows) { ";" } else { ":" };
            let cp_joined = cp_entries.join(sep);

            let resolved_args: Vec<String> = proc_def
                .args
                .iter()
                .map(|a| expand_forge_tokens(a, &vars, shared_dir))
                .collect();

            log.info(
                "minecraft",
                format!(
                    "Процессор {title} [{}/{}]: {main_class}",
                    idx + 1,
                    total_procs
                ),
            );

            let mut cmd = Command::new(java_exe);
            cmd.arg("-cp")
                .arg(&cp_joined)
                .arg(&main_class)
                .args(&resolved_args)
                .current_dir(shared_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let output = tokio::select! {
                _ = cancel.cancelled() => return Err(LauncherError::cancelled()),
                res = cmd.output() => res.map_err(|e| {
                    LauncherError::new(
                        ErrorCode::MinecraftInstall,
                        format!("Не удалось запустить установщик {title}"),
                        e.to_string(),
                    )
                })?,
            };

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                let tail: String = format!("{stderr}\n{stdout}")
                    .lines()
                    .rev()
                    .take(12)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                log.error("minecraft", format!("Сбой процессора {main_class}: {tail}"));
                return Err(LauncherError::new(
                    ErrorCode::MinecraftInstall,
                    format!("Ошибка установки {title}"),
                    format!(
                        "Процессор {main_class} завершился с кодом {:?}.\n{tail}",
                        output.status.code()
                    ),
                ));
            }
        }

        // Библиотеки из version.json (пропуская пустой URL, если файл уже распакован/сгенерирован!)
        let resolved_ver = parse_version(shared_dir, &final_ver_id).await?;
        let mut libs_to_dl = Vec::new();
        for lib in &resolved_ver.libraries {
            if lib.download.path.is_empty() {
                continue;
            }
            let dest = library_path(shared_dir, &lib.download.path);
            let exp_sz = if lib.download.size > 0 {
                Some(lib.download.size as u64)
            } else {
                None
            };
            if verify_file_matches(&dest, &lib.download.sha1, exp_sz, check_hashes, cancel).await {
                continue;
            }
            // Если url пустой И файл уже существует с размером > 0 (сгенерирован патчером)
            if lib.download.url.trim().is_empty()
                && tokio::fs::metadata(&dest)
                    .await
                    .is_ok_and(|m| m.is_file() && m.len() > 0)
            {
                continue;
            }
            libs_to_dl.push(lib.clone());
        }
        ensure_libraries_list(
            client,
            log,
            shared_dir,
            &libs_to_dl,
            &[primary_maven],
            check_hashes,
            Stage::Loader,
            &format!("Библиотеки {title}"),
            cancel,
            on_progress,
        )
        .await?;

        let _ = artifact;
        return Ok(final_ver_id);
    }

    // Legacy Forge <= 1.12.2 (install + versionInfo)
    if let Ok(legacy) = serde_json::from_slice::<LegacyInstallProfile>(&profile_bytes) {
        let ver_id = legacy
            .install
            .target
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or(expected_version_id);
        let ver_out = version_json_path(shared_dir, &ver_id);
        write_json_atomic(&ver_out, &legacy.version_info).await?;

        // Распаковка filePath (universal jar) в path библиотеку
        if let (Some(coord), Some(jar_entry_name)) =
            (legacy.install.path.as_deref(), legacy.install.file_path.as_deref())
        {
            let info = LibraryInfo::resolve(coord);
            let dest = library_path(shared_dir, &info.path);
            let inst_p = installer_dest.clone();
            let entry_name = jar_entry_name.to_string();
            tokio::task::spawn_blocking(move || -> AppResult<()> {
                let f = File::open(&inst_p)?;
                let mut z = ZipArchive::new(f).map_err(|e| {
                    LauncherError::new(ErrorCode::MinecraftInstall, "Повреждённый установщик Forge", e.to_string())
                })?;
                if let Ok(mut e) = z.by_name(&entry_name) {
                    if let Some(p) = dest.parent() {
                        std::fs::create_dir_all(p)?;
                    }
                    let mut out = File::create(&dest)?;
                    std::io::copy(&mut e, &mut out)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| LauncherError::new(ErrorCode::MinecraftInstall, "Ошибка распаковки Forge", e.to_string()))??;
        }

        let resolved_ver = parse_version(shared_dir, &ver_id).await?;
        let mut libs_to_dl = Vec::new();
        for lib in &resolved_ver.libraries {
            if lib.download.path.is_empty() {
                continue;
            }
            let dest = library_path(shared_dir, &lib.download.path);
            if verify_file_matches(&dest, &lib.download.sha1, None, check_hashes, cancel).await {
                continue;
            }
            libs_to_dl.push(lib.clone());
        }
        ensure_libraries_list(
            client,
            log,
            shared_dir,
            &libs_to_dl,
            &[primary_maven],
            check_hashes,
            Stage::Loader,
            &format!("Библиотеки {title}"),
            cancel,
            on_progress,
        )
        .await?;

        return Ok(ver_id);
    }

    Err(LauncherError::new(
        ErrorCode::MinecraftInstall,
        format!("Неподдерживаемый формат установщика {title}"),
        "Файл install_profile.json имеет неизвестную структуру.",
    ))
}

async fn quick_diagnose_missing(
    shared_dir: &Path,
    resolved: &ResolvedVersion,
    check_hashes: bool,
    cancel: &CancelToken,
) -> bool {
    let client_jar = version_jar_path(shared_dir, &resolved.minecraft_version);
    let client_sha = resolved
        .downloads
        .get("client")
        .map(|d| d.sha1.as_str())
        .unwrap_or("");
    let client_sz = resolved
        .downloads
        .get("client")
        .and_then(|d| if d.size > 0 { Some(d.size as u64) } else { None });
    if !verify_file_matches(&client_jar, client_sha, client_sz, check_hashes, cancel).await {
        return true;
    }

    for lib in &resolved.libraries {
        if lib.download.path.is_empty() {
            continue;
        }
        let dest = library_path(shared_dir, &lib.download.path);
        let exp_sz = if lib.download.size > 0 {
            Some(lib.download.size as u64)
        } else {
            None
        };
        if !verify_file_matches(&dest, &lib.download.sha1, exp_sz, check_hashes, cancel).await {
            return true;
        }
    }

    if let Some(ref ai) = resolved.asset_index {
        let idx_path = shared_dir
            .join("assets")
            .join("indexes")
            .join(format!("{}.json", ai.id));
        if !tokio::fs::try_exists(&idx_path).await.unwrap_or(false) {
            return true;
        }
        let Ok(raw) = tokio::fs::read(&idx_path).await else {
            return true;
        };
        let Ok(idx) = serde_json::from_slice::<AssetIndexJson>(&raw) else {
            return true;
        };
        let obj_root = shared_dir.join("assets").join("objects");
        for obj in idx.objects.values() {
            if obj.hash.len() < 4 {
                continue;
            }
            let p = obj_root.join(&obj.hash[0..2]).join(&obj.hash);
            if !tokio::fs::metadata(&p)
                .await
                .is_ok_and(|m| m.is_file() && m.len() == obj.size)
            {
                return true;
            }
        }
    }

    false
}

pub async fn ensure_minecraft_and_loader(
    client: &Client,
    log: &AppLogger,
    install_dir: &Path,
    instance_dir: &Path,
    manifest: &ManifestJson,
    custom_java_path: Option<&str>,
    full_verify: bool,
    cancel: &CancelToken,
    on_progress: ProgressCallback,
) -> AppResult<PreparedRuntime> {
    cancel.check()?;
    let shared_dir = shared_minecraft_dir(install_dir);
    ensure_dir(&shared_dir).await?;
    ensure_dir(&shared_dir.join("versions")).await?;
    ensure_dir(&shared_dir.join("libraries")).await?;
    ensure_dir(&shared_dir.join("assets")).await?;

    let marker_path = runtime_marker_path(instance_dir);
    let existing_marker: Option<RuntimeMarker> = read_json_file(&marker_path).await.ok().flatten();

    // Быстрый путь: если маркер совпадает со сборкой, Java и все файлы на месте
    if let Some(marker) = existing_marker {
        if marker.schema_version == 1
            && marker.minecraft == manifest.minecraft
            && marker.loader == manifest.loader
        {
            if let Ok(resolved) = parse_version(&shared_dir, &marker.version_id).await {
                let target_java = if let Some(c) = custom_java_path.map(str::trim).filter(|s| !s.is_empty()) {
                    PathBuf::from(c)
                } else {
                    PathBuf::from(&marker.java_path)
                };
                if let Ok(java) = probe_java_executable(&target_java).await {
                    let needed_major = required_java_major(
                        &manifest.minecraft,
                        manifest.java.as_ref().map(|j| j.major),
                        resolved.java_major,
                    );
                    if java.major_version == needed_major
                        && !quick_diagnose_missing(&shared_dir, &resolved, full_verify, cancel).await
                    {
                        return Ok(PreparedRuntime {
                            version_id: marker.version_id,
                            resolved,
                            java,
                            shared_dir,
                        });
                    }
                }
            }
        }
    }

    // 1. Ванильный Minecraft (нужен до запуска Forge-процессоров)
    let vanilla_resolved = install_vanilla_assets_and_client(
        client,
        log,
        &shared_dir,
        &manifest.minecraft,
        full_verify,
        cancel,
        &on_progress,
    )
    .await?;

    // 2. Java runtime нужной версии
    let needed_major = required_java_major(
        &manifest.minecraft,
        manifest.java.as_ref().map(|j| j.major),
        vanilla_resolved.java_major,
    );
    let cb_java = Arc::clone(&on_progress);
    let java = ensure_java_runtime(
        client,
        log,
        needed_major,
        install_dir,
        custom_java_path,
        cancel,
        move |u| cb_java(u),
    )
    .await?;

    // 3. Модлоадер
    let version_id = match &manifest.loader {
        Loader::Vanilla => manifest.minecraft.clone(),
        Loader::Fabric { version } => {
            install_fabric_loader(
                client,
                log,
                &shared_dir,
                &manifest.minecraft,
                version,
                full_verify,
                cancel,
                &on_progress,
            )
            .await?
        }
        Loader::Forge { .. } | Loader::Neoforge { .. } => {
            install_forge_or_neoforge(
                client,
                log,
                &shared_dir,
                &manifest.minecraft,
                &manifest.loader,
                Path::new(&java.path),
                full_verify,
                cancel,
                &on_progress,
            )
            .await?
        }
    };

    let resolved = parse_version(&shared_dir, &version_id).await?;
    // Проверим, требует ли финальный loader другой major Java (напр. Forge/modded)
    let final_major = required_java_major(
        &manifest.minecraft,
        manifest.java.as_ref().map(|j| j.major),
        resolved.java_major,
    );
    let final_java = if final_major != java.major_version {
        let cb_java2 = Arc::clone(&on_progress);
        ensure_java_runtime(
            client,
            log,
            final_major,
            install_dir,
            custom_java_path,
            cancel,
            move |u| cb_java2(u),
        )
        .await?
    } else {
        java
    };

    // Финальная проверка целостности
    if quick_diagnose_missing(&shared_dir, &resolved, false, cancel).await {
        log.warn(
            "minecraft",
            format!("Повторная докачка недостающих файлов версии {version_id}"),
        );
        install_vanilla_assets_and_client(
            client,
            log,
            &shared_dir,
            &manifest.minecraft,
            true,
            cancel,
            &on_progress,
        )
        .await?;
        ensure_libraries_list(
            client,
            log,
            &shared_dir,
            &resolved.libraries,
            &[],
            false,
            Stage::Loader,
            "Докачка библиотек",
            cancel,
            &on_progress,
        )
        .await?;
    }

    let marker = RuntimeMarker {
        schema_version: 1,
        version_id: version_id.clone(),
        minecraft: manifest.minecraft.clone(),
        loader: manifest.loader.clone(),
        java_major: final_major,
        java_path: final_java.path.clone(),
    };
    let _ = write_json_atomic(&marker_path, &marker).await;

    Ok(PreparedRuntime {
        resolved,
        java: final_java,
        shared_dir,
        version_id,
    })
}
