use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{abs_lexical, ensure_dir, is_inside, read_json_file, write_json_atomic};
use crate::http::{hash_file, ChecksumAlgo};
use crate::log::AppLogger;
use crate::mc_version::{
    check_rules, library_path, version_jar_path, ResolvedVersion,
};
use crate::minecraft_installer::PreparedRuntime;
use crate::storage::total_system_memory_mb;
use crate::types::{CrashReportView, GameEvent, Profile, Resolution, ServerRef};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use zip::ZipArchive;

pub const DEFAULT_EXTRA_JVM_ARGS: &[&str] = &[
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct NativesCacheManifest {
    sha1s: HashMap<String, String>,
}

pub fn parse_jvm_args(raw: Option<&str>) -> Vec<String> {
    let Some(input) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == '\\' && q == '"' && i + 1 < chars.len() && matches!(chars[i + 1], '"' | '\\') {
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if ch == q {
                quote = None;
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }

        if ch.is_whitespace() {
            if in_token {
                out.push(std::mem::take(&mut cur));
                in_token = false;
            }
            i += 1;
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            in_token = true;
            i += 1;
            continue;
        }

        // Сохраняем обратные слеши в путях Windows (напр. C:\foo\bar), экранируем только кавычку/пробел
        if ch == '\\' && i + 1 < chars.len() && (chars[i + 1] == '"' || chars[i + 1] == '\'' || chars[i + 1] == ' ') {
            cur.push(chars[i + 1]);
            in_token = true;
            i += 2;
            continue;
        }

        cur.push(ch);
        in_token = true;
        i += 1;
    }

    if in_token || !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub fn build_extra_jvm_args(raw: Option<&str>, shared_dir: &Path) -> Vec<String> {
    let lib_dir = shared_dir.join("libraries");
    let mut out = vec![format!("-DlibraryDirectory={}", lib_dir.display())];
    let user_args = parse_jvm_args(raw);
    let user_sets_gc = user_args.iter().any(|a| {
        a.starts_with("-XX:+Use") && a.ends_with("GC")
    });
    if !user_sets_gc {
        for def in DEFAULT_EXTRA_JVM_ARGS {
            out.push((*def).to_string());
        }
    }
    out.extend(user_args);
    out
}

fn parse_mc_minor(mc_ver: &str) -> Option<u32> {
    let mut parts = mc_ver.trim().split('.');
    if parts.next()? != "1" {
        return None;
    }
    parts.next()?.parse::<u32>().ok()
}

pub fn supports_quick_play(mc_ver: &str) -> bool {
    parse_mc_minor(mc_ver).is_some_and(|m| m >= 20)
}

pub fn supports_legacy_server_arg(mc_ver: &str) -> bool {
    parse_mc_minor(mc_ver).is_some_and(|m| m >= 6)
}

pub async fn check_and_extract_natives(
    shared_dir: &Path,
    resolved: &ResolvedVersion,
    natives_dir: &Path,
    cancel: &CancelToken,
) -> AppResult<()> {
    let natives: Vec<_> = resolved.libraries.iter().filter(|l| l.is_native).collect();
    if natives.is_empty() {
        ensure_dir(natives_dir).await?;
        return Ok(());
    }

    let manifest_path = natives_dir.join(".natives-cache.json");
    let mut expected_map: HashMap<String, String> = HashMap::new();
    for lib in &natives {
        let p = library_path(shared_dir, &lib.download.path);
        let key = p.to_string_lossy().into_owned();
        let sha = if !lib.download.sha1.is_empty() {
            lib.download.sha1.clone()
        } else {
            hash_file(&p, ChecksumAlgo::Sha1, cancel)
                .await
                .unwrap_or_default()
        };
        expected_map.insert(key, sha);
    }

    if let Ok(Some(cached)) = read_json_file::<NativesCacheManifest>(&manifest_path).await {
        if cached.sha1s == expected_map && !expected_map.is_empty() {
            return Ok(());
        }
    }

    ensure_dir(natives_dir).await?;
    let specs: Vec<(PathBuf, Vec<String>)> = natives
        .iter()
        .map(|lib| {
            let jar = library_path(shared_dir, &lib.download.path);
            let excludes = if lib.extract_exclude.is_empty() {
                vec!["META-INF/".to_string()]
            } else {
                lib.extract_exclude.clone()
            };
            (jar, excludes)
        })
        .collect();

    let natives_dir_owned = abs_lexical(natives_dir);
    let cancel_bg = cancel.clone();

    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let mut buf = vec![0u8; 64 * 1024];
        for (jar_path, excludes) in specs {
            cancel_bg.check()?;
            if !jar_path.exists() {
                continue;
            }
            let file = File::open(&jar_path).map_err(|e| {
                LauncherError::new(
                    ErrorCode::LaunchFailed,
                    "Не удалось открыть нативную библиотеку",
                    format!("{}: {e}", jar_path.display()),
                )
            })?;
            let mut zip = ZipArchive::new(file).map_err(|e| {
                LauncherError::new(
                    ErrorCode::LaunchFailed,
                    "Повреждённая нативная библиотека",
                    format!("{}: {e}", jar_path.display()),
                )
            })?;
            for i in 0..zip.len() {
                cancel_bg.check()?;
                let mut entry = zip.by_index(i).map_err(|e| {
                    LauncherError::new(
                        ErrorCode::LaunchFailed,
                        "Ошибка чтения нативной библиотеки",
                        e.to_string(),
                    )
                })?;
                if entry.is_dir() {
                    continue;
                }
                let name = entry.name().replace('\\', "/");
                if name.contains("..")
                    || name.starts_with('/')
                    || name.starts_with("META-INF/")
                    || name.ends_with(".sha1")
                    || name.ends_with(".git")
                    || excludes.iter().any(|ex| name.starts_with(ex))
                {
                    continue;
                }
                let mut dest = natives_dir_owned.clone();
                for seg in name.split('/') {
                    if !seg.is_empty() && seg != "." {
                        dest.push(seg);
                    }
                }
                if !is_inside(&natives_dir_owned, &dest) {
                    continue;
                }
                if let Some(p) = dest.parent() {
                    std::fs::create_dir_all(p)?;
                }
                let mut out = File::create(&dest)?;
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n])?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| LauncherError::new(ErrorCode::LaunchFailed, "Сбой распаковки natives", e.to_string()))??;

    let _ = write_json_atomic(&manifest_path, &NativesCacheManifest { sha1s: expected_map }).await;
    Ok(())
}

fn collect_conditional_args(items: &[Value], active_features: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        match item {
            Value::String(s) => out.push(s.clone()),
            Value::Object(obj) => {
                if let Some(rules_val) = obj.get("rules") {
                    if let Ok(rules) = serde_json::from_value::<Vec<crate::mc_version::LibraryRule>>(rules_val.clone()) {
                        if !check_rules(&rules, active_features) {
                            continue;
                        }
                    }
                }
                match obj.get("value") {
                    Some(Value::String(s)) => out.push(s.clone()),
                    Some(Value::Array(arr)) => {
                        for v in arr {
                            if let Some(s) = v.as_str() {
                                out.push(s.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

fn apply_placeholders(arg: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = arg.to_string();
    for (k, v) in vars {
        let needle = format!("${{{k}}}");
        if out.contains(&needle) {
            out = out.replace(&needle, v);
        }
    }
    out
}

pub fn build_launch_arguments(
    runtime: &PreparedRuntime,
    instance_dir: &Path,
    natives_dir: &Path,
    profile: &Profile,
    memory_mb: u32,
    resolution: &Resolution,
    extra_jvm_args_raw: Option<&str>,
    server: Option<&ServerRef>,
    auto_join: bool,
    launcher_version: &str,
) -> Vec<String> {
    let shared_dir = &runtime.shared_dir;
    let resolved = &runtime.resolved;

    let total_mb = total_system_memory_mb();
    let max_allowed = total_mb.saturating_sub(1024).max(1024);
    let max_mem = (memory_mb as u64).clamp(512, max_allowed);
    let min_mem = (max_mem / 2).clamp(512, 1024).min(max_mem);

    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut cp_paths: Vec<String> = Vec::new();
    let mut seen_cp: HashSet<String> = HashSet::new();

    for lib in &resolved.libraries {
        if lib.is_native || lib.download.path.is_empty() {
            continue;
        }
        let p = library_path(shared_dir, &lib.download.path)
            .to_string_lossy()
            .into_owned();
        if seen_cp.insert(p.clone()) {
            cp_paths.push(p);
        }
    }
    let client_jar = version_jar_path(shared_dir, &resolved.minecraft_version)
        .to_string_lossy()
        .into_owned();
    if seen_cp.insert(client_jar.clone()) {
        cp_paths.push(client_jar);
    }
    let classpath = cp_paths
        .iter()
        .map(|p| p.replace('\\', "/"))
        .collect::<Vec<_>>()
        .join(sep);

    let assets_root = shared_dir
        .join("assets")
        .to_string_lossy()
        .replace('\\', "/");
    let assets_index_name = resolved
        .asset_index
        .as_ref()
        .map(|a| a.id.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| resolved.assets.clone());

    let undashed_uuid = profile.uuid.replace('-', "");
    let lib_dir_str = shared_dir
        .join("libraries")
        .to_string_lossy()
        .replace('\\', "/");

    let mut game_vars: HashMap<&str, String> = HashMap::new();
    game_vars.insert(
        "natives_directory",
        natives_dir.to_string_lossy().replace('\\', "/"),
    );
    game_vars.insert("launcher_name", "AbiLauncher".to_string());
    game_vars.insert("launcher_version", launcher_version.to_string());
    game_vars.insert("classpath", classpath);
    game_vars.insert("library_directory", lib_dir_str);
    game_vars.insert("classpath_separator", sep.to_string());
    game_vars.insert("version_name", resolved.id.clone());
    game_vars.insert("auth_player_name", profile.name.clone());
    game_vars.insert("version_type", resolved.version_type.clone());
    game_vars.insert(
        "game_directory",
        instance_dir.to_string_lossy().replace('\\', "/"),
    );
    game_vars.insert("assets_root", assets_root);
    game_vars.insert(
        "game_assets",
        shared_dir
            .join("assets")
            .join("virtual")
            .join("legacy")
            .to_string_lossy()
            .replace('\\', "/"),
    );
    game_vars.insert("assets_index_name", assets_index_name);
    game_vars.insert("auth_uuid", undashed_uuid);
    game_vars.insert("auth_access_token", "0".to_string());
    game_vars.insert("auth_session", "0".to_string());
    game_vars.insert("user_type", "msa".to_string());
    game_vars.insert("clientid", "0".to_string());
    game_vars.insert("auth_xuid", "0".to_string());
    game_vars.insert("user_properties", "{}".to_string());
    game_vars.insert("resolution_width", resolution.width.max(320).to_string());
    game_vars.insert("resolution_height", resolution.height.max(240).to_string());

    // Для JVM-аргументов (в т.ч. Forge/NeoForge -DignoreList=${version_name}.jar)
    // подставляется имя ванильного jar (minecraft_version), а не полного version id.
    let mut jvm_vars = game_vars.clone();
    jvm_vars.insert("version_name", resolved.minecraft_version.clone());

    let mut features = Vec::new();
    if resolution.width > 0 && resolution.height > 0 {
        features.push("has_custom_resolution");
    }

    let mut args = Vec::new();

    // 1. Память
    args.push(format!("-Xms{min_mem}M"));
    args.push(format!("-Xmx{max_mem}M"));

    // 2. JVM аргументы из version.json (или базовые для legacy <= 1.12.2)
    if resolved.jvm_args.is_empty() {
        args.push(format!(
            "-Djava.library.path={}",
            jvm_vars["natives_directory"]
        ));
        args.push("-cp".to_string());
        args.push(jvm_vars["classpath"].clone());
    } else {
        for raw_arg in collect_conditional_args(&resolved.jvm_args, &features) {
            args.push(apply_placeholders(&raw_arg, &jvm_vars));
        }
    }

    // 3. Log4j конфиг (если указан версией). На Windows Log4j ожидает системный путь (или URL), иначе трактует "E:/" как схему.
    if let Some(ref log_client) = resolved.logging {
        let log_cfg_path = abs_lexical(
            &shared_dir
                .join("assets")
                .join("log_configs")
                .join(&log_client.file.id),
        )
        .to_string_lossy()
        .into_owned();
        args.push(log_client.argument.replace("${path}", &log_cfg_path));
    }

    // 4. Дополнительные JVM-аргументы (не дублируем -DlibraryDirectory если он уже в version.json)
    let has_lib_dir = args.iter().any(|a| a.starts_with("-DlibraryDirectory="));
    for extra in build_extra_jvm_args(extra_jvm_args_raw, shared_dir) {
        if has_lib_dir && extra.starts_with("-DlibraryDirectory=") {
            continue;
        }
        args.push(extra);
    }

    // 5. Main Class
    args.push(resolved.main_class.clone());

    // 6. Game args
    if !resolved.game_args.is_empty() {
        for raw_arg in collect_conditional_args(&resolved.game_args, &features) {
            args.push(apply_placeholders(&raw_arg, &game_vars));
        }
    } else if let Some(ref legacy) = resolved.legacy_args {
        for tok in legacy.split_whitespace() {
            args.push(apply_placeholders(tok, &game_vars));
        }
        if resolution.width > 0 && resolution.height > 0 {
            args.push("--width".to_string());
            args.push(resolution.width.to_string());
            args.push("--height".to_string());
            args.push(resolution.height.to_string());
        }
    }

    if resolution.fullscreen && !args.iter().any(|a| a == "--fullscreen") {
        args.push("--fullscreen".to_string());
    }

    if auto_join {
        if let Some(srv) = server {
            if supports_quick_play(&resolved.minecraft_version) {
                let target = match srv.port {
                    Some(p) if p != 25565 => format!("{}:{p}", srv.host),
                    _ => srv.host.clone(),
                };
                args.push("--quickPlayMultiplayer".to_string());
                args.push(target);
            } else if supports_legacy_server_arg(&resolved.minecraft_version) {
                args.push("--server".to_string());
                args.push(srv.host.clone());
                args.push("--port".to_string());
                args.push(srv.port.unwrap_or(25565).to_string());
            }
        }
    }

    args
}

pub async fn find_latest_crash_report(
    instance_dir: &Path,
    min_mtime_secs: Option<u64>,
) -> Option<CrashReportView> {
    let crash_dir = instance_dir.join("crash-reports");
    let mut rd = tokio::fs::read_dir(&crash_dir).await.ok()?;
    let mut best: Option<(String, u64, PathBuf)> = None;

    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".txt") {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Some(threshold) = min_mtime_secs {
            if mtime < threshold {
                continue;
            }
        }
        if best.as_ref().is_none_or(|(_, best_t, _)| mtime > *best_t) {
            best = Some((name, mtime, entry.path()));
        }
    }

    let (file_name, mtime_secs, path) = best?;
    let bytes = tokio::fs::read(&path).await.ok()?;
    let content_full = String::from_utf8_lossy(&bytes);
    let content = if content_full.len() > 32 * 1024 {
        let truncated: String = content_full.chars().take(12000).collect();
        format!("{truncated}\n\n... (отчёт сокращён, полный файл: {file_name})")
    } else {
        content_full.into_owned()
    };

    let modified_dt: DateTime<Utc> =
        DateTime::from_timestamp(mtime_secs as i64, 0).unwrap_or_else(Utc::now);
    Some(CrashReportView {
        file_name,
        modified_at: modified_dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        content,
    })
}

pub async fn launch_game<F>(
    log: &AppLogger,
    pack_key: &str,
    runtime: &PreparedRuntime,
    instance_dir: &Path,
    profile: &Profile,
    memory_mb: u32,
    resolution: &Resolution,
    extra_jvm_args_raw: Option<&str>,
    server: Option<&ServerRef>,
    auto_join: bool,
    launcher_version: &str,
    on_game_event: F,
) -> AppResult<()>
where
    F: Fn(GameEvent) + Send + Sync + 'static,
{
    let cancel = CancelToken::new();
    let natives_dir = runtime
        .shared_dir
        .join("versions")
        .join(&runtime.version_id)
        .join("natives");
    check_and_extract_natives(&runtime.shared_dir, &runtime.resolved, &natives_dir, &cancel).await?;

    let args = build_launch_arguments(
        runtime,
        instance_dir,
        &natives_dir,
        profile,
        memory_mb,
        resolution,
        extra_jvm_args_raw,
        server,
        auto_join,
        launcher_version,
    );

    log.info(
        "minecraft",
        format!(
            "Запуск {} (MC {}, профиль {}, ОЗУ {} МБ)",
            runtime.version_id, runtime.resolved.minecraft_version, profile.name, memory_mb
        ),
    );
    log.info("minecraft", format!("Java: {}", runtime.java.path));

    let launch_started_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(2))
        .unwrap_or(0);

    let mut cmd = Command::new(&runtime.java.path);
    cmd.args(&args)
        .current_dir(instance_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        LauncherError::new(
            ErrorCode::LaunchFailed,
            "Не удалось запустить Minecraft",
            format!("Ошибка запуска процесса Java: {e}"),
        )
        .with_hint("Проверьте выбранную версию Java и свободный объём оперативной памяти.")
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let cb = Arc::new(on_game_event);
    cb(GameEvent {
        pack_key: pack_key.to_string(),
        state: "started".to_string(),
        exit_code: None,
        crash_report: None,
        crash_report_path: None,
    });

    let log_out = log.clone();
    let out_task = tokio::spawn(async move {
        if let Some(s) = stdout {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    log_out.info("minecraft", &line);
                }
            }
        }
    });

    let log_err = log.clone();
    let err_task = tokio::spawn(async move {
        if let Some(s) = stderr {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    log_err.warn("minecraft", &line);
                }
            }
        }
    });

    let key_owned = pack_key.to_string();
    let inst_owned = instance_dir.to_path_buf();
    let log_exit = log.clone();

    tokio::spawn(async move {
        let status = child.wait().await;
        let _ = out_task.await;
        let _ = err_task.await;

        let exit_code = status.ok().and_then(|s| s.code());
        log_exit.info(
            "minecraft",
            format!("Процесс Minecraft ({key_owned}) завершился с кодом {exit_code:?}"),
        );

        let crash = if exit_code != Some(0) {
            find_latest_crash_report(&inst_owned, Some(launch_started_secs)).await
        } else {
            None
        };

        cb(GameEvent {
            pack_key: key_owned,
            state: "exited".to_string(),
            exit_code,
            crash_report_path: crash.as_ref().map(|c| {
                inst_owned
                    .join("crash-reports")
                    .join(&c.file_name)
                    .to_string_lossy()
                    .into_owned()
            }),
            crash_report: crash.map(|c| c.content),
        });
    });

    Ok(())
}
