use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{ensure_dir, read_json_file, write_json_atomic};
use crate::github::raw_url;
use crate::http::{fetch_buffer, fetch_text, is_allowed_url, sha256_text, HostPolicy};
use crate::log::AppLogger;
use crate::paths::{check_relative_path, path_key, LAUNCHER_META_DIR};
use crate::server_ping::{extract_20tps_server_from_servers_dat, is_allowed_20tps_host};
use crate::types::{
    CatalogJson, CatalogResult, Loader, ManifestArchive, ManifestFile, ManifestFileSource,
    ManifestJson, NewsItemJson, NewsItemView, NewsJson, NewsResult, PackInfoJson, PackLoadError,
    PackSourceView, PackStatus, PackView, RawManifestJson, ServerRef, Settings,
};
use base64::Engine;
use chrono::Utc;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSourceRef {
    pub repo: String,
    pub branch: String,
    pub path: String,
    pub official: bool,
    #[serde(default)]
    pub pack_id: Option<String>,
    #[serde(default)]
    pub news_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LoadedPackEntry {
    pub view: PackView,
    pub source_ref: PackSourceRef,
    pub pack_info: PackInfoJson,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateVersionPeek {
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPackMeta {
    pub schema_version: u32,
    pub pack_key: String,
    pub source_ref: PackSourceRef,
    pub pack_info: PackInfoJson,
    #[serde(default)]
    pub cover_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCacheEntry {
    #[serde(flatten)]
    view: PackView,
    source_ref: PackSourceRef,
    manifest_url: String,
    news_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCacheFile {
    loaded_at: String,
    packs: Vec<CatalogCacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoverCacheFile {
    url: String,
    #[serde(rename = "dataUrl")]
    data_url: String,
}

// Legacy launcher-index.json (abi_tfg compatibility)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyNewsItem {
    id: String,
    date: String,
    title: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    pack_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyModpackItem {
    id: String,
    name: String,
    version: String,
    minecraft_version: String,
    loader: Loader,
    #[serde(default)]
    server_address: Option<String>,
    #[serde(default)]
    background_url: Option<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default = "default_rec_mem")]
    recommended_memory_mb: u32,
    #[serde(default)]
    min_memory_mb: Option<u32>,
    manifest_url: String,
}

fn default_rec_mem() -> u32 {
    8192
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLauncherIndex {
    #[serde(default)]
    news: Vec<LegacyNewsItem>,
    modpacks: Vec<LegacyModpackItem>,
}

pub fn make_pack_key(repo: &str, pack_id: &str) -> String {
    let clean_repo: String = repo
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{clean_repo}__{pack_id}")
}

fn detect_image_mime(buf: &[u8]) -> Option<&'static str> {
    if buf.len() >= 8 && &buf[0..4] == b"\x89PNG" {
        return Some("image/png");
    }
    if buf.len() >= 3 && buf[0] == 0xff && buf[1] == 0xd8 && buf[2] == 0xff {
        return Some("image/jpeg");
    }
    if buf.len() >= 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn parse_server_address(name: &str, addr: Option<&str>) -> Option<ServerRef> {
    let raw = addr?.trim();
    if raw.is_empty() || raw.len() > 260 {
        return None;
    }
    let mut host = raw.to_string();
    let mut port = None;
    if let Some(idx) = raw.rfind(':') {
        if idx > 0 {
            if let Ok(p) = raw[idx + 1..].parse::<u16>() {
                if p >= 1 {
                    host = raw[..idx].to_string();
                    port = Some(p);
                }
            }
        }
    }
    let host_re = Regex::new(r"^[A-Za-z0-9.-]{1,253}$").unwrap();
    if !host_re.is_match(&host) {
        return None;
    }
    Some(ServerRef {
        name: name.chars().take(80).collect(),
        host,
        port,
    })
}

fn normalize_legacy_date(date_str: &str) -> String {
    let re = Regex::new(r"^(\d{2})\.(\d{2})\.(\d{4})$").unwrap();
    if let Some(caps) = re.captures(date_str) {
        return format!("{}-{}-{}", &caps[3], &caps[2], &caps[1]);
    }
    date_str.to_string()
}

pub fn validate_pack_info(p: &PackInfoJson) -> AppResult<()> {
    let id_re = Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").unwrap();
    if p.schema_version != 1 {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Неподдерживаемая версия описания сборки",
            format!("schemaVersion={}", p.schema_version),
        ));
    }
    if !id_re.is_match(&p.id) || p.name.is_empty() || p.version.is_empty() {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Некорректное описание сборки",
            "Проверьте поля id, name и version в pack.json.",
        ));
    }
    if !is_allowed_url(&p.manifest_url) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Запрещённый адрес манифеста",
            format!("manifestUrl {} должен вести на разрешённый HTTPS-хост.", p.manifest_url),
        ));
    }
    if let Some(ref cover) = p.cover {
        if cover.to_ascii_lowercase().starts_with("http") {
            if !is_allowed_url(cover) {
                return Err(LauncherError::new(
                    ErrorCode::ManifestInvalid,
                    "Запрещённый адрес обложки",
                    cover.clone(),
                ));
            }
        } else if let Some(err) = check_relative_path(cover) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Некорректный путь обложки",
                err,
            ));
        }
    }
    if let Some(err) = check_relative_path(&p.news) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Некорректный путь новостей",
            err,
        ));
    }
    Ok(())
}

