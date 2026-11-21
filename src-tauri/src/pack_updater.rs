use crate::archive::{extract_zip_entries, ZipExtractSpec};
use crate::catalog_service::parse_and_validate_manifest;
use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{
    assert_free_space, assert_real_inside, ensure_dir, read_json_file, remove_quiet,
    rename_with_retry, safe_join, write_json_atomic,
};
use crate::http::{download_verified, hash_file, ChecksumAlgo, DownloadSpec, HostPolicy};
use crate::log::AppLogger;
use crate::paths::{matches_any, path_key, LAUNCHER_META_DIR};
use crate::types::{
    ConflictChoice, ConflictKind, ConflictView, FileMode, ManifestFile, ManifestFileSource,
    ManifestJson, Stage,
};
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

/// Пользовательские файлы настроек (карта, голосовой чат, базовые опции),
/// которые ставятся только при отсутствии и НИКОГДА не перезаписываются и не вызывают конфликтов
/// ни при перезаходе, ни при обновлении сборки (даже если в старом манифесте помечены как managed).
pub const ALWAYS_INITIAL_USER_GLOBS: &[&str] = &[
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    // Карты (Xaero's Minimap / World Map, JourneyMap, FTB Chunks, VoxelMap)
    "xaero/**",
    "XaeroWaypoints*/**",
    "XaeroWorldMap/**",
    "config/xaero/**",
    "config/xaero*.txt",
    "config/xaerominimap*",
    "config/xaeroworldmap*",
    "config/xaerocommon*",
    "config/xaerohud*",
    "config/xaeropatreon*",
    "journeymap/**",
    "config/journeymap/**",
    "local/ftbchunks/**",
    "config/ftbchunks-client.snbt",
    "local/ftblibrary-client.snbt",
    "config/ftblibrary-client.snbt",
    "voxelmap/**",
    "config/voxelmap*",
    // Голосовой чат и клиентский звук (Simple Voice Chat, Plasmo Voice, Extreme Sound Muffler)
    "config/voicechat/**",
    "config/voicechat-client.toml",
    "config/plasmovoice/**",
    "config/extremesoundmuffler-client.toml",
    "ESM/**",
];

/// Файлы, которые автоматически обновляются при выходе новой версии сборки без диалога конфликта
/// (например, servers.dat, чтобы синхронизировать актуальный список серверов).
pub const AUTO_SYNC_ON_UPDATE_GLOBS: &[&str] = &["servers.dat"];

pub const PROTECTED_USER_GLOBS: &[&str] = &[
    "saves/**",
    "screenshots/**",
    "resourcepacks/**",
    "shaderpacks/**",
    "schematics/**",
    "xaero/**",
    "XaeroWaypoints*/**",
    "XaeroWorldMap/**",
    "config/xaero/**",
    "config/xaero*.txt",
    "config/xaerominimap*",
    "config/xaeroworldmap*",
    "config/xaerocommon*",
    "config/xaerohud*",
    "config/xaeropatreon*",
    "journeymap/**",
    "config/journeymap/**",
    "local/ftbchunks/**",
    "config/ftbchunks-client.snbt",
    "local/ftblibrary-client.snbt",
    "config/ftblibrary-client.snbt",
    "voxelmap/**",
    "config/voxelmap*",
    "config/voicechat/**",
    "config/voicechat-client.toml",
    "config/plasmovoice/**",
    "config/extremesoundmuffler-client.toml",
    "ESM/**",
    "logs/**",
    "crash-reports/**",
    "backups/**",
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "servers.dat",
    "servers.dat_old",
    "usercache.json",
    "usernamecache.json",
    ".abilauncher/**",
];

