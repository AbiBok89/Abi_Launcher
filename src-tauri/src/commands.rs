use crate::error::{AppResult, ErrorCode, LauncherError, ResultDto};
use crate::fsutil::{abs_lexical, ensure_dir};
use crate::launcher_service::LauncherService;
use crate::launcher_updater::{LauncherUpdater, LAUNCHER_RELEASES_PAGE_URL};
use crate::types::{
    AppInfo, CatalogResult, ConflictChoice, CrashReportView, JavaInfoView, LauncherUpdateState,
    LogEntry, NewsResult, PackAddonCategory, PackContentView, PackSubfolder, PackView, PlayOptions,
    ProfilesState, ServerStatus, Settings, SettingsPatch,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State, Theme, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

pub struct AppContext {
    pub service: LauncherService,
    pub updater: Arc<LauncherUpdater>,
}

fn assert_main_window(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != "main" {
        return Err(LauncherError::new(
            ErrorCode::Unknown,
            "Неизвестный источник вызова",
            "Команды разрешены только из главного окна лаунчера.",
        ));
    }
    Ok(())
}

fn map_theme(theme: tauri::Result<Theme>) -> String {
    match theme {
        Ok(Theme::Dark) => "dark".to_string(),
        _ => "light".to_string(),
    }
}

#[tauri::command]
pub async fn app_info(window: WebviewWindow, state: State<'_, AppContext>) -> Result<ResultDto<AppInfo>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state.service.get_app_info().await)))
}

#[tauri::command]
pub async fn settings_get(window: WebviewWindow, state: State<'_, AppContext>) -> Result<ResultDto<Settings>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.get_settings().await))
}

#[tauri::command]
pub async fn settings_update(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    patch: SettingsPatch,
) -> Result<ResultDto<Settings>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.update_settings(patch).await))
}

#[tauri::command]
pub async fn dialog_pick_directory(
    app: AppHandle,
    window: WebviewWindow,
    default_path: Option<String>,
) -> Result<ResultDto<Option<String>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Выберите папку для сборок и данных Minecraft");
    if let Some(ref p) = default_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            builder = builder.set_directory(pb);
        }
    }
    let (tx, rx) = oneshot::channel();
    builder.pick_folder(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()));
    });
    let res = match rx.await {
        Ok(Some(path)) => Ok(Some(path.to_string_lossy().into_owned())),
        _ => Ok(None),
    };
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn dialog_pick_java(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<ResultDto<Option<String>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let mut builder = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Выберите исполняемый файл Java");
    if cfg!(windows) {
        builder = builder.add_filter("Java", &["exe"]);
    }
    let (tx, rx) = oneshot::channel();
    builder.pick_file(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()));
    });
    let res = match rx.await {
        Ok(Some(path)) => Ok(Some(path.to_string_lossy().into_owned())),
        _ => Ok(None),
    };
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn theme_get_system(window: WebviewWindow) -> Result<ResultDto<String>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(map_theme(window.theme()))))
}

#[tauri::command]
pub async fn window_minimize(window: WebviewWindow) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let res = window
        .minimize()
        .map_err(|e| LauncherError::new(ErrorCode::Unknown, "Ошибка окна", e.to_string()));
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn window_toggle_maximize(window: WebviewWindow) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    if window.is_maximizable().unwrap_or(false) {
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
    Ok(ResultDto::from_result(Ok(())))
}

#[tauri::command]
pub async fn window_close(window: WebviewWindow) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let res = window
        .close()
        .map_err(|e| LauncherError::new(ErrorCode::Unknown, "Ошибка закрытия окна", e.to_string()));
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn window_is_maximized(window: WebviewWindow) -> Result<ResultDto<bool>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(window.is_maximized().unwrap_or(false))))
}

#[tauri::command]
pub async fn profiles_get(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<ProfilesState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.get_profiles().await))
}

#[tauri::command]
pub async fn profiles_create(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    name: String,
) -> Result<ResultDto<ProfilesState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.create_profile(&name).await))
}