pub fn parse_and_validate_manifest(raw: &str) -> AppResult<ManifestJson> {
    let parsed: RawManifestJson = serde_json::from_str(raw).map_err(|e| {
        LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Некорректный JSON манифеста",
            e.to_string(),
        )
    })?;
    if parsed.schema_version != 1 {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Неподдерживаемая версия манифеста",
            format!("schemaVersion={}", parsed.schema_version),
        ));
    }
    let sha_re = Regex::new(r"^[a-f0-9]{64}$").unwrap();
    let archive_id_re = Regex::new(r"^[A-Za-z0-9._-]{1,128}$").unwrap();

    let mut archive_ids = HashSet::new();
    let mut archives: Vec<ManifestArchive> = Vec::with_capacity(parsed.archives.len());
    for a in parsed.archives {
        if !archive_id_re.is_match(&a.id)
            || !is_allowed_url(&a.url)
            || a.size == 0
            || a.size > 2 * 1024 * 1024 * 1024
            || !sha_re.is_match(&a.sha256)
        {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Некорректная запись архива в манифесте",
                format!("Архив «{}» не прошёл проверку.", a.id),
            ));
        }
        archive_ids.insert(a.id.clone());
        archives.push(a);
    }

    let mut seen_paths = HashSet::new();
    let mut files: Vec<ManifestFile> = Vec::with_capacity(parsed.files.len());
    for rf in parsed.files {
        if let Some(err) = check_relative_path(&rf.path) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Небезопасный путь в манифесте",
                format!("Файл «{}»: {err}.", rf.path),
            ));
        }
        if !sha_re.is_match(&rf.sha256) || rf.size > 4 * 1024 * 1024 * 1024 {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Некорректные метаданные файла в манифесте",
                format!("Файл «{}» имеет неверный размер или SHA-256.", rf.path),
            ));
        }
        let source = match (rf.source, rf.url) {
            (Some(s), None) => s,
            (None, Some(u)) => ManifestFileSource::Url { url: u },
            _ => {
                return Err(LauncherError::new(
                    ErrorCode::ManifestInvalid,
                    "Некорректный источник файла",
                    format!("Файл «{}»: укажите ровно один source или url.", rf.path),
                ))
            }
        };
        match &source {
            ManifestFileSource::Url { url } => {
                if !is_allowed_url(url) {
                    return Err(LauncherError::new(
                        ErrorCode::ManifestInvalid,
                        "Запрещённый URL файла",
                        format!("Файл «{}»: {url}", rf.path),
                    ));
                }
            }
            ManifestFileSource::Archive { archive, entry } => {
                if !archive_ids.contains(archive) {
                    return Err(LauncherError::new(
                        ErrorCode::ManifestInvalid,
                        "Неизвестный архив в манифесте",
                        format!("Файл «{}» ссылается на неизвестный архив «{archive}».", rf.path),
                    ));
                }
                if let Some(err) = check_relative_path(entry) {
                    return Err(LauncherError::new(
                        ErrorCode::ManifestInvalid,
                        "Небезопасный путь entry в архиве",
                        format!("Файл «{}»: {err}", rf.path),
                    ));
                }
            }
        }
        let k = path_key(&rf.path);
        if !seen_paths.insert(k) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Дубликат пути в манифесте",
                format!("Дубликат пути «{}».", rf.path),
            ));
        }
        files.push(ManifestFile {
            path: rf.path,
            size: rf.size,
            sha256: rf.sha256,
            mode: rf.mode,
            required: rf.required,
            source,
        });
    }

    // Конфликт файл/каталог
    for f in &files {
        let parts: Vec<&str> = f.path.split('/').collect();
        for i in 1..parts.len() {
            let parent_key = path_key(&parts[..i].join("/"));
            if seen_paths.contains(&parent_key) {
                return Err(LauncherError::new(
                    ErrorCode::ManifestInvalid,
                    "Конфликт пути и папки в манифесте",
                    format!("Путь «{}» конфликтует с файлом-родителем.", f.path),
                ));
            }
        }
    }

    Ok(ManifestJson {
        schema_version: parsed.schema_version,
        pack_id: parsed.pack_id,
        version: parsed.version,
        created_at: parsed.created_at,
        minecraft: parsed.minecraft,
        loader: parsed.loader,
        java: parsed.java,
        archives,
        files,
    })
}

