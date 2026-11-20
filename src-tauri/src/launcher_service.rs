use crate::catalog_service::{
    read_installed_pack_version, save_local_pack_meta, CatalogService, LoadedPackEntry,
    LocalPackMeta, PackSourceRef,
};
use crate::diagnostics::build_diagnostics_report;
use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::ensure_dir;
use crate::game_launcher::{find_latest_crash_report, launch_game};
use crate::github::parse_repo_input;
use crate::http::{build_http_client, HostPolicy};
use crate::java_manager::{discover_java_installations, probe_java_executable};
use crate::log::AppLogger;
use crate::minecraft_installer::{ensure_minecraft_and_loader, PreparedRuntime};
use crate::pack_updater::{
    apply_pack_sync, plan_pack_sync, read_local_manifest, read_pack_state, SyncProgressUpdate,
};
use crate::paths::{check_relative_path, LAUNCHER_META_DIR};
use crate::server_ping::ping_minecraft_server;
use crate::storage::{compute_default_memory_mb, total_system_memory_mb, ProfileStore, SettingsStore};
use crate::types::{
    AppInfo, CatalogResult, ConflictChoice, CrashReportView, CustomRepo, GameEvent, JavaInfoView,
    ManifestJson, NewsResult, PackAddonCategory, PackAddonItem, PackAddonSource, PackBackupItem,
    PackContentView, PackInfoJson, PackStateEvent, PackStatus, PackView, PlayOptions, Profile,
    ProfilesState, ProgressEvent, ServerStatus, Settings, SettingsPatch, Stage,
};
use reqwest::Client;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;

type ProgressEmitter = Arc<dyn Fn(ProgressEvent) + Send + Sync>;
type StateEmitter = Arc<dyn Fn(PackStateEvent) + Send + Sync>;
type GameEmitter = Arc<dyn Fn(GameEvent) + Send + Sync>;

struct ActiveOpGuard {
    ops: Arc<StdMutex<HashMap<String, CancelToken>>>,
    key: String,
}

impl Drop for ActiveOpGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = self.ops.lock() {
            g.remove(&self.key);
        }
    }
}

#[derive(Clone)]
pub struct LauncherService {
    user_data_dir: PathBuf,
    launcher_version: String,
    http: Client,
    log: AppLogger,
    settings_store: Arc<SettingsStore>,
    profile_store: Arc<ProfileStore>,
    catalog: Arc<Mutex<CatalogService>>,
    active_ops: Arc<StdMutex<HashMap<String, CancelToken>>>,
    running_packs: Arc<StdMutex<HashSet<String>>>,
    progress_emitter: Arc<StdMutex<Option<ProgressEmitter>>>,
    state_emitter: Arc<StdMutex<Option<StateEmitter>>>,
    game_emitter: Arc<StdMutex<Option<GameEmitter>>>,
}

impl LauncherService {
    pub fn new(user_data_dir: PathBuf, launcher_version: String, log: AppLogger) -> Self {
        let http = build_http_client();
        let catalog = CatalogService::new(user_data_dir.clone(), http.clone(), log.clone());
        Self {
            settings_store: Arc::new(SettingsStore::new(user_data_dir.clone())),
            profile_store: Arc::new(ProfileStore::new(user_data_dir.clone())),
            catalog: Arc::new(Mutex::new(catalog)),
            user_data_dir,
            launcher_version,
            http,
            log,
            active_ops: Arc::new(StdMutex::new(HashMap::new())),
            running_packs: Arc::new(StdMutex::new(HashSet::new())),
            progress_emitter: Arc::new(StdMutex::new(None)),
            state_emitter: Arc::new(StdMutex::new(None)),
            game_emitter: Arc::new(StdMutex::new(None)),
        }
    }

    pub fn http_client(&self) -> &Client {
        &self.http
    }

    pub fn log(&self) -> &AppLogger {
        &self.log
    }

    pub fn user_data_dir(&self) -> &Path {
        &self.user_data_dir
    }

    pub fn set_progress_emitter<F>(&self, f: F)
    where
        F: Fn(ProgressEvent) + Send + Sync + 'static,
    {
        if let Ok(mut g) = self.progress_emitter.lock() {
            *g = Some(Arc::new(f));
        }
    }

    pub fn set_state_emitter<F>(&self, f: F)
    where
        F: Fn(PackStateEvent) + Send + Sync + 'static,
    {
        if let Ok(mut g) = self.state_emitter.lock() {
            *g = Some(Arc::new(f));
        }
    }

    pub fn set_game_emitter<F>(&self, f: F)
    where
        F: Fn(GameEvent) + Send + Sync + 'static,
    {
        if let Ok(mut g) = self.game_emitter.lock() {
            *g = Some(Arc::new(f));
        }
    }