pub fn effective_file_mode(file: &ManifestFile) -> FileMode {
    if matches_any(&file.path, AUTO_SYNC_ON_UPDATE_GLOBS) {
        return FileMode::Managed;
    }
    if file.mode == FileMode::Initial || matches_any(&file.path, ALWAYS_INITIAL_USER_GLOBS) {
        FileMode::Initial
    } else {
        file.mode
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFileRecord {
    pub sha256: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mode: FileMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_by_user: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstanceState {
    pub schema_version: u32,
    pub pack_id: String,
    pub version: String,
    pub updated_at: String,
    pub managed: HashMap<String, ManagedFileRecord>,
}

#[derive(Debug, Clone)]
pub struct SyncProgressUpdate {
    pub stage: Stage,
    pub label: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub speed: u64,
}

pub struct SyncPlan {
    pub to_download: Vec<ManifestFile>,
    pub to_delete: Vec<String>,
    pub kept_by_user: Vec<(ManifestFile, ManagedFileRecord)>,
    pub conflicts: Vec<ConflictView>,
    pub conflict_files: HashMap<String, ManifestFile>,
    pub warnings: Vec<String>,
}

pub fn state_file_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join(LAUNCHER_META_DIR).join("state.json")
}

pub fn local_manifest_path(instance_dir: &Path) -> PathBuf {
    instance_dir.join(LAUNCHER_META_DIR).join("manifest.json")
}

pub async fn read_local_manifest(instance_dir: &Path) -> Option<ManifestJson> {
    let raw = tokio::fs::read_to_string(local_manifest_path(instance_dir))
        .await
        .ok()?;
    parse_and_validate_manifest(&raw).ok()
}

pub async fn read_pack_state(instance_dir: &Path) -> Option<PackInstanceState> {
    let parsed: PackInstanceState = read_json_file(&state_file_path(instance_dir))
        .await
        .ok()
        .flatten()?;
    if parsed.schema_version == 1 {
        Some(parsed)
    } else {
        None
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

async fn list_extra_mods(
    instance_dir: &Path,
    manifest_keys: &HashSet<String>,
    delete_keys: &HashSet<String>,
    conflict_keys: &HashSet<String>,
    cancel: &CancelToken,
) -> AppResult<Vec<String>> {
    let mods_dir = instance_dir.join("mods");
    if !tokio::fs::try_exists(&mods_dir).await.unwrap_or(false) {
        return Ok(Vec::new());
    }
    let mut extras = Vec::new();
    let mut stack = vec![(mods_dir, "mods".to_string())];
    while let Some((dir, prefix)) = stack.pop() {
        cancel.check()?;
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let Ok(ft) = entry.file_type().await else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = format!("{prefix}/{name}");
            if ft.is_dir() {
                stack.push((entry.path(), rel));
            } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".jar") {
                let k = path_key(&rel);
                if !manifest_keys.contains(&k)
                    && !delete_keys.contains(&k)
                    && !conflict_keys.contains(&k)
                {
                    extras.push(name);
                }
            }
        }
    }
    extras.sort();
    Ok(extras)
}

pub async fn plan_pack_sync<F>(
    instance_dir: &Path,
    manifest: &ManifestJson,
    full_verify: bool,
    cancel: &CancelToken,
    mut on_progress: F,
) -> AppResult<SyncPlan>
where
    F: FnMut(SyncProgressUpdate) + Send,
{
    cancel.check()?;
    ensure_dir(instance_dir).await?;
    let previous_state = read_pack_state(instance_dir).await;

    let mut to_download = Vec::new();
    let mut to_delete = Vec::new();
    let mut kept_by_user = Vec::new();
    let mut conflicts = Vec::new();
    let mut conflict_files = HashMap::new();
    let mut manifest_keys = HashSet::with_capacity(manifest.files.len());

    let mut state_by_key: HashMap<String, ManagedFileRecord> = HashMap::new();
    if let Some(ref st) = previous_state {
        for (rel, rec) in &st.managed {
            state_by_key.insert(path_key(rel), rec.clone());
        }
    }

    let total_files = manifest.files.len();
    for (idx, file) in manifest.files.iter().enumerate() {
        cancel.check()?;
        let key = path_key(&file.path);
        manifest_keys.insert(key.clone());

        let abs = safe_join(instance_dir, &file.path)?;
        assert_real_inside(instance_dir, &abs).await?;

        let meta_res = tokio::fs::symlink_metadata(&abs).await;
        match meta_res {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                to_download.push(file.clone());
            }
            Err(e) => return Err(e.into()),
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(LauncherError::new(
                        ErrorCode::Filesystem,
                        "Обнаружена символическая ссылка",
                        format!("Файл «{}» является символической ссылкой, что запрещено.", file.path),
                    ));
                }
                if meta.is_dir() {
                    return Err(LauncherError::new(
                        ErrorCode::Filesystem,
                        "Конфликт папки и файла",
                        format!(
                            "На месте файла «{}» находится папка. Удалите или переименуйте её вручную.",
                            file.path
                        ),
                    ));
                }
                let eff_mode = effective_file_mode(file);
                if eff_mode != FileMode::Initial {
                    let prev = state_by_key.get(&key);
                    let mtime = modified_ms(&meta);
                    let disk_sha = if !full_verify
                        && prev.is_some_and(|p| {
                            p.mode == FileMode::Managed
                                && !p.kept_by_user.unwrap_or(false)
                                && p.size == meta.len()
                                && (p.mtime_ms - mtime).abs() < 1.0
                                && p.sha256 == file.sha256
                        }) {
                        file.sha256.clone()
                    } else {
                        hash_file(&abs, ChecksumAlgo::Sha256, cancel).await?
                    };

                    if disk_sha == file.sha256 {
                        // Актуален
                    } else if matches_any(&file.path, AUTO_SYNC_ON_UPDATE_GLOBS) {
                        // Список серверов (servers.dat) обновляется автоматически при синхронизации новой версии
                        to_download.push(file.clone());
                    } else if let Some(p) = prev.filter(|r| r.mode == FileMode::Managed) {
                        if p.kept_by_user.unwrap_or(false) {
                            if !file.required
                                && p.target_sha256.as_deref() == Some(file.sha256.as_str())
                                && disk_sha == p.sha256
                            {
                                kept_by_user.push((
                                    file.clone(),
                                    ManagedFileRecord {
                                        sha256: disk_sha,
                                        size: meta.len(),
                                        mtime_ms: mtime,
                                        mode: FileMode::Managed,
                                        kept_by_user: Some(true),
                                        target_sha256: Some(file.sha256.clone()),
                                    },
                                ));
                            } else {
                                conflicts.push(ConflictView {
                                    path: file.path.clone(),
                                    kind: ConflictKind::Modified,
                                    can_keep: !file.required,
                                });
                                conflict_files.insert(file.path.clone(), file.clone());
                            }
                        } else if disk_sha == p.sha256 {
                            to_download.push(file.clone());
                        } else {
                            conflicts.push(ConflictView {
                                path: file.path.clone(),
                                kind: ConflictKind::Modified,
                                can_keep: !file.required,
                            });
                            conflict_files.insert(file.path.clone(), file.clone());
                        }
                    } else {
                        conflicts.push(ConflictView {
                            path: file.path.clone(),
                            kind: ConflictKind::Untracked,
                            can_keep: !file.required,
                        });
                        conflict_files.insert(file.path.clone(), file.clone());
                    }
                }
            }
        }

        let checked = idx + 1;
        if checked % 100 == 0 || checked == total_files {
            on_progress(SyncProgressUpdate {
                stage: Stage::Verify,
                label: format!("Проверка файлов сборки ({checked} / {total_files})"),
                bytes_done: checked as u64,
                bytes_total: total_files.max(1) as u64,
                files_done: checked,
                files_total: total_files,
                speed: 0,
            });
        }
    }

    if let Some(ref prev_state) = previous_state {
        for (rel, rec) in &prev_state.managed {
            cancel.check()?;
            if rec.mode != FileMode::Managed {
                continue;
            }
            if manifest_keys.contains(&path_key(rel)) {
                continue;
            }
            if matches_any(rel, PROTECTED_USER_GLOBS) {
                continue;
            }
            let abs = safe_join(instance_dir, rel)?;
            let Ok(meta) = tokio::fs::symlink_metadata(&abs).await else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let disk_sha = hash_file(&abs, ChecksumAlgo::Sha256, cancel).await?;
            if !rec.kept_by_user.unwrap_or(false) && disk_sha == rec.sha256 {
                to_delete.push(rel.clone());
            } else {
                conflicts.push(ConflictView {
                    path: rel.clone(),
                    kind: ConflictKind::ObsoleteModified,
                    can_keep: true,
                });
            }
        }
    }

    let delete_keys: HashSet<String> = to_delete.iter().map(|p| path_key(p)).collect();
    let conflict_keys: HashSet<String> = conflicts.iter().map(|c| path_key(&c.path)).collect();
    let extra_mods = list_extra_mods(
        instance_dir,
        &manifest_keys,
        &delete_keys,
        &conflict_keys,
        cancel,
    )
    .await?;
    let mut warnings = Vec::new();
    if !extra_mods.is_empty() {
        let shown: Vec<String> = extra_mods.iter().take(5).cloned().collect();
        let suffix = if extra_mods.len() > 5 {
            format!(" и ещё {}", extra_mods.len() - 5)
        } else {
            String::new()
        };
        warnings.push(format!(
            "Найдены дополнительные моды игрока ({}): {}{}. Они сохранены, но могут быть несовместимы со сборкой или сервером.",
            extra_mods.len(),
            shown.join(", "),
            suffix
        ));
    }

    Ok(SyncPlan {
        to_download,
        to_delete,
        kept_by_user,
        conflicts,
        conflict_files,
        warnings,
    })
}