pub async fn read_installed_pack_version(install_dir: &str, pack_key: &str) -> Option<String> {
    let state_path = Path::new(install_dir)
        .join("instances")
        .join(pack_key)
        .join(LAUNCHER_META_DIR)
        .join("state.json");
    let peek: Option<StateVersionPeek> = read_json_file(&state_path).await.ok().flatten();
    peek.and_then(|s| s.version).filter(|v| !v.is_empty())
}

pub async fn save_local_pack_meta(instance_dir: &Path, meta: &LocalPackMeta) -> AppResult<()> {
    let meta_dir = instance_dir.join(LAUNCHER_META_DIR);
    ensure_dir(&meta_dir).await?;
    write_json_atomic(&meta_dir.join("pack.json"), meta).await
}

pub struct CatalogService {
    user_data_dir: PathBuf,
    http: Client,
    log: AppLogger,
    loaded: HashMap<String, LoadedPackEntry>,
}

impl CatalogService {
    pub fn new(user_data_dir: PathBuf, http: Client, log: AppLogger) -> Self {
        Self {
            user_data_dir,
            http,
            log,
            loaded: HashMap::new(),
        }
    }

    pub fn get_entry(&self, pack_key: &str) -> Option<&LoadedPackEntry> {
        self.loaded.get(pack_key)
    }

    pub fn get_entry_mut(&mut self, pack_key: &str) -> Option<&mut LoadedPackEntry> {
        self.loaded.get_mut(pack_key)
    }

    pub fn all_entries(&self) -> Vec<LoadedPackEntry> {
        self.loaded.values().cloned().collect()
    }