    fn emit_progress(&self, ev: ProgressEvent) {
        if let Ok(g) = self.progress_emitter.lock() {
            if let Some(ref f) = *g {
                f(ev);
            }
        }
    }

    fn emit_state(&self, ev: PackStateEvent) {
        if let Ok(g) = self.state_emitter.lock() {
            if let Some(ref f) = *g {
                f(ev);
            }
        }
    }

    fn emit_game(&self, ev: GameEvent) {
        if let Ok(g) = self.game_emitter.lock() {
            if let Some(ref f) = *g {
                f(ev);
            }
        }
    }

    fn acquire_op(&self, pack_key: &str) -> AppResult<(CancelToken, ActiveOpGuard)> {
        if self
            .running_packs
            .lock()
            .is_ok_and(|g| g.contains(pack_key))
        {
            return Err(LauncherError::new(
                ErrorCode::Busy,
                "Игра уже запущена",
                "Дождитесь завершения игры, прежде чем проверять или обновлять эту сборку.",
            ));
        }
        let mut ops = self.active_ops.lock().map_err(|_| {
            LauncherError::new(ErrorCode::Unknown, "Внутренняя ошибка блокировки", "")
        })?;
        if ops.contains_key(pack_key) {
            return Err(LauncherError::new(
                ErrorCode::Busy,
                "Операция уже выполняется",
                "Дождитесь завершения текущей операции или нажмите «Отменить».",
            ));
        }
        let tok = CancelToken::new();
        ops.insert(pack_key.to_string(), tok.clone());
        Ok((
            tok,
            ActiveOpGuard {
                ops: Arc::clone(&self.active_ops),
                key: pack_key.to_string(),
            },
        ))
    }

    pub fn cancel_operation(&self, pack_key: &str) -> bool {
        if let Ok(ops) = self.active_ops.lock() {
            if let Some(tok) = ops.get(pack_key) {
                tok.abort();
                return true;
            }
        }
        false
    }

    pub async fn get_app_info(&self) -> AppInfo {
        AppInfo {
            version: self.launcher_version.clone(),
            electron: "Tauri 2".to_string(),
            node: "Rust".to_string(),
            platform: if cfg!(windows) {
                "win32".to_string()
            } else if cfg!(target_os = "macos") {
                "darwin".to_string()
            } else {
                "linux".to_string()
            },
            arch: if cfg!(target_arch = "x86_64") {
                "x64".to_string()
            } else if cfg!(target_arch = "aarch64") {
                "arm64".to_string()
            } else {
                std::env::consts::ARCH.to_string()
            },
            total_memory_mb: total_system_memory_mb(),
            user_data_dir: self.user_data_dir.to_string_lossy().into_owned(),
            default_install_dir: self
                .user_data_dir
                .join("gamedata")
                .to_string_lossy()
                .into_owned(),
        }
    }

    pub async fn get_settings(&self) -> AppResult<Settings> {
        self.settings_store.load().await
    }

    pub async fn update_settings(&self, patch: SettingsPatch) -> AppResult<Settings> {
        self.settings_store.update(patch).await
    }

    pub async fn get_profiles(&self) -> AppResult<ProfilesState> {
        self.profile_store.load().await
    }

    pub async fn create_profile(&self, name: &str) -> AppResult<ProfilesState> {
        self.profile_store.create_profile(name).await
    }

    pub async fn rename_profile(&self, id: &str, name: &str) -> AppResult<ProfilesState> {
        self.profile_store.rename_profile(id, name).await
    }

    pub async fn delete_profile(&self, id: &str) -> AppResult<ProfilesState> {
        self.profile_store.delete_profile(id).await
    }

    pub async fn select_profile(&self, id: &str) -> AppResult<ProfilesState> {
        self.profile_store.select_profile(id).await
    }

    pub async fn load_catalog(&self) -> AppResult<CatalogResult> {
        let settings = self.settings_store.load().await?;
        let cancel = CancelToken::new();
        let mut cat = self.catalog.lock().await;
        let mut res = cat.load_catalog(&settings, &cancel).await?;

        let running_snap: HashSet<String> = self
            .running_packs
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        for p in &mut res.packs {
            if running_snap.contains(&p.key) {
                p.status = PackStatus::Running;
            }
        }
        Ok(res)
    }

