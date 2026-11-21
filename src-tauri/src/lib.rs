pub mod archive;
pub mod catalog_service;
pub mod commands;
pub mod diagnostics;
pub mod error;
pub mod fsutil;
pub mod game_launcher;
pub mod github;
pub mod http;
pub mod java_manager;
pub mod launcher_service;
pub mod launcher_updater;
pub mod log;
pub mod mc_version;
pub mod minecraft_installer;
pub mod pack_updater;
pub mod paths;
pub mod server_ping;
pub mod storage;
pub mod types;

#[cfg(test)]
mod tests;

use commands::AppContext;
use launcher_service::LauncherService;
use launcher_updater::LauncherUpdater;
use log::AppLogger;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, Theme, WindowEvent};
use types::AfterLaunch;

fn resolve_user_data_dir(app: &tauri::App) -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = app
        .path()
        .data_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."));

    #[cfg(not(target_os = "windows"))]
    let base = app
        .path()
        .config_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."));

    base.join("AbiLauncher")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::ThemeChanged(theme) = event {
                let val = match theme {
                    Theme::Dark => "dark",
                    _ => "light",
                };
                let _ = window.app_handle().emit_to("main", "theme:changed", val);
            }
        })
        .setup(|app| {
            let user_data_dir = resolve_user_data_dir(app);
            let _ = std::fs::create_dir_all(&user_data_dir);

            let logger = AppLogger::new();
            logger.set_file(user_data_dir.join("logs").join("launcher.log"));

            let app_ver = app.package_info().version.to_string();
            let app_for_log = app.handle().clone();
            logger.set_emitter(move |entry| {
                let _ = app_for_log.emit_to("main", "logs:entry", entry);
            });

            let service = LauncherService::new(user_data_dir.clone(), app_ver.clone(), logger.clone());

            let app_for_prog = app.handle().clone();
            service.set_progress_emitter(move |ev| {
                let _ = app_for_prog.emit_to("main", "pack:progress", ev);
            });

            let app_for_state = app.handle().clone();
            service.set_state_emitter(move |ev| {
                let _ = app_for_state.emit_to("main", "pack:state", ev);
            });

            let app_for_game = app.handle().clone();
            let svc_for_game = service.clone();
            service.set_game_emitter(move |ev| {
                let _ = app_for_game.emit_to("main", "game:event", ev.clone());
                let ah = app_for_game.clone();
                let svc = svc_for_game.clone();
                let state_str = ev.state.clone();
                tauri::async_runtime::spawn(async move {
                    if state_str == "started" {
                        if let Ok(settings) = svc.get_settings().await {
                            match settings.after_launch {
                                AfterLaunch::Minimize => {
                                    if let Some(w) = ah.get_webview_window("main") {
                                        let _ = w.minimize();
                                    }
                                }
                                AfterLaunch::Hide => {
                                    if let Some(w) = ah.get_webview_window("main") {
                                        let _ = w.hide();
                                    }
                                }
                                AfterLaunch::Close => {
                                    ah.exit(0);
                                }
                                AfterLaunch::Keep => {}
                            }
                        }
                    } else if state_str == "exited" {
                        if let Some(w) = ah.get_webview_window("main") {
                            let is_vis = w.is_visible().unwrap_or(true);
                            let is_min = w.is_minimized().unwrap_or(false);
                            if !is_vis || is_min {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    }
                });
            });

            let app_for_quit = app.handle().clone();
            let updater = Arc::new(LauncherUpdater::new(
                app_ver.clone(),
                user_data_dir,
                service.http_client().clone(),
                logger.clone(),
                Arc::new(move || {
                    app_for_quit.exit(0);
                }),
            ));

            let app_for_upd = app.handle().clone();
            updater.set_emitter(move |st| {
                let _ = app_for_upd.emit_to("main", "launcherUpdate:state", st);
            });

            // Применяем настройку изменения размера окна при запуске
            let svc_win = service.clone();
            let app_for_win = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(settings) = svc_win.get_settings().await {
                    if settings.resizable_window {
                        if let Some(w) = app_for_win.get_webview_window("main") {
                            commands::apply_window_resizable(&w, true);
                        }
                    }
                }
            });

            // Отложенная фоновая проверка и автоматическая установка обновлений лаунчера
            let svc_upd = service.clone();
            let upd_bg = Arc::clone(&updater);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                if let Ok(settings) = svc_upd.get_settings().await {
                    if settings.auto_check_launcher_updates {
                        let svc_chk = svc_upd.clone();
                        let _ = upd_bg
                            .check_and_auto_update(move || !svc_chk.has_active_ops_or_games())
                            .await;
                    }
                }
            });

            app.manage(AppContext { service, updater });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_update,
            commands::dialog_pick_directory,
            commands::dialog_pick_java,
            commands::theme_get_system,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_is_maximized,
            commands::profiles_get,
            commands::profiles_create,
            commands::profiles_rename,
            commands::profiles_delete,
            commands::profiles_select,
            commands::catalog_load,
            commands::catalog_add_repo,
            commands::catalog_remove_repo,
            commands::pack_check,
            commands::pack_install,
            commands::pack_play,
            commands::pack_cancel,
            commands::pack_open_folder,
            commands::pack_latest_crash_report,
            commands::pack_list_content,
            commands::pack_toggle_addon,
            commands::pack_delete_addon,
            commands::pack_import_addon,
            commands::java_list,
            commands::java_test,
            commands::server_ping,
            commands::news_load,
            commands::logs_get,
            commands::diagnostics_export,
            commands::launcher_update_get_state,
            commands::launcher_update_check,
            commands::launcher_update_download,
            commands::launcher_update_cancel_download,
            commands::launcher_update_install,
            commands::launcher_update_open_release_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AbiLauncher");
}