    pub async fn load_catalog(
        &mut self,
        settings: &Settings,
        cancel: &CancelToken,
    ) -> AppResult<CatalogResult> {
        let cache_dir = self.user_data_dir.join("cache");
        let cache_path = cache_dir.join("catalog-cache.json");
        let mut sources: Vec<PackSourceRef> = Vec::new();
        let mut seen_source = HashSet::new();
        let mut catalog_error: Option<String> = None;

        let mut push_source = |src: PackSourceRef| {
            let k = format!("{}::{}::{}", src.repo.to_lowercase(), src.branch, src.path);
            if seen_source.insert(k) {
                sources.push(src);
            }
        };

        if !settings.catalog_url.trim().is_empty() {
            match fetch_text(
                &self.http,
                settings.catalog_url.trim(),
                HostPolicy::PackAssetsOnly,
                8 * 1024 * 1024,
                Duration::from_secs(20),
                None,
                cancel,
            )
            .await
            {
                Ok(raw) => match serde_json::from_str::<CatalogJson>(&raw) {
                    Ok(cat) if cat.schema_version == 1 => {
                        for entry in cat.packs {
                            push_source(PackSourceRef {
                                repo: entry.repo,
                                branch: entry.branch,
                                path: entry.path,
                                official: true,
                                pack_id: None,
                                news_path: None,
                            });
                        }
                    }
                    Ok(_) => {
                        catalog_error = Some("Неподдерживаемая версия catalog.json.".to_string());
                    }
                    Err(e) => {
                        catalog_error = Some(format!("Некорректный каталог сборок: {e}"));
                    }
                },
                Err(e) => {
                    if e.is_cancelled() {
                        return Err(e);
                    }
                    catalog_error = Some(e.to_string());
                    self.log
                        .warn("catalog", format!("Не удалось загрузить официальный каталог: {e}"));
                }
            }
        }

        for custom in &settings.custom_repos {
            push_source(PackSourceRef {
                repo: custom.repo.clone(),
                branch: custom.branch.clone(),
                path: custom.path.clone(),
                official: false,
                pack_id: None,
                news_path: None,
            });
        }

        let mut errors = Vec::new();
        let mut packs = Vec::new();
        let mut cache_entries = Vec::new();
        let mut seen_keys = HashSet::new();
        let mut new_loaded = HashMap::new();

        for src in sources {
            match self.fetch_pack_infos_from_repo(&src, cancel).await {
                Ok(infos) => {
                    for info in infos {
                        let pack_key = make_pack_key(&src.repo, &info.id);
                        if !seen_keys.insert(pack_key.clone()) {
                            continue;
                        }
                        let installed_version =
                            read_installed_pack_version(&settings.install_dir, &pack_key).await;
                        let inst_dir = Path::new(&settings.install_dir)
                            .join("instances")
                            .join(&pack_key);
                        let cover_data_url = self
                            .load_cover_data_url(&src, info.cover.as_deref(), &cache_dir, cancel)
                            .await;
                        let resolved_server = self
                            .resolve_pack_server(&src, &inst_dir, &info, cancel)
                            .await;
                        let status = match &installed_version {
                            None => PackStatus::NotInstalled,
                            Some(v) if v == &info.version => PackStatus::Ready,
                            Some(_) => PackStatus::UpdateAvailable,
                        };
                        let source_ref = PackSourceRef {
                            repo: src.repo.clone(),
                            branch: src.branch.clone(),
                            path: src.path.clone(),
                            official: src.official,
                            pack_id: Some(info.id.clone()),
                            news_path: Some(info.news.clone()),
                        };
                        let mut info = info;
                        info.server = resolved_server.clone();
                        let view = PackView {
                            key: pack_key.clone(),
                            id: info.id.clone(),
                            source: PackSourceView {
                                repo: src.repo.clone(),
                                branch: src.branch.clone(),
                                official: src.official,
                            },
                            name: info.name.clone(),
                            summary: info.summary.clone(),
                            description: info.description.clone(),
                            cover_data_url,
                            version: info.version.clone(),
                            minecraft: info.minecraft.clone(),
                            loader: info.loader.clone(),
                            recommended_memory_mb: info.recommended_memory_mb,
                            min_memory_mb: info.min_memory_mb,
                            server: resolved_server,
                            installed_version: installed_version.clone(),
                            status,
                            last_error: None,
                            conflicts: Vec::new(),
                            warnings: Vec::new(),
                        };

                        if installed_version.is_some() {
                            let _ = save_local_pack_meta(
                                &inst_dir,
                                &LocalPackMeta {
                                    schema_version: 1,
                                    pack_key: pack_key.clone(),
                                    source_ref: source_ref.clone(),
                                    pack_info: info.clone(),
                                    cover_data_url: view.cover_data_url.clone(),
                                },
                            )
                            .await;
                        }

                        cache_entries.push(CatalogCacheEntry {
                            view: view.clone(),
                            source_ref: source_ref.clone(),
                            manifest_url: info.manifest_url.clone(),
                            news_path: info.news.clone(),
                        });
                        new_loaded.insert(
                            pack_key,
                            LoadedPackEntry {
                                view: view.clone(),
                                source_ref,
                                pack_info: info,
                            },
                        );
                        packs.push(view);
                    }
                }
                Err(e) => {
                    if e.is_cancelled() {
                        return Err(e);
                    }
                    self.log
                        .warn("catalog", format!("Ошибка загрузки сборки из {}: {e}", src.repo));
                    errors.push(PackLoadError {
                        repo: src.repo,
                        message: e.to_string(),
                    });
                }
            }
        }

        let loaded_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        if packs.is_empty() && (catalog_error.is_some() || !errors.is_empty()) {
            let mut restored = Vec::new();
            let mut restored_keys = HashSet::new();
            let cached: Option<CatalogCacheFile> =
                read_json_file(&cache_path).await.ok().flatten();
            let cached_loaded_at = cached.as_ref().map(|c| c.loaded_at.clone());

            if let Some(c) = cached {
                for item in c.packs {
                    let installed =
                        read_installed_pack_version(&settings.install_dir, &item.view.key).await;
                    let mut view = item.view;
                    let inst_dir = Path::new(&settings.install_dir)
                        .join("instances")
                        .join(&view.key);
                    let local_srv = read_local_servers_dat_20tps(&inst_dir).await;
                    view.server = local_srv.or_else(|| filter_server_20tps(view.server.take()));
                    view.installed_version = installed.clone();
                    view.status = if installed.is_some() {
                        PackStatus::Ready
                    } else {
                        PackStatus::NotInstalled
                    };
                    view.last_error = None;
                    view.conflicts.clear();
                    view.warnings.clear();

                    let info = PackInfoJson {
                        schema_version: 1,
                        id: view.id.clone(),
                        name: view.name.clone(),
                        summary: view.summary.clone(),
                        description: view.description.clone(),
                        cover: None,
                        version: view.version.clone(),
                        minecraft: view.minecraft.clone(),
                        loader: view.loader.clone(),
                        recommended_memory_mb: view.recommended_memory_mb,
                        min_memory_mb: view.min_memory_mb,
                        manifest_url: item.manifest_url,
                        server: view.server.clone(),
                        news: item.news_path,
                    };
                    restored_keys.insert(view.key.clone());
                    new_loaded.insert(
                        view.key.clone(),
                        LoadedPackEntry {
                            view: view.clone(),
                            source_ref: item.source_ref,
                            pack_info: info,
                        },
                    );
                    restored.push(view);
                }
            }

            for local in scan_local_installed_packs(&settings.install_dir).await {
                if restored_keys.insert(local.view.key.clone()) {
                    restored.push(local.view.clone());
                    new_loaded.insert(local.view.key.clone(), local);
                }
            }

            if !restored.is_empty() {
                self.loaded = new_loaded;
                return Ok(CatalogResult {
                    packs: restored,
                    errors,
                    from_cache: true,
                    catalog_error: Some(catalog_error.unwrap_or_else(|| {
                        "GitHub недоступен. Показаны сохранённые сборки — установленные сборки доступны для запуска в офлайн-режиме.".to_string()
                    })),
                    loaded_at: cached_loaded_at.unwrap_or(loaded_at),
                });
            }
        }

        if !cache_entries.is_empty() {
            let _ = ensure_dir(&cache_dir).await;
            let _ = write_json_atomic(
                &cache_path,
                &CatalogCacheFile {
                    loaded_at: loaded_at.clone(),
                    packs: cache_entries,
                },
            )
            .await;
        }

        self.loaded = new_loaded;
        Ok(CatalogResult {
            packs,
            errors,
            from_cache: false,
            catalog_error,
            loaded_at,
        })
    }