    pub async fn add_custom_repo(
        &self,
        repo_input: &str,
        branch: Option<&str>,
    ) -> AppResult<Settings> {
        let parsed = parse_repo_input(repo_input, branch)?;
        let cur = self.settings_store.load().await?;
        let mut repos: Vec<CustomRepo> = cur
            .custom_repos
            .into_iter()
            .filter(|r| !r.repo.eq_ignore_ascii_case(&parsed.repo))
            .collect();
        repos.push(parsed);
        self.settings_store
            .update(SettingsPatch {
                theme: None,
                install_dir: None,
                catalog_url: None,
                custom_repos: Some(repos),
                default_memory_mb: None,
                java_path: None,
                resolution: None,
                after_launch: None,
                full_verify_on_launch: None,
                auto_join_server: None,
                extra_jvm_args: None,
                auto_check_launcher_updates: None,
                pack_overrides: None,
            })
            .await
    }

    pub async fn remove_custom_repo(&self, repo: &str) -> AppResult<Settings> {
        let cur = self.settings_store.load().await?;
        let repos: Vec<CustomRepo> = cur
            .custom_repos
            .into_iter()
            .filter(|r| !r.repo.eq_ignore_ascii_case(repo))
            .collect();
        self.settings_store
            .update(SettingsPatch {
                theme: None,
                install_dir: None,
                catalog_url: None,
                custom_repos: Some(repos),
                default_memory_mb: None,
                java_path: None,
                resolution: None,
                after_launch: None,
                full_verify_on_launch: None,
                auto_join_server: None,
                extra_jvm_args: None,
                auto_check_launcher_updates: None,
                pack_overrides: None,
            })
            .await
    }