fn safe_tag(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub async fn apply_pack_sync<F>(
    client: &Client,
    log: &AppLogger,
    instance_dir: &Path,
    manifest: &ManifestJson,
    plan: SyncPlan,
    resolutions: &HashMap<String, ConflictChoice>,
    cancel: &CancelToken,
    on_progress: F,
) -> AppResult<PackInstanceState>
where
    F: Fn(SyncProgressUpdate) + Send + Sync + 'static,
{
    cancel.check()?;
    ensure_dir(instance_dir).await?;

    for conflict in &plan.conflicts {
        let Some(choice) = resolutions.get(&conflict.path) else {
            return Err(
                LauncherError::new(
                    ErrorCode::Conflict,
                    "Требуется решение по изменённым файлам",
                    format!(
                        "Обнаружен конфликт файла «{}». Выберите, заменить его или оставить.",
                        conflict.path
                    ),
                )
                .with_hint("Выберите действие для всех конфликтных файлов и повторите запуск."),
            );
        };
        if *choice == ConflictChoice::Keep && !conflict.can_keep {
            return Err(LauncherError::new(
                ErrorCode::Conflict,
                "Обязательный файл нельзя пропустить",
                format!(
                    "Файл «{}» обязателен для работы сборки и должен быть заменён (с созданием резервной копии).",
                    conflict.path
                ),
            ));
        }
    }

    let mut files_to_stage = plan.to_download;
    let mut backup_targets = Vec::new();
    let mut delete_targets = plan.to_delete;
    let mut keep_entries = plan.kept_by_user;

    for conflict in &plan.conflicts {
        let choice = resolutions[&conflict.path];
        if conflict.kind == ConflictKind::ObsoleteModified {
            if choice == ConflictChoice::Replace {
                backup_targets.push(conflict.path.clone());
                delete_targets.push(conflict.path.clone());
            }
            continue;
        }
        let file = plan
            .conflict_files
            .get(&conflict.path)
            .ok_or_else(|| LauncherError::new(ErrorCode::Unknown, "Внутренняя ошибка конфликта", conflict.path.clone()))?
            .clone();
        if choice == ConflictChoice::Replace {
            backup_targets.push(conflict.path.clone());
            files_to_stage.push(file);
        } else {
            let abs = safe_join(instance_dir, &file.path)?;
            let meta = tokio::fs::metadata(&abs).await?;
            let sha = hash_file(&abs, ChecksumAlgo::Sha256, cancel).await?;
            keep_entries.push((
                file.clone(),
                ManagedFileRecord {
                    sha256: sha,
                    size: meta.len(),
                    mtime_ms: modified_ms(&meta),
                    mode: FileMode::Managed,
                    kept_by_user: Some(true),
                    target_sha256: Some(file.sha256),
                },
            ));
        }
    }

    let meta_dir = instance_dir.join(LAUNCHER_META_DIR);
    let staging_dir = meta_dir.join("staging").join(safe_tag(&manifest.version));
    let staging_files_dir = staging_dir.join("files");
    let staging_archives_dir = staging_dir.join("archives");

    let mut pending_files = Vec::new();
    let mut bytes_already_staged: u64 = 0;
    let total_bytes_files: u64 = files_to_stage.iter().map(|f| f.size).sum();

    for file in &files_to_stage {
        cancel.check()?;
        let staged = safe_join(&staging_files_dir, &file.path)?;
        let mut ready = false;
        if let Ok(meta) = tokio::fs::metadata(&staged).await {
            if meta.is_file() && meta.len() == file.size {
                if let Ok(h) = hash_file(&staged, ChecksumAlgo::Sha256, cancel).await {
                    if h == file.sha256 {
                        ready = true;
                        bytes_already_staged += file.size;
                    }
                }
            }
        }
        if !ready {
            pending_files.push(file.clone());
        }
    }

    let mut needed_archive_ids = HashSet::new();
    let mut archive_pending_files: HashMap<String, Vec<ManifestFile>> = HashMap::new();
    let mut direct_pending_files = Vec::new();

    for file in &pending_files {
        match &file.source {
            ManifestFileSource::Archive { archive, .. } => {
                needed_archive_ids.insert(archive.clone());
                archive_pending_files
                    .entry(archive.clone())
                    .or_default()
                    .push(file.clone());
            }
            ManifestFileSource::Url { .. } => {
                direct_pending_files.push(file.clone());
            }
        }
    }

    let needed_archives: Vec<_> = manifest
        .archives
        .iter()
        .filter(|a| needed_archive_ids.contains(&a.id))
        .cloned()
        .collect();
    let pending_archive_bytes: u64 = needed_archives.iter().map(|a| a.size).sum();
    let pending_direct_bytes: u64 = direct_pending_files.iter().map(|f| f.size).sum();
    let pending_extracted_bytes: u64 = pending_files.iter().map(|f| f.size).sum();
    let total_download_bytes = total_bytes_files
        .max(bytes_already_staged + pending_archive_bytes + pending_direct_bytes);

    if !pending_files.is_empty() {
        assert_free_space(
            instance_dir,
            pending_archive_bytes + pending_direct_bytes + pending_extracted_bytes,
        )
        .await?;
        ensure_dir(&staging_files_dir).await?;
        ensure_dir(&staging_archives_dir).await?;
    }

    let total_files_count = files_to_stage.len();
    let initial_done = total_files_count.saturating_sub(pending_files.len());

    #[derive(Clone)]
    struct Tracker {
        bytes_done: u64,
        files_done: usize,
        speed_bytes: u64,
        window_start: Instant,
        current_speed: u64,
        last_emit: Instant,
    }

    let tracker = Arc::new(Mutex::new(Tracker {
        bytes_done: bytes_already_staged,
        files_done: initial_done,
        speed_bytes: 0,
        window_start: Instant::now(),
        current_speed: 0,
        last_emit: Instant::now() - std::time::Duration::from_secs(1),
    }));
    let on_prog = Arc::new(on_progress);

    let emit_progress = {
        let tracker = tracker.clone();
        let on_prog = on_prog.clone();
        move |stage: Stage, label: String, delta_bytes: i64, inc_files: usize, force: bool| {
            let mut g = tracker.lock().unwrap();
            if delta_bytes >= 0 {
                let d = delta_bytes as u64;
                g.bytes_done = g.bytes_done.saturating_add(d);
                g.speed_bytes = g.speed_bytes.saturating_add(d);
            } else {
                g.bytes_done = g.bytes_done.saturating_sub((-delta_bytes) as u64);
            }
            g.files_done += inc_files;

            let now = Instant::now();
            let elapsed_ms = now.duration_since(g.window_start).as_millis() as u64;
            if elapsed_ms >= 400 {
                g.current_speed = g.speed_bytes.saturating_mul(1000) / elapsed_ms;
                g.speed_bytes = 0;
                g.window_start = now;
            }
            if force || now.duration_since(g.last_emit).as_millis() >= 120 {
                g.last_emit = now;
                let snap = SyncProgressUpdate {
                    stage,
                    label,
                    bytes_done: g.bytes_done.min(total_download_bytes),
                    bytes_total: total_download_bytes,
                    files_done: g.files_done,
                    files_total: total_files_count,
                    speed: g.current_speed,
                };
                drop(g);
                on_prog(snap);
            }
        }
    };

    if !pending_files.is_empty() {
        emit_progress(
            Stage::Download,
            "Подготовка загрузки файлов сборки".to_string(),
            0,
            0,
            true,
        );
    }

    for archive in needed_archives {
        cancel.check()?;
        let archive_path = staging_archives_dir.join(format!("{}.zip", archive.id));
        let mut archive_ready = false;
        if let Ok(meta) = tokio::fs::metadata(&archive_path).await {
            if meta.is_file() && meta.len() == archive.size {
                if let Ok(h) = hash_file(&archive_path, ChecksumAlgo::Sha256, cancel).await {
                    if h == archive.sha256 {
                        archive_ready = true;
                        emit_progress(
                            Stage::Download,
                            format!("Архив {} найден во временной папке", archive.id),
                            archive.size as i64,
                            0,
                            true,
                        );
                    }
                }
            }
        }

        if !archive_ready {
            let aid = archive.id.clone();
            let urls = [archive.url.clone()];
            download_verified(
                client,
                log,
                DownloadSpec {
                    urls: &urls,
                    dest: &archive_path,
                    expected_size: Some(archive.size),
                    expected_hash: Some((ChecksumAlgo::Sha256, &archive.sha256)),
                    policy: HostPolicy::PackAssetsOnly,
                    attempts: 4,
                },
                cancel,
                |delta| emit_progress(Stage::Download, format!("Загрузка архива {aid}"), delta, 0, false),
            )
            .await?;
        }

        let wanted = archive_pending_files.remove(&archive.id).unwrap_or_default();
        let mut spec_map = HashMap::with_capacity(wanted.len());
        for f in wanted {
            if let ManifestFileSource::Archive { entry, .. } = &f.source {
                spec_map.insert(
                    entry.clone(),
                    ZipExtractSpec {
                        target_abs_path: safe_join(&staging_files_dir, &f.path)?,
                        expected_size: f.size,
                        expected_sha256: f.sha256.clone(),
                    },
                );
            }
        }

        emit_progress(
            Stage::Extract,
            format!("Распаковка архива {}", archive.id),
            0,
            0,
            true,
        );
        let aid2 = archive.id.clone();
        let emit_cb = emit_progress.clone();
        let tracker_ref = tracker.clone();
        extract_zip_entries(&archive_path, spec_map, &staging_files_dir, cancel, move |_, _| {
            let cur = tracker_ref.lock().map(|g| g.files_done + 1).unwrap_or(1);
            emit_cb(
                Stage::Extract,
                format!("Распаковка архива {aid2} ({cur} / {total_files_count})"),
                0,
                1,
                cur == total_files_count,
            );
        })
        .await?;
    }

    if !direct_pending_files.is_empty() {
        let queue = Arc::new(Mutex::new(direct_pending_files));
        let workers_count = 4usize.min(queue.lock().unwrap().len());
        let mut set = tokio::task::JoinSet::new();

        for _ in 0..workers_count {
            let q = queue.clone();
            let c = client.clone();
            let l = log.clone();
            let sfd = staging_files_dir.clone();
            let tok = cancel.clone();
            let emit_cb = emit_progress.clone();
            let tr = tracker.clone();
            set.spawn(async move {
                loop {
                    tok.check()?;
                    let file = { q.lock().unwrap().pop() };
                    let Some(file) = file else {
                        return Ok::<(), LauncherError>(());
                    };
                    let url = match &file.source {
                        ManifestFileSource::Url { url } => url.clone(),
                        _ => continue,
                    };
                    let dest = safe_join(&sfd, &file.path)?;
                    let urls = [url];
                    download_verified(
                        &c,
                        &l,
                        DownloadSpec {
                            urls: &urls,
                            dest: &dest,
                            expected_size: Some(file.size),
                            expected_hash: Some((ChecksumAlgo::Sha256, &file.sha256)),
                            policy: HostPolicy::PackAssetsOnly,
                            attempts: 4,
                        },
                        &tok,
                        |delta| {
                            let cur = tr.lock().map(|g| g.files_done).unwrap_or(0);
                            emit_cb(
                                Stage::Download,
                                format!("Загрузка файлов ({cur} / {total_files_count})"),
                                delta,
                                0,
                                false,
                            );
                        },
                    )
                    .await?;
                    let cur = tr.lock().map(|g| g.files_done + 1).unwrap_or(1);
                    emit_cb(
                        Stage::Download,
                        format!("Загрузка файлов ({cur} / {total_files_count})"),
                        0,
                        1,
                        cur == total_files_count,
                    );
                }
            });
        }

        while let Some(res) = set.join_next().await {
            res.map_err(|e| LauncherError::new(ErrorCode::Unknown, "Ошибка загрузки", e.to_string()))??;
        }
    }

    // Финальная проверка staged-файлов
    for file in &files_to_stage {
        cancel.check()?;
        let staged = safe_join(&staging_files_dir, &file.path)?;
        let meta = tokio::fs::metadata(&staged).await.map_err(|_| {
            LauncherError::new(
                ErrorCode::Integrity,
                "Повреждённый временный файл",
                format!("Временный файл «{}» отсутствует.", file.path),
            )
        })?;
        if !meta.is_file() || meta.len() != file.size {
            return Err(LauncherError::new(
                ErrorCode::Integrity,
                "Повреждённый временный файл",
                format!("Временный файл «{}» имеет неверный размер.", file.path),
            ));
        }
        let h = hash_file(&staged, ChecksumAlgo::Sha256, cancel).await?;
        if h != file.sha256 {
            let _ = tokio::fs::remove_file(&staged).await;
            return Err(LauncherError::new(
                ErrorCode::Integrity,
                "Нарушена целостность файла",
                format!("Контрольная сумма файла «{}» не совпала с манифестом.", file.path),
            ));
        }
    }

    emit_progress(
        Stage::Apply,
        "Применение файлов сборки".to_string(),
        0,
        0,
        true,
    );

    if !backup_targets.is_empty() {
        let stamp = Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .replace([':', '.'], "-");
        let backup_root = meta_dir.join("backups").join(stamp);
        for rel in &backup_targets {
            let src = safe_join(instance_dir, rel)?;
            let dst = safe_join(&backup_root, rel)?;
            if let Some(p) = dst.parent() {
                ensure_dir(p).await?;
            }
            tokio::fs::copy(&src, &dst).await?;
            log.info(
                "updater",
                format!("Создана резервная копия {rel} -> {}", dst.display()),
            );
        }
    }

    for file in &files_to_stage {
        let src = safe_join(&staging_files_dir, &file.path)?;
        let dst = safe_join(instance_dir, &file.path)?;
        assert_real_inside(instance_dir, &dst).await?;
        if let Some(p) = dst.parent() {
            ensure_dir(p).await?;
        }
        rename_with_retry(&src, &dst).await?;
    }

    for rel in &delete_targets {
        let target = safe_join(instance_dir, rel)?;
        assert_real_inside(instance_dir, &target).await?;
        let _ = tokio::fs::remove_file(&target).await;
    }

    let kept_map: HashMap<String, ManagedFileRecord> = keep_entries
        .into_iter()
        .map(|(f, r)| (path_key(&f.path), r))
        .collect();
    let mut next_managed = HashMap::with_capacity(manifest.files.len());

    for file in &manifest.files {
        if let Some(kept) = kept_map.get(&path_key(&file.path)) {
            next_managed.insert(file.path.clone(), kept.clone());
            continue;
        }
        let abs = safe_join(instance_dir, &file.path)?;
        let meta = tokio::fs::metadata(&abs).await?;
        let eff_mode = effective_file_mode(file);
        let sha = if eff_mode == FileMode::Initial {
            hash_file(&abs, ChecksumAlgo::Sha256, cancel).await?
        } else {
            file.sha256.clone()
        };
        next_managed.insert(
            file.path.clone(),
            ManagedFileRecord {
                sha256: sha,
                size: meta.len(),
                mtime_ms: modified_ms(&meta),
                mode: eff_mode,
                kept_by_user: None,
                target_sha256: None,
            },
        );
    }

    let next_state = PackInstanceState {
        schema_version: 1,
        pack_id: manifest.pack_id.clone(),
        version: manifest.version.clone(),
        updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        managed: next_managed,
    };

    write_json_atomic(&local_manifest_path(instance_dir), manifest).await?;
    write_json_atomic(&state_file_path(instance_dir), &next_state).await?;
    remove_quiet(&staging_dir).await;

    Ok(next_state)
}