    async fn fetch_pack_infos_from_repo(
        &self,
        src: &PackSourceRef,
        cancel: &CancelToken,
    ) -> AppResult<Vec<PackInfoJson>> {
        let candidates: Vec<&str> = match src.path.as_str() {
            "ForLauncher/pack.json" => {
                vec!["ForLauncher/pack.json", "launcher/pack.json", "launcher-index.json"]
            }
            "launcher/pack.json" => {
                vec!["launcher/pack.json", "ForLauncher/pack.json", "launcher-index.json"]
            }
            other => vec![other],
        };

        let mut last_err: Option<LauncherError> = None;
        for (idx, cand) in candidates.iter().enumerate() {
            let url = raw_url(&src.repo, &src.branch, cand)?;
            match fetch_text(
                &self.http,
                &url,
                HostPolicy::PackAssetsOnly,
                8 * 1024 * 1024,
                Duration::from_secs(20),
                None,
                cancel,
            )
            .await
            {
                Ok(raw) => {
                    if cand.ends_with("launcher-index.json") {
                        let legacy: LegacyLauncherIndex =
                            serde_json::from_str(&raw).map_err(|e| {
                                LauncherError::new(
                                    ErrorCode::ManifestInvalid,
                                    "Ошибка индекса сборки",
                                    e.to_string(),
                                )
                            })?;
                        return legacy_to_pack_infos(legacy);
                    }
                    if let Ok(info) = serde_json::from_str::<PackInfoJson>(&raw) {
                        validate_pack_info(&info)?;
                        return Ok(vec![info]);
                    }
                    if let Ok(legacy) = serde_json::from_str::<LegacyLauncherIndex>(&raw) {
                        return legacy_to_pack_infos(legacy);
                    }
                    return Err(LauncherError::new(
                        ErrorCode::ManifestInvalid,
                        "Ошибка описания сборки",
                        format!("Файл {url} не соответствует формату pack.json."),
                    ));
                }
                Err(e) => {
                    let is_404 = e.code == ErrorCode::GithubUnavailable && e.message.contains("(404)");
                    last_err = Some(e);
                    if is_404 && idx + 1 < candidates.len() {
                        continue;
                    }
                    return Err(last_err.unwrap());
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            LauncherError::new(ErrorCode::GithubUnavailable, "Не найден pack.json", src.repo.clone())
        }))
    }

