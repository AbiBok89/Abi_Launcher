use crate::log::AppLogger;
use crate::storage::total_system_memory_mb;
use crate::types::{JavaInfoView, PackView, Settings};
use chrono::Utc;
use serde_json::json;

pub fn build_diagnostics_report(
    launcher_version: &str,
    settings: &Settings,
    profiles_count: usize,
    packs: &[PackView],
    java_list: &[JavaInfoView],
    log: &AppLogger,
) -> String {
    let overrides: serde_json::Map<String, serde_json::Value> = settings
        .pack_overrides
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                json!({
                    "memoryMb": v.memory_mb,
                    "javaPath": v.java_path.as_ref().map(|p| log.redact(p)),
                    "extraJvmArgs": v.extra_jvm_args.as_ref().map(|a| log.redact(a)),
                }),
            )
        })
        .collect();

    let safe_settings = json!({
        "theme": settings.theme,
        "installDir": log.redact(&settings.install_dir),
        "catalogUrl": settings.catalog_url,
        "customRepos": settings.custom_repos,
        "defaultMemoryMb": settings.default_memory_mb,
        "javaPath": settings.java_path.as_ref().map(|p| log.redact(p)),
        "resolution": settings.resolution,
        "afterLaunch": settings.after_launch,
        "fullVerifyOnLaunch": settings.full_verify_on_launch,
        "autoJoinServer": settings.auto_join_server,
        "extraJvmArgs": log.redact(&settings.extra_jvm_args),
        "autoCheckLauncherUpdates": settings.auto_check_launcher_updates,
        "packOverrides": overrides,
    });

    let javas: Vec<_> = java_list
        .iter()
        .map(|j| {
            json!({
                "path": log.redact(&j.path),
                "version": j.version,
                "majorVersion": j.major_version,
                "managed": j.managed,
            })
        })
        .collect();

    let pack_views: Vec<_> = packs
        .iter()
        .map(|p| {
            json!({
                "key": p.key,
                "id": p.id,
                "name": p.name,
                "source": p.source,
                "remoteVersion": p.version,
                "installedVersion": p.installed_version,
                "minecraft": p.minecraft,
                "loader": p.loader,
                "status": p.status,
                "conflictsCount": p.conflicts.len(),
                "warnings": p.warnings,
                "lastError": p.last_error.as_ref().map(|e| json!({
                    "code": e.code,
                    "title": e.title,
                    "message": log.redact(&e.message),
                })),
            })
        })
        .collect();

    let all_logs = log.entries();
    let tail_start = all_logs.len().saturating_sub(500);

    let report = json!({
        "generatedAt": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "product": "AbiLauncher",
        "note": "Отчёт не содержит секретов, токенов и персональных данных (имя пользователя и домашний каталог скрыты).",
        "environment": {
            "launcherVersion": launcher_version,
            "runtime": "Tauri 2 (WebView2 + Rust)",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "totalMemoryMb": total_system_memory_mb(),
        },
        "profilesCount": profiles_count,
        "settings": safe_settings,
        "javaInstallations": javas,
        "packs": pack_views,
        "logs": &all_logs[tail_start..],
    });

    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string())
}