    pub async fn instance_dir_for_pack(&self, pack_key: &str) -> AppResult<PathBuf> {
        if check_relative_path(pack_key).is_some() || pack_key.contains('/') {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Некорректный идентификатор сборки",
                pack_key.to_string(),
            ));
        }
        let settings = self.settings_store.load().await?;
        Ok(Path::new(&settings.install_dir)
            .join("instances")
            .join(pack_key))
    }

    async fn get_loaded_entry(&self, pack_key: &str) -> AppResult<LoadedPackEntry> {
        let cat = self.catalog.lock().await;
        cat.get_entry(pack_key).cloned().ok_or_else(|| {
            LauncherError::new(
                ErrorCode::PackMismatch,
                "Сборка не найдена",
                format!("Сборка «{pack_key}» не загружена в каталоге. Обновите список сборок."),
            )
        })
    }

    async fn update_cached_view(&self, updated: &PackView) {
        let mut cat = self.catalog.lock().await;
        if let Some(entry) = cat.get_entry_mut(&updated.key) {
            entry.view = updated.clone();
        }
    }

    async fn emit_pack_state(&self, view: &PackView) {
        self.update_cached_view(view).await;
        self.emit_state(PackStateEvent {
            pack_key: view.key.clone(),
            status: view.status,
            installed_version: view.installed_version.clone(),
            last_error: view.last_error.clone(),
            conflicts: view.conflicts.clone(),
            warnings: view.warnings.clone(),
        });
    }

    fn make_sync_progress_cb(&self, pack_key: &str, op: &str, cancellable: bool) -> impl Fn(SyncProgressUpdate) + Send + Sync + Clone + 'static {
        let this = self.clone();
        let key = pack_key.to_string();
        let op = op.to_string();
        move |u: SyncProgressUpdate| {
            this.emit_progress(ProgressEvent {
                pack_key: key.clone(),
                operation: op.clone(),
                stage: u.stage,
                label: u.label,
                bytes_done: u.bytes_done,
                bytes_total: u.bytes_total,
                files_done: u.files_done,
                files_total: u.files_total,
                speed: u.speed,
                cancellable,
            });
        }
    }

    fn make_runtime_progress_cb(
        &self,
        pack_key: &str,
        op: &str,
        cancellable: bool,
    ) -> crate::minecraft_installer::ProgressCallback {
        let this = self.clone();
        let key = pack_key.to_string();
        let op = op.to_string();
        Arc::new(move |u| {
            this.emit_progress(ProgressEvent {
                pack_key: key.clone(),
                operation: op.clone(),
                stage: u.stage,
                label: u.label,
                bytes_done: u.bytes_done,
                bytes_total: u.bytes_total,
                files_done: u.files_done,
                files_total: u.files_total,
                speed: u.speed,
                cancellable,
            });
        })
    }

    pub async fn check_pack(&self, pack_key: &str) -> AppResult<PackView> {
        let (cancel, _guard) = self.acquire_op(pack_key)?;
        let entry = self.get_loaded_entry(pack_key).await?;
        let settings = self.settings_store.load().await?;
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;

        let mut view = entry.view.clone();
        view.status = PackStatus::Checking;
        view.last_error = None;
        self.emit_pack_state(&view).await;

        self.emit_progress(ProgressEvent {
            pack_key: pack_key.to_string(),
            operation: "check".to_string(),
            stage: Stage::Check,
            label: "Загрузка описания сборки...".to_string(),
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            speed: 0,
            cancellable: true,
        });

        let res: AppResult<PackView> = async {
            let (pack_info, manifest) = {
                let cat = self.catalog.lock().await;
                cat.fetch_pack_and_manifest(&entry.source_ref, &cancel).await?
            };

            let sync_cb = self.make_sync_progress_cb(pack_key, "check", true);
            let plan = plan_pack_sync(&instance_dir, &manifest, false, &cancel, sync_cb).await?;
            let installed_version =
                read_installed_pack_version(&settings.install_dir, pack_key).await;

            view.version = pack_info.version.clone();
            view.name = pack_info.name.clone();
            view.summary = pack_info.summary.clone();
            view.description = pack_info.description.clone();
            view.minecraft = pack_info.minecraft.clone();
            view.loader = pack_info.loader.clone();
            view.recommended_memory_mb = pack_info.recommended_memory_mb;
            view.min_memory_mb = pack_info.min_memory_mb;
            view.server = pack_info.server.clone();
            view.installed_version = installed_version.clone();
            view.conflicts = plan.conflicts;
            view.warnings = plan.warnings;
            view.status = if !view.conflicts.is_empty() {
                PackStatus::Conflict
            } else if installed_version.is_none() {
                PackStatus::NotInstalled
            } else if installed_version.as_deref() != Some(&manifest.version)
                || !plan.to_download.is_empty()
                || !plan.to_delete.is_empty()
            {
                PackStatus::UpdateAvailable
            } else {
                PackStatus::Ready
            };
            Ok(view.clone())
        }
        .await;

        match res {
            Ok(updated) => {
                self.emit_pack_state(&updated).await;
                Ok(updated)
            }
            Err(e) => {
                if !e.is_cancelled() {
                    view.status = PackStatus::Error;
                    view.last_error = Some(e.to_user_error());
                } else {
                    view.installed_version =
                        read_installed_pack_version(&settings.install_dir, pack_key).await;
                    view.status = if view.installed_version.is_some() {
                        PackStatus::Ready
                    } else {
                        PackStatus::NotInstalled
                    };
                }
                self.emit_pack_state(&view).await;
                Err(e)
            }
        }
    }

    async fn sync_and_prepare_inner(
        &self,
        pack_key: &str,
        op_name: &str,
        resolutions: &HashMap<String, ConflictChoice>,
        full_verify_runtime: bool,
        cancel: &CancelToken,
    ) -> AppResult<(PackView, PackInfoJson, ManifestJson, PreparedRuntime, PathBuf)> {
        let entry = self.get_loaded_entry(pack_key).await?;
        let settings = self.settings_store.load().await?;
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        let install_dir = PathBuf::from(&settings.install_dir);

        let mut view = entry.view.clone();
        view.status = PackStatus::Checking;
        view.last_error = None;
        self.emit_pack_state(&view).await;

        self.emit_progress(ProgressEvent {
            pack_key: pack_key.to_string(),
            operation: op_name.to_string(),
            stage: Stage::Check,
            label: "Проверка версии и манифеста сборки...".to_string(),
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            speed: 0,
            cancellable: true,
        });

        let (pack_info, manifest, plan) = {
            let fetch_res = {
                let cat = self.catalog.lock().await;
                cat.fetch_pack_and_manifest(&entry.source_ref, cancel).await
            };
            match fetch_res {
                Ok((p, m)) => {
                    let sync_cb = self.make_sync_progress_cb(pack_key, op_name, true);
                    let pl = plan_pack_sync(
                        &instance_dir,
                        &m,
                        settings.full_verify_on_launch,
                        cancel,
                        sync_cb,
                    )
                    .await?;
                    (p, m, pl)
                }
                Err(err) => {
                    // В режиме play: если нет сети и сборка уже установлена, разрешаем офлайн-запуск!
                    if op_name == "play"
                        && matches!(err.code, ErrorCode::Offline | ErrorCode::GithubUnavailable)
                        && read_installed_pack_version(&settings.install_dir, pack_key)
                            .await
                            .is_some()
                    {
                        if let Some(local_manifest) = read_local_manifest(&instance_dir).await {
                            self.log.warn(
                                "launcher",
                                format!("Офлайн-запуск {pack_key} (GitHub недоступен)"),
                            );
                            let custom_java = settings
                                .pack_overrides
                                .get(pack_key)
                                .and_then(|o| o.java_path.as_deref())
                                .or(settings.java_path.as_deref());
                            let rt_cb = self.make_runtime_progress_cb(pack_key, op_name, true);
                            let rt = ensure_minecraft_and_loader(
                                &self.http,
                                &self.log,
                                &install_dir,
                                &instance_dir,
                                &local_manifest,
                                custom_java,
                                false,
                                cancel,
                                rt_cb,
                            )
                            .await?;
                            view.status = PackStatus::Ready;
                            view.warnings = vec![
                                "Запуск в офлайн-режиме: не удалось проверить обновления на GitHub."
                                    .to_string(),
                            ];
                            return Ok((view, entry.pack_info, local_manifest, rt, instance_dir));
                        }
                    }
                    return Err(err);
                }
            }
        };

        // Проверяем конфликты
        let unresolved: Vec<_> = plan
            .conflicts
            .iter()
            .filter(|c| !resolutions.contains_key(&c.path))
            .cloned()
            .collect();
        if !unresolved.is_empty() {
            view.conflicts = plan.conflicts;
            view.warnings = plan.warnings;
            view.status = PackStatus::Conflict;
            self.emit_pack_state(&view).await;
            return Err(
                LauncherError::new(
                    ErrorCode::Conflict,
                    "Требуется решение по изменённым файлам",
                    format!(
                        "Обнаружены изменённые файлы ({}). Выберите действие для каждого файла.",
                        unresolved.len()
                    ),
                )
                .with_hint("Отметьте «Заменить» (с резервной копией) или «Оставить»."),
            );
        }

        let needs_apply = !plan.to_download.is_empty()
            || !plan.to_delete.is_empty()
            || !plan.conflicts.is_empty()
            || read_pack_state(&instance_dir)
                .await
                .is_none_or(|s| s.version != manifest.version);

        view.warnings = plan.warnings.clone();

        if needs_apply {
            view.status = PackStatus::Downloading;
            self.emit_pack_state(&view).await;

            let apply_cb = self.make_sync_progress_cb(pack_key, op_name, true);
            let _next_state = apply_pack_sync(
                &self.http,
                &self.log,
                &instance_dir,
                &manifest,
                plan,
                resolutions,
                cancel,
                apply_cb,
            )
            .await?;
        }

        let custom_java = settings
            .pack_overrides
            .get(pack_key)
            .and_then(|o| o.java_path.as_deref())
            .or(settings.java_path.as_deref());
        let rt_cb = self.make_runtime_progress_cb(pack_key, op_name, true);
        let rt = ensure_minecraft_and_loader(
            &self.http,
            &self.log,
            &install_dir,
            &instance_dir,
            &manifest,
            custom_java,
            full_verify_runtime || settings.full_verify_on_launch,
            cancel,
            rt_cb,
        )
        .await?;

        let _ = save_local_pack_meta(
            &instance_dir,
            &LocalPackMeta {
                schema_version: 1,
                pack_key: pack_key.to_string(),
                source_ref: PackSourceRef {
                    pack_id: Some(pack_info.id.clone()),
                    news_path: Some(pack_info.news.clone()),
                    ..entry.source_ref
                },
                pack_info: pack_info.clone(),
                cover_data_url: view.cover_data_url.clone(),
            },
        )
        .await;

        view.version = pack_info.version.clone();
        view.installed_version = Some(manifest.version.clone());
        view.conflicts.clear();
        view.status = PackStatus::Ready;
        Ok((view, pack_info, manifest, rt, instance_dir))
    }

    pub async fn install_pack(
        &self,
        pack_key: &str,
        resolutions: HashMap<String, ConflictChoice>,
    ) -> AppResult<PackView> {
        let (cancel, _guard) = self.acquire_op(pack_key)?;
        let prev_entry = self.get_loaded_entry(pack_key).await?;
        let mut fallback_view = prev_entry.view.clone();

        match self
            .sync_and_prepare_inner(pack_key, "install", &resolutions, false, &cancel)
            .await
        {
            Ok((view, _, _, _, _)) => {
                self.emit_pack_state(&view).await;
                Ok(view)
            }
            Err(e) => {
                if e.code != ErrorCode::Conflict {
                    if e.is_cancelled() {
                        let settings = self.settings_store.load().await.ok();
                        let inst = settings.and_then(|s| {
                            tokio::task::block_in_place(|| {
                                let p = Path::new(&s.install_dir)
                                    .join("instances")
                                    .join(pack_key)
                                    .join(".abilauncher")
                                    .join("state.json");
                                p.exists().then_some(true)
                            })
                        });
                        fallback_view.status = if inst.is_some() {
                            PackStatus::UpdateAvailable
                        } else {
                            PackStatus::NotInstalled
                        };
                    } else {
                        fallback_view.status = PackStatus::Error;
                        fallback_view.last_error = Some(e.to_user_error());
                    }
                    self.emit_pack_state(&fallback_view).await;
                }
                Err(e)
            }
        }
    }

    pub async fn play_pack(&self, pack_key: &str, options: PlayOptions) -> AppResult<PackView> {
        let (cancel, _guard) = self.acquire_op(pack_key)?;
        let Some(profile): Option<Profile> = self.profile_store.get_selected_profile().await? else {
            return Err(
                LauncherError::new(
                    ErrorCode::NoProfile,
                    "Не выбран профиль игрока",
                    "Перед запуском игры создайте и выберите профиль с вашим никнеймом.",
                )
                .with_hint("Создайте профиль в правой нижней панели или на главном экране."),
            );
        };

        let prev_entry = self.get_loaded_entry(pack_key).await?;
        let mut fallback_view = prev_entry.view.clone();
        let resolutions = options.resolutions.unwrap_or_default();

        let prepared = self
            .sync_and_prepare_inner(pack_key, "play", &resolutions, false, &cancel)
            .await;

        let (mut view, pack_info, _manifest, runtime, instance_dir) = match prepared {
            Ok(v) => v,
            Err(e) => {
                if e.code != ErrorCode::Conflict {
                    if !e.is_cancelled() {
                        fallback_view.status = PackStatus::Error;
                        fallback_view.last_error = Some(e.to_user_error());
                    }
                    self.emit_pack_state(&fallback_view).await;
                }
                return Err(e);
            }
        };

        let settings = self.settings_store.load().await?;
        let ov = settings.pack_overrides.get(pack_key);

        let memory_mb = ov
            .and_then(|o| o.memory_mb)
            .or(settings.default_memory_mb)
            .unwrap_or_else(|| {
                let def = compute_default_memory_mb(total_system_memory_mb());
                pack_info.recommended_memory_mb.max(def)
            });

        let extra_jvm = ov
            .and_then(|o| o.extra_jvm_args.as_deref())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                (!settings.extra_jvm_args.trim().is_empty()).then_some(settings.extra_jvm_args.as_str())
            });

        let auto_join = options.join_server.unwrap_or(settings.auto_join_server);

        view.status = PackStatus::Launching;
        self.emit_pack_state(&view).await;
        self.emit_progress(ProgressEvent {
            pack_key: pack_key.to_string(),
            operation: "play".to_string(),
            stage: Stage::Launch,
            label: "Запуск Minecraft...".to_string(),
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            speed: 0,
            cancellable: false,
        });

        let this = self.clone();
        let key_for_ev = pack_key.to_string();
        let view_template = view.clone();

        if let Err(e) = launch_game(
            &self.log,
            pack_key,
            &runtime,
            &instance_dir,
            &profile,
            memory_mb,
            &settings.resolution,
            extra_jvm,
            pack_info.server.as_ref(),
            auto_join,
            &self.launcher_version,
            move |ev| {
                let mut next_view = view_template.clone();
                if ev.state == "started" {
                    if let Ok(mut rp) = this.running_packs.lock() {
                        rp.insert(key_for_ev.clone());
                    }
                    next_view.status = PackStatus::Running;
                } else if ev.state == "exited" {
                    if let Ok(mut rp) = this.running_packs.lock() {
                        rp.remove(&key_for_ev);
                    }
                    next_view.status = PackStatus::Ready;
                }
                let this2 = this.clone();
                let ev_clone = ev.clone();
                tokio::spawn(async move {
                    this2.emit_pack_state(&next_view).await;
                    this2.emit_game(ev_clone);
                });
            },
        )
        .await
        {
            view.status = PackStatus::Error;
            view.last_error = Some(e.to_user_error());
            self.emit_pack_state(&view).await;
            return Err(e);
        }

        view.status = PackStatus::Running;
        Ok(view)
    }

    pub async fn list_java(&self) -> AppResult<Vec<JavaInfoView>> {
        let settings = self.settings_store.load().await?;
        Ok(discover_java_installations(Path::new(&settings.install_dir)).await)
    }

    pub async fn test_java(&self, java_path: &str) -> AppResult<JavaInfoView> {
        probe_java_executable(Path::new(java_path)).await
    }

    pub async fn ping_server(&self, host: &str, port: Option<u16>) -> ServerStatus {
        ping_minecraft_server(host, port, 4000).await
    }

    pub async fn load_news(&self) -> AppResult<NewsResult> {
        let cancel = CancelToken::new();
        let cat = self.catalog.lock().await;
        cat.load_news(&cancel).await
    }

    pub async fn get_latest_crash_report(&self, pack_key: &str) -> AppResult<Option<CrashReportView>> {
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        Ok(find_latest_crash_report(&instance_dir, None).await)
    }

    fn addon_folder_name(category: PackAddonCategory) -> &'static str {
        match category {
            PackAddonCategory::Mod => "mods",
            PackAddonCategory::Shader => "shaderpacks",
            PackAddonCategory::Resourcepack => "resourcepacks",
        }
    }

    fn validate_addon_filename(file_name: &str) -> AppResult<&str> {
        let trimmed = file_name.trim();
        if trimmed.is_empty()
            || trimmed == "."
            || trimmed == ".."
            || trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.contains('\0')
        {
            return Err(LauncherError::new(
                ErrorCode::Filesystem,
                "Некорректное имя файла",
                format!("Имя «{file_name}» содержит недопустимые символы."),
            ));
        }
        Ok(trimmed)
    }

    fn format_addon_display_name(file_name: &str) -> String {
        let mut s = file_name.to_string();
        for suffix in [".disabled", ".jar", ".zip"] {
            if s.to_ascii_lowercase().ends_with(suffix) {
                let new_len = s.len() - suffix.len();
                s.truncate(new_len);
            }
        }
        let cleaned = s.replace(['_', '-'], " ");
        let compact: Vec<&str> = cleaned.split_whitespace().collect();
        if compact.is_empty() {
            file_name.to_string()
        } else {
            compact.join(" ")
        }
    }

    fn is_valid_addon_entry(category: PackAddonCategory, file_name: &str, is_dir: bool) -> bool {
        let lower = file_name.to_ascii_lowercase();
        let base = lower.strip_suffix(".disabled").unwrap_or(&lower);
        match category {
            PackAddonCategory::Mod => !is_dir && base.ends_with(".jar"),
            PackAddonCategory::Shader | PackAddonCategory::Resourcepack => {
                base.ends_with(".zip") || is_dir
            }
        }
    }

    async fn managed_paths_set(instance_dir: &Path) -> HashSet<String> {
        let mut set = HashSet::new();
        if let Some(state) = read_pack_state(instance_dir).await {
            for rel in state.managed.keys() {
                set.insert(rel.replace('\\', "/").to_ascii_lowercase());
            }
        }
        set
    }

    pub async fn list_pack_content(&self, pack_key: &str) -> AppResult<PackContentView> {
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        let instance_exists = tokio::fs::try_exists(&instance_dir).await.unwrap_or(false);
        if !instance_exists {
            return Ok(PackContentView {
                addons: Vec::new(),
                backups: Vec::new(),
                instance_exists: false,
            });
        }

        let managed = Self::managed_paths_set(&instance_dir).await;
        let mut addons = Vec::new();

        for category in [
            PackAddonCategory::Mod,
            PackAddonCategory::Shader,
            PackAddonCategory::Resourcepack,
        ] {
            let folder = Self::addon_folder_name(category);
            let dir_path = instance_dir.join(folder);
            let Ok(mut rd) = tokio::fs::read_dir(&dir_path).await else {
                continue;
            };
            while let Ok(Some(entry)) = rd.next_entry().await {
                let Ok(meta) = entry.metadata().await else {
                    continue;
                };
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if !Self::is_valid_addon_entry(category, &file_name, meta.is_dir()) {
                    continue;
                }
                let lower = file_name.to_ascii_lowercase();
                let enabled = !lower.ends_with(".disabled");
                let active_name = if enabled {
                    file_name.as_str()
                } else {
                    &file_name[..file_name.len() - ".disabled".len()]
                };
                let rel_key = format!("{folder}/{active_name}").to_ascii_lowercase();
                let source = if managed.contains(&rel_key) {
                    PackAddonSource::Pack
                } else {
                    PackAddonSource::User
                };

                addons.push(PackAddonItem {
                    name: Self::format_addon_display_name(&file_name),
                    file_name,
                    category,
                    source,
                    enabled,
                    size_bytes: if meta.is_file() { meta.len() } else { 0 },
                });
            }
        }

        addons.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });

        let mut backups = Vec::new();
        let backups_dir = instance_dir.join(LAUNCHER_META_DIR).join("backups");
        if let Ok(mut rd) = tokio::fs::read_dir(&backups_dir).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let Ok(meta) = entry.metadata().await else {
                    continue;
                };
                if !meta.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let modified_at = meta
                    .modified()
                    .ok()
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                    })
                    .unwrap_or_default();
                let mut files_count = 0usize;
                let mut stack = vec![entry.path()];
                while let Some(cur) = stack.pop() {
                    if let Ok(mut sub) = tokio::fs::read_dir(&cur).await {
                        while let Ok(Some(child)) = sub.next_entry().await {
                            if let Ok(cm) = child.metadata().await {
                                if cm.is_dir() {
                                    stack.push(child.path());
                                } else {
                                    files_count += 1;
                                }
                            }
                        }
                    }
                }
                backups.push(PackBackupItem {
                    name,
                    modified_at,
                    files_count,
                });
            }
        }
        backups.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

        Ok(PackContentView {
            addons,
            backups,
            instance_exists: true,
        })
    }

    pub async fn toggle_pack_addon(
        &self,
        pack_key: &str,
        category: PackAddonCategory,
        file_name: &str,
    ) -> AppResult<PackContentView> {
        let safe_name = Self::validate_addon_filename(file_name)?;
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        let folder = Self::addon_folder_name(category);
        let managed = Self::managed_paths_set(&instance_dir).await;
        let active_name = if safe_name.to_ascii_lowercase().ends_with(".disabled") {
            &safe_name[..safe_name.len() - ".disabled".len()]
        } else {
            safe_name
        };
        let rel_key = format!("{folder}/{active_name}").to_ascii_lowercase();
        if managed.contains(&rel_key) {
            return Err(LauncherError::new(
                ErrorCode::Filesystem,
                "Файл защищён манифестом сборки",
                "Основные файлы сборки нельзя отключать, чтобы сохранить совместимость с сервером.",
            ));
        }

        let dir_path = instance_dir.join(folder);
        let src = dir_path.join(safe_name);
        if !tokio::fs::try_exists(&src).await.unwrap_or(false) {
            return Err(LauncherError::new(
                ErrorCode::Filesystem,
                "Файл не найден",
                format!("Файл «{safe_name}» не существует в папке {folder}/."),
            ));
        }

        let target_name = if safe_name.to_ascii_lowercase().ends_with(".disabled") {
            safe_name[..safe_name.len() - ".disabled".len()].to_string()
        } else {
            format!("{safe_name}.disabled")
        };
        let dst = dir_path.join(&target_name);
        tokio::fs::rename(&src, &dst).await?;
        self.list_pack_content(pack_key).await
    }

    pub async fn delete_pack_addon(
        &self,
        pack_key: &str,
        category: PackAddonCategory,
        file_name: &str,
    ) -> AppResult<PackContentView> {
        let safe_name = Self::validate_addon_filename(file_name)?;
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        let folder = Self::addon_folder_name(category);
        let managed = Self::managed_paths_set(&instance_dir).await;
        let active_name = if safe_name.to_ascii_lowercase().ends_with(".disabled") {
            &safe_name[..safe_name.len() - ".disabled".len()]
        } else {
            safe_name
        };
        let rel_key = format!("{folder}/{active_name}").to_ascii_lowercase();
        if managed.contains(&rel_key) {
            return Err(LauncherError::new(
                ErrorCode::Filesystem,
                "Файл защищён манифестом сборки",
                "Нельзя удалить обязательный файл из основы сборки.",
            ));
        }

        let target = instance_dir.join(folder).join(safe_name);
        if let Ok(meta) = tokio::fs::metadata(&target).await {
            if meta.is_dir() {
                tokio::fs::remove_dir_all(&target).await?;
            } else {
                tokio::fs::remove_file(&target).await?;
            }
        }
        self.list_pack_content(pack_key).await
    }

    pub async fn import_pack_addons(
        &self,
        pack_key: &str,
        category: PackAddonCategory,
        source_paths: Vec<PathBuf>,
    ) -> AppResult<PackContentView> {
        let instance_dir = self.instance_dir_for_pack(pack_key).await?;
        let folder = Self::addon_folder_name(category);
        let dest_dir = instance_dir.join(folder);
        ensure_dir(&dest_dir).await?;

        for src in source_paths {
            let Some(name_os) = src.file_name() else {
                continue;
            };
            let name = name_os.to_string_lossy().into_owned();
            let safe_name = Self::validate_addon_filename(&name)?;
            let dst = dest_dir.join(safe_name);
            tokio::fs::copy(&src, &dst).await?;
        }
        self.list_pack_content(pack_key).await
    }

    pub async fn build_diagnostics_json(&self) -> AppResult<String> {
        let settings = self.settings_store.load().await?;
        let profiles = self.profile_store.load().await?;
        let packs: Vec<PackView> = {
            let cat = self.catalog.lock().await;
            cat.all_entries().into_iter().map(|e| e.view).collect()
        };
        let javas = discover_java_installations(Path::new(&settings.install_dir)).await;
        Ok(build_diagnostics_report(
            &self.launcher_version,
            &settings,
            profiles.profiles.len(),
            &packs,
            &javas,
            &self.log,
        ))
    }

    #[allow(dead_code)]
    pub fn host_policy() -> HostPolicy {
        HostPolicy::PackAssetsOnly
    }
}