    async fn load_cover_data_url(
        &self,
        src: &PackSourceRef,
        cover: Option<&str>,
        cache_dir: &Path,
        cancel: &CancelToken,
    ) -> Option<String> {
        let cover = cover?;
        let cover_url = if cover.to_ascii_lowercase().starts_with("http") {
            cover.to_string()
        } else {
            raw_url(&src.repo, &src.branch, cover).ok()?
        };
        let cache_file = cache_dir
            .join("covers")
            .join(format!("{}.txt", sha256_text(&cover_url)));

        match fetch_buffer(
            &self.http,
            &cover_url,
            HostPolicy::PackAssetsOnly,
            5 * 1024 * 1024,
            Duration::from_secs(15),
            cancel,
        )
        .await
        {
            Ok(data) => {
                let mime = detect_image_mime(&data)?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let data_url = format!("data:{mime};base64,{b64}");
                let _ = ensure_dir(&cache_dir.join("covers")).await;
                let _ = write_json_atomic(
                    &cache_file,
                    &CoverCacheFile {
                        url: cover_url,
                        data_url: data_url.clone(),
                    },
                )
                .await;
                Some(data_url)
            }
            Err(_) => {
                let cached: Option<CoverCacheFile> =
                    read_json_file(&cache_file).await.ok().flatten();
                cached.map(|c| c.data_url)
            }
        }
    }

    pub async fn resolve_pack_server(
        &self,
        src: &PackSourceRef,
        inst_dir: &Path,
        pack_info: &PackInfoJson,
        cancel: &CancelToken,
    ) -> Option<ServerRef> {
        if let Some(local) = read_local_servers_dat_20tps(inst_dir).await {
            return Some(local);
        }

        if let Ok(raw_srv_url) = raw_url(&src.repo, &src.branch, "servers.dat") {
            let cache_file = self
                .user_data_dir
                .join("cache")
                .join("servers")
                .join(format!("{}.dat", sha256_text(&raw_srv_url)));
            match fetch_buffer(
                &self.http,
                &raw_srv_url,
                HostPolicy::PackAssetsOnly,
                8 * 1024 * 1024,
                Duration::from_secs(12),
                cancel,
            )
            .await
            {
                Ok(bytes) => {
                    if let Some(parsed) = extract_20tps_server_from_servers_dat(&bytes) {
                        if let Some(parent) = cache_file.parent() {
                            let _ = ensure_dir(parent).await;
                        }
                        let _ = tokio::fs::write(&cache_file, &bytes).await;
                        return Some(parsed);
                    }
                }
                Err(_) => {
                    if let Ok(cached_bytes) = tokio::fs::read(&cache_file).await {
                        if let Some(parsed) = extract_20tps_server_from_servers_dat(&cached_bytes) {
                            return Some(parsed);
                        }
                    }
                }
            }
        }

        filter_server_20tps(pack_info.server.clone())
    }

    pub async fn fetch_pack_info(
        &self,
        src: &PackSourceRef,
        cancel: &CancelToken,
    ) -> AppResult<PackInfoJson> {
        let infos = self.fetch_pack_infos_from_repo(src, cancel).await?;
        match &src.pack_id {
            Some(id) => infos.into_iter().find(|i| &i.id == id),
            None => infos.into_iter().next(),
        }
        .ok_or_else(|| {
            LauncherError::new(
                ErrorCode::PackMismatch,
                "Сборка не найдена в репозитории",
                format!(
                    "В репозитории {} не найдена сборка «{}».",
                    src.repo,
                    src.pack_id.as_deref().unwrap_or("")
                ),
            )
        })
    }