#[tauri::command]
pub async fn profiles_rename(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    id: String,
    name: String,
) -> Result<ResultDto<ProfilesState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.rename_profile(&id, &name).await))
}

#[tauri::command]
pub async fn profiles_delete(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    id: String,
) -> Result<ResultDto<ProfilesState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.delete_profile(&id).await))
}

#[tauri::command]
pub async fn profiles_select(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    id: String,
) -> Result<ResultDto<ProfilesState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.select_profile(&id).await))
}

#[tauri::command]
pub async fn catalog_load(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<CatalogResult>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.load_catalog().await))
}

#[tauri::command]
pub async fn catalog_add_repo(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    repo_input: String,
    branch: Option<String>,
) -> Result<ResultDto<Settings>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state
            .service
            .add_custom_repo(&repo_input, branch.as_deref())
            .await,
    ))
}

#[tauri::command]
pub async fn catalog_remove_repo(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    repo: String,
) -> Result<ResultDto<Settings>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state.service.remove_custom_repo(&repo).await,
    ))
}

#[tauri::command]
pub async fn pack_check(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
) -> Result<ResultDto<PackView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.check_pack(&pack_key).await))
}

#[tauri::command]
pub async fn pack_install(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    resolutions: Option<HashMap<String, ConflictChoice>>,
) -> Result<ResultDto<PackView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state
            .service
            .install_pack(&pack_key, resolutions.unwrap_or_default())
            .await,
    ))
}

#[tauri::command]
pub async fn pack_play(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    options: Option<PlayOptions>,
) -> Result<ResultDto<PackView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state
            .service
            .play_pack(&pack_key, options.unwrap_or_default())
            .await,
    ))
}

#[tauri::command]
pub async fn pack_cancel(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
) -> Result<ResultDto<bool>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state
        .service
        .cancel_operation(&pack_key))))
}

#[tauri::command]
pub async fn pack_open_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    subfolder: Option<PackSubfolder>,
) -> Result<ResultDto<String>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let res: AppResult<String> = async {
        let inst = abs_lexical(&state.service.instance_dir_for_pack(&pack_key).await?);
        let target = match subfolder.unwrap_or(PackSubfolder::Root) {
            PackSubfolder::Root => inst.clone(),
            PackSubfolder::Mods => inst.join("mods"),
            PackSubfolder::Saves => inst.join("saves"),
            PackSubfolder::Shaderpacks => inst.join("shaderpacks"),
            PackSubfolder::Resourcepacks => inst.join("resourcepacks"),
            PackSubfolder::Screenshots => inst.join("screenshots"),
            PackSubfolder::CrashReports => inst.join("crash-reports"),
            PackSubfolder::Logs => inst.join("logs"),
            PackSubfolder::Backups => inst.join(".abilauncher").join("backups"),
        };
        ensure_dir(&target).await?;
        let target_str = target.to_string_lossy().into_owned();
        app.opener()
            .open_path(target_str.clone(), None::<&str>)
            .map_err(|e| {
                LauncherError::new(
                    ErrorCode::Filesystem,
                    "Не удалось открыть папку",
                    e.to_string(),
                )
            })?;
        Ok(target_str)
    }
    .await;
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn pack_latest_crash_report(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
) -> Result<ResultDto<Option<CrashReportView>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state.service.get_latest_crash_report(&pack_key).await,
    ))
}

#[tauri::command]
pub async fn pack_list_content(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
) -> Result<ResultDto<PackContentView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state.service.list_pack_content(&pack_key).await,
    ))
}

#[tauri::command]
pub async fn pack_toggle_addon(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    category: PackAddonCategory,
    file_name: String,
) -> Result<ResultDto<PackContentView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state
            .service
            .toggle_pack_addon(&pack_key, category, &file_name)
            .await,
    ))
}

#[tauri::command]
pub async fn pack_delete_addon(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    category: PackAddonCategory,
    file_name: String,
) -> Result<ResultDto<PackContentView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state
            .service
            .delete_pack_addon(&pack_key, category, &file_name)
            .await,
    ))
}