    pub async fn fetch_pack_and_manifest(
        &self,
        src: &PackSourceRef,
        cancel: &CancelToken,
    ) -> AppResult<(PackInfoJson, ManifestJson)> {
        let pack = self.fetch_pack_info(src, cancel).await?;

        let raw_manifest = fetch_text(
            &self.http,
            &pack.manifest_url,
            HostPolicy::PackAssetsOnly,
            64 * 1024 * 1024,
            Duration::from_secs(30),
            None,
            cancel,
        )
        .await?;
        let manifest = parse_and_validate_manifest(&raw_manifest)?;

        if manifest.pack_id != pack.id {
            return Err(LauncherError::new(
                ErrorCode::PackMismatch,
                "Несовпадение сборки и манифеста",
                format!(
                    "Манифест относится к сборке «{}», а ожидалась «{}».",
                    manifest.pack_id, pack.id
                ),
            ));
        }
        if manifest.minecraft != pack.minecraft || !loaders_same_type(&manifest.loader, &pack.loader) {
            return Err(LauncherError::new(
                ErrorCode::PackMismatch,
                "Несовпадение параметров сборки",
                format!(
                    "Манифест описывает Minecraft {}, а в описании указано {}.",
                    manifest.minecraft, pack.minecraft
                ),
            ));
        }
        if manifest.loader != pack.loader {
            return Err(LauncherError::new(
                ErrorCode::PackMismatch,
                "Несовпадение версии загрузчика",
                "Версия модлоадера в манифесте отличается от описания сборки.",
            ));
        }

        Ok((pack, manifest))
    }

    pub async fn load_news(&self, cancel: &CancelToken) -> AppResult<NewsResult> {
        let entries = self.all_entries();
        let mut items = Vec::new();
        let mut errors = Vec::new();
        let mut loaded_sources: HashMap<String, NewsJson> = HashMap::new();

        for entry in entries {
            let news_rel = entry
                .source_ref
                .news_path
                .clone()
                .unwrap_or_else(|| entry.pack_info.news.clone());
            let cache_key = format!(
                "{}::{}::{}",
                entry.source_ref.repo, entry.source_ref.branch, news_rel
            );

            let news_data = if let Some(cached) = loaded_sources.get(&cache_key) {
                cached.clone()
            } else {
                let candidates: Vec<&str> = match news_rel.as_str() {
                    "ForLauncher/news.json" => {
                        vec!["ForLauncher/news.json", "launcher/news.json", "launcher-index.json"]
                    }
                    "launcher/news.json" => {
                        vec!["launcher/news.json", "ForLauncher/news.json", "launcher-index.json"]
                    }
                    other => vec![other],
                };
                let mut found: Option<NewsJson> = None;
                let mut non404_err: Option<LauncherError> = None;

                for cand in candidates {
                    let Ok(url) = raw_url(&entry.source_ref.repo, &entry.source_ref.branch, cand) else {
                        continue;
                    };
                    match fetch_text(
                        &self.http,
                        &url,
                        HostPolicy::PackAssetsOnly,
                        4 * 1024 * 1024,
                        Duration::from_secs(15),
                        None,
                        cancel,
                    )
                    .await
                    {
                        Ok(raw) => {
                            if cand == "launcher-index.json" {
                                if let Ok(legacy) = serde_json::from_str::<LegacyLauncherIndex>(&raw) {
                                    found = Some(legacy_to_news(legacy));
                                    break;
                                }
                            } else if let Ok(n) = serde_json::from_str::<NewsJson>(&raw) {
                                found = Some(n);
                                break;
                            } else if let Ok(legacy) = serde_json::from_str::<LegacyLauncherIndex>(&raw) {
                                found = Some(legacy_to_news(legacy));
                                break;
                            } else {
                                non404_err = Some(LauncherError::new(
                                    ErrorCode::ManifestInvalid,
                                    "Ошибка формата новостей",
                                    url,
                                ));
                                break;
                            }
                        }
                        Err(e) => {
                            if e.is_cancelled() {
                                return Err(e);
                            }
                            if e.code == ErrorCode::GithubUnavailable && e.message.contains("(404)") {
                                continue;
                            }
                            non404_err = Some(e);
                            break;
                        }
                    }
                }
                match found {
                    Some(data) => {
                        loaded_sources.insert(cache_key, data.clone());
                        data
                    }
                    None => {
                        if let Some(err) = non404_err {
                            errors.push(PackLoadError {
                                repo: entry.source_ref.repo,
                                message: err.to_string(),
                            });
                        }
                        continue;
                    }
                }
            };

            for n in news_data.items {
                items.push(NewsItemView {
                    id: format!("{}:{}", entry.view.key, n.id),
                    date: n.date,
                    title: n.title,
                    body: n.body,
                    pack_version: n.pack_version,
                    pack_key: entry.view.key.clone(),
                    pack_name: entry.view.name.clone(),
                });
            }
        }

        items.sort_by(|a, b| b.date.cmp(&a.date));
        Ok(NewsResult { items, errors })
    }
}

fn loaders_same_type(a: &Loader, b: &Loader) -> bool {
    matches!(
        (a, b),
        (Loader::Vanilla, Loader::Vanilla)
            | (Loader::Fabric { .. }, Loader::Fabric { .. })
            | (Loader::Forge { .. }, Loader::Forge { .. })
            | (Loader::Neoforge { .. }, Loader::Neoforge { .. })
    )
}

fn legacy_to_pack_infos(index: LegacyLauncherIndex) -> AppResult<Vec<PackInfoJson>> {
    let mut out = Vec::new();
    for m in index.modpacks {
        let summary = m.summary.unwrap_or_else(|| {
            if m.description.chars().count() > 160 {
                let s: String = m.description.chars().take(157).collect();
                format!("{s}...")
            } else {
                m.description.clone()
            }
        });
        let info = PackInfoJson {
            schema_version: 1,
            id: m.id,
            name: m.name.clone(),
            summary,
            description: m.description,
            cover: m.background_url,
            version: m.version,
            minecraft: m.minecraft_version,
            loader: m.loader,
            recommended_memory_mb: m.recommended_memory_mb,
            min_memory_mb: m.min_memory_mb,
            manifest_url: m.manifest_url,
            server: filter_server_20tps(parse_server_address(&m.name, m.server_address.as_deref())),
            news: "launcher-index.json".to_string(),
        };
        validate_pack_info(&info)?;
        out.push(info);
    }
    Ok(out)
}

fn legacy_to_news(index: LegacyLauncherIndex) -> NewsJson {
    NewsJson {
        schema_version: 1,
        items: index
            .news
            .into_iter()
            .map(|n| NewsItemJson {
                id: n.id,
                date: normalize_legacy_date(&n.date),
                title: n.title,
                body: n.body.or(n.content).unwrap_or_default(),
                pack_version: n.pack_version,
            })
            .collect(),
    }
}

async fn scan_local_installed_packs(install_dir: &str) -> Vec<LoadedPackEntry> {
    let instances_root = Path::new(install_dir).join("instances");
    let Ok(mut rd) = tokio::fs::read_dir(&instances_root).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(entry)) = rd.next_entry().await {
        let Ok(ft) = entry.file_type().await else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let pack_key = entry.file_name().to_string_lossy().into_owned();
        let Some(installed_version) = read_installed_pack_version(install_dir, &pack_key).await else {
            continue;
        };
        let meta_path = instances_root
            .join(&pack_key)
            .join(LAUNCHER_META_DIR)
            .join("pack.json");
        let Ok(Some(meta)) = read_json_file::<LocalPackMeta>(&meta_path).await else {
            continue;
        };
        if meta.schema_version != 1 || validate_pack_info(&meta.pack_info).is_err() {
            continue;
        }
        let inst_dir = instances_root.join(&pack_key);
        let mut info = meta.pack_info;
        let resolved_srv = read_local_servers_dat_20tps(&inst_dir)
            .await
            .or_else(|| filter_server_20tps(info.server.clone()));
        info.server = resolved_srv.clone();
        let view = PackView {
            key: pack_key,
            id: info.id.clone(),
            source: PackSourceView {
                repo: meta.source_ref.repo.clone(),
                branch: meta.source_ref.branch.clone(),
                official: meta.source_ref.official,
            },
            name: info.name.clone(),
            summary: info.summary.clone(),
            description: info.description.clone(),
            cover_data_url: meta.cover_data_url,
            version: installed_version.clone(),
            minecraft: info.minecraft.clone(),
            loader: info.loader.clone(),
            recommended_memory_mb: info.recommended_memory_mb,
            min_memory_mb: info.min_memory_mb,
            server: resolved_srv,
            installed_version: Some(installed_version),
            status: PackStatus::Ready,
            last_error: None,
            conflicts: Vec::new(),
            warnings: Vec::new(),
        };
        out.push(LoadedPackEntry {
            view,
            source_ref: meta.source_ref,
            pack_info: info,
        });
    }
    out
}

pub fn filter_server_20tps(srv: Option<ServerRef>) -> Option<ServerRef> {
    srv.and_then(|mut s| {
        let host = s.host.trim().trim_end_matches('.').to_string();
        if is_allowed_20tps_host(&host) {
            s.host = host;
            Some(s)
        } else {
            None
        }
    })
}

pub async fn read_local_servers_dat_20tps(inst_dir: &Path) -> Option<ServerRef> {
    let bytes = tokio::fs::read(inst_dir.join("servers.dat")).await.ok()?;
    extract_20tps_server_from_servers_dat(&bytes)
}