#[tauri::command]
pub async fn pack_import_addon(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppContext>,
    pack_key: String,
    category: PackAddonCategory,
) -> Result<ResultDto<Option<PackContentView>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let (title, filter_name, exts): (&str, &str, &[&str]) = match category {
        PackAddonCategory::Mod => ("Выберите файл мода (.jar)", "Моды Minecraft", &["jar"]),
        PackAddonCategory::Shader => ("Выберите архив шейдеров (.zip)", "Шейдеры", &["zip"]),
        PackAddonCategory::Resourcepack => ("Выберите ресурс-пак (.zip)", "Ресурс-паки", &["zip"]),
    };
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .add_filter(filter_name, exts)
        .pick_files(move |picked| {
            let paths = picked
                .map(|list| {
                    list.into_iter()
                        .filter_map(|f| f.into_path().ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let _ = tx.send(paths);
        });
    let paths = rx.await.unwrap_or_default();
    if paths.is_empty() {
        return Ok(ResultDto::from_result(Ok(None)));
    }
    let res = state
        .service
        .import_pack_addons(&pack_key, category, paths)
        .await
        .map(Some);
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn java_list(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<Vec<JavaInfoView>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.list_java().await))
}

#[tauri::command]
pub async fn java_test(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    java_path: String,
) -> Result<ResultDto<JavaInfoView>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.test_java(&java_path).await))
}

#[tauri::command]
pub async fn server_ping(
    window: WebviewWindow,
    state: State<'_, AppContext>,
    host: String,
    port: Option<u16>,
) -> Result<ResultDto<ServerStatus>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state
        .service
        .ping_server(&host, port)
        .await)))
}

#[tauri::command]
pub async fn news_load(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<NewsResult>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.service.load_news().await))
}

#[tauri::command]
pub async fn logs_get(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<Vec<LogEntry>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state.service.log().entries())))
}

#[tauri::command]
pub async fn diagnostics_export(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<Option<String>>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let res: AppResult<Option<String>> = async {
        let json = state.service.build_diagnostics_json().await?;
        let (tx, rx) = oneshot::channel();
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("Сохранить отчёт диагностики")
            .set_file_name("abilauncher-diagnostics.json")
            .add_filter("JSON", &["json"])
            .save_file(move |p| {
                let _ = tx.send(p.and_then(|f| f.into_path().ok()));
            });
        let Some(dest) = rx.await.ok().flatten() else {
            return Ok(None);
        };
        tokio::fs::write(&dest, json.as_bytes()).await?;
        Ok(Some(dest.to_string_lossy().into_owned()))
    }
    .await;
    Ok(ResultDto::from_result(res))
}

#[tauri::command]
pub async fn launcher_update_get_state(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<LauncherUpdateState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state.updater.get_state())))
}

#[tauri::command]
pub async fn launcher_update_check(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<LauncherUpdateState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(Ok(state
        .updater
        .check_for_updates()
        .await)))
}

#[tauri::command]
pub async fn launcher_update_download(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<LauncherUpdateState>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(state.updater.download_update().await))
}

#[tauri::command]
pub async fn launcher_update_cancel_download(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    state.updater.cancel_download();
    Ok(ResultDto::from_result(Ok(())))
}

#[tauri::command]
pub async fn launcher_update_install(
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    Ok(ResultDto::from_result(
        state.updater.install_downloaded_update().await,
    ))
}

#[tauri::command]
pub async fn launcher_update_open_release_page(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppContext>,
) -> Result<ResultDto<()>, ()> {
    if let Err(e) = assert_main_window(&window) {
        return Ok(ResultDto::from_result(Err(e)));
    }
    let st = state.updater.get_state();
    let target = st
        .release_url
        .filter(|u| u.starts_with("https://github.com/AbiBok89/Abi_Launcher"))
        .unwrap_or_else(|| LAUNCHER_RELEASES_PAGE_URL.to_string());
    let res = app
        .opener()
        .open_url(target, None::<&str>)
        .map_err(|e| LauncherError::new(ErrorCode::Unknown, "Не удалось открыть браузер", e.to_string()));
    Ok(ResultDto::from_result(res))
}
