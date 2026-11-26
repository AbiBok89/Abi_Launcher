use crate::catalog_service::parse_and_validate_manifest;
use crate::error::CancelToken;
use crate::game_launcher::{
    build_extra_jvm_args, build_launch_arguments, parse_jvm_args, supports_legacy_server_arg,
    supports_quick_play, YggdrasilLaunchAuth,
};
use crate::github::{parse_repo_input, raw_url};
use crate::launcher_updater::{
    compare_semver, parse_sha256_digest, select_launcher_asset, GitHubReleaseAsset,
};
use crate::mc_version::{LibraryInfo, LoggingClient, LoggingClientFile, ResolvedVersion};
use crate::minecraft_installer::PreparedRuntime;
use crate::pack_updater::{
    local_manifest_path, plan_pack_sync, state_file_path, ManagedFileRecord, PackInstanceState,
    PROTECTED_USER_GLOBS,
};
use crate::paths::{check_relative_path, matches_any, LAUNCHER_META_DIR};
use crate::storage::{compute_default_memory_mb, offline_uuid_from_name, validate_nickname};
use crate::types::{
    ConflictKind, FileMode, InstallMode, JavaInfoView, Loader, ManifestFile, ManifestFileSource,
    ManifestJson, Profile, Resolution,
};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

#[test]
fn paths_security_and_globs() {
    assert!(check_relative_path("mods/sodium.jar").is_none());
    assert!(check_relative_path("config/jade/jade.json").is_none());
    assert!(check_relative_path("../secret.txt").is_some());
    assert!(check_relative_path("mods\\sodium.jar").is_some());
    assert!(check_relative_path("/etc/passwd").is_some());
    assert!(check_relative_path("C:foo.txt").is_some());
    assert!(check_relative_path("mods/CON.txt").is_some());
    assert!(check_relative_path(".abilauncher/state.json").is_some());
    assert!(check_relative_path("mods/file.").is_some());

    assert!(matches_any("saves/world/level.dat", PROTECTED_USER_GLOBS));
    assert!(matches_any("options.txt", PROTECTED_USER_GLOBS));
    assert!(matches_any(".abilauncher/state.json", PROTECTED_USER_GLOBS));
    assert!(!matches_any("mods/create.jar", PROTECTED_USER_GLOBS));
}

#[test]
fn github_repo_parsing_and_raw_urls() {
    let r1 = parse_repo_input("AbiBok89/abi_tfg", None).unwrap();
    assert_eq!(r1.repo, "AbiBok89/abi_tfg");
    assert_eq!(r1.branch, "main");
    assert_eq!(r1.path, "ForLauncher/pack.json");

    let r2 = parse_repo_input("https://github.com/AbiBok89/abi_tfg/tree/release-1", None).unwrap();
    assert_eq!(r2.repo, "AbiBok89/abi_tfg");
    assert_eq!(r2.branch, "release-1");

    assert!(parse_repo_input("http://github.com/a/b", None).is_err());
    assert!(parse_repo_input("https://evil.com/a/b", None).is_err());
    assert!(parse_repo_input("AbiBok89/../b", None).is_err());

    let url = raw_url("AbiBok89/abi_tfg", "main", "ForLauncher/pack.json").unwrap();
    assert_eq!(
        url,
        "https://raw.githubusercontent.com/AbiBok89/abi_tfg/main/ForLauncher/pack.json"
    );
}

#[test]
fn storage_defaults_memory_and_offline_uuid() {
    assert_eq!(compute_default_memory_mb(16384), 8192);
    assert_eq!(compute_default_memory_mb(10240), 8192);
    assert_eq!(compute_default_memory_mb(8192), 7168);
    assert_eq!(compute_default_memory_mb(2048), 2048);

    let u1 = offline_uuid_from_name("AbiBok");
    let u2 = offline_uuid_from_name("AbiBok");
    assert_eq!(u1, u2);
    assert_eq!(u1.len(), 36);
    assert_eq!(&u1[14..15], "3"); // UUID v3 nibble

    assert!(validate_nickname("Abi_Bok89").is_ok());
    assert!(validate_nickname("ab").is_err());
    assert!(validate_nickname("ИмяНаРусском").is_err());
}

#[test]
fn catalog_manifest_validation_checks() {
    let h = sha256_hex(b"hello");
    let valid_json = format!(
        r#"{{
          "schemaVersion": 1,
          "packId": "tfg-modern",
          "version": "0.13.18.1",
          "minecraft": "1.20.1",
          "loader": {{ "type": "forge", "version": "47.4.13" }},
          "archives": [
            {{ "id": "mods", "url": "https://github.com/AbiBok89/abi_tfg/releases/download/v1/mods.zip", "size": 123, "sha256": "{h}" }}
          ],
          "files": [
            {{ "path": "mods/a.jar", "size": 5, "sha256": "{h}", "mode": "managed", "required": true, "source": {{ "archive": "mods", "entry": "a.jar" }} }},
            {{ "path": "config/c.cfg", "size": 5, "sha256": "{h}", "url": "https://raw.githubusercontent.com/AbiBok89/abi_tfg/main/c.cfg" }}
          ]
        }}"#
    );
    let parsed = parse_and_validate_manifest(&valid_json).unwrap();
    assert_eq!(parsed.files.len(), 2);
    assert_eq!(
        parsed.loader,
        Loader::Forge {
            version: "47.4.13".to_string()
        }
    );

    // Дубликат с разным регистром
    let dup = format!(
        r#"{{
          "schemaVersion": 1, "packId": "x", "version": "1", "minecraft": "1.20.1",
          "loader": {{ "type": "vanilla" }},
          "files": [
            {{ "path": "mods/A.jar", "size": 5, "sha256": "{h}", "url": "https://raw.githubusercontent.com/a/b/main/A.jar" }},
            {{ "path": "mods/a.jar", "size": 5, "sha256": "{h}", "url": "https://raw.githubusercontent.com/a/b/main/a.jar" }}
          ]
        }}"#
    );
    assert!(parse_and_validate_manifest(&dup).is_err());

    // Запрещённый хост
    let bad_host = format!(
        r#"{{
          "schemaVersion": 1, "packId": "x", "version": "1", "minecraft": "1.20.1",
          "loader": {{ "type": "vanilla" }},
          "files": [
            {{ "path": "mods/a.jar", "size": 5, "sha256": "{h}", "url": "https://evil.example.com/a.jar" }}
          ]
        }}"#
    );
    assert!(parse_and_validate_manifest(&bad_host).is_err());
}

#[test]
fn mc_version_maven_and_jvm_args() {
    let info1 = LibraryInfo::resolve("net.minecraftforge:forge:1.20.1-47.4.13:universal");
    assert_eq!(
        info1.path,
        "net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-universal.jar"
    );

    let info2 = LibraryInfo::resolve("net.minecraft:client:1.20.1:mappings@txt");
    assert_eq!(
        info2.path,
        "net/minecraft/client/1.20.1/client-1.20.1-mappings.txt"
    );

    let parsed = parse_jvm_args(Some(r#"-Dfoo="hello world" -javaagent:C:\Apps\agent.jar -XX:+UseZGC"#));
    assert_eq!(
        parsed,
        vec![
            "-Dfoo=hello world",
            r"-javaagent:C:\Apps\agent.jar",
            "-XX:+UseZGC"
        ]
    );

    let defaults = build_extra_jvm_args(Some(""), Path::new("/tmp/shared"));
    assert!(defaults.iter().any(|a| a == "-XX:+UseG1GC"));
    assert!(defaults.iter().any(|a| a.starts_with("-DlibraryDirectory=")));

    let custom_zgc = build_extra_jvm_args(Some("-XX:+UseZGC"), Path::new("/tmp/shared"));
    assert!(!custom_zgc.iter().any(|a| a == "-XX:+UseG1GC"));
    assert!(custom_zgc.iter().any(|a| a == "-XX:+UseZGC"));

    assert!(supports_quick_play("1.20.1"));
    assert!(supports_quick_play("1.21.4"));
    assert!(!supports_quick_play("1.19.2"));
    assert!(supports_legacy_server_arg("1.12.2"));
    assert!(!supports_legacy_server_arg("1.5.2"));
}

#[test]
fn launcher_updater_semver_and_assets() {
    assert_eq!(compare_semver("0.2.0", "0.1.1"), Ordering::Greater);
    assert_eq!(compare_semver("v0.2.0", "0.2.0"), Ordering::Equal);
    assert_eq!(compare_semver("0.2.0", "0.2.0-beta.1"), Ordering::Greater);
    assert!(parse_sha256_digest(Some(&format!("sha256:{}", "a".repeat(64)))).is_some());
    assert!(parse_sha256_digest(Some("sha256:bad")).is_none());

    let assets = vec![
        GitHubReleaseAsset {
            name: "AbiLauncher-0.2.0-win-x64.exe".to_string(),
            size: 9_000_000,
            browser_download_url: "https://github.com/AbiBok89/Abi_Launcher/releases/download/v0.2.0/AbiLauncher-0.2.0-win-x64.exe".to_string(),
            digest: None,
        },
        GitHubReleaseAsset {
            name: "AbiLauncher-0.2.0-win-x64-portable.exe".to_string(),
            size: 8_000_000,
            browser_download_url: "https://github.com/AbiBok89/Abi_Launcher/releases/download/v0.2.0/AbiLauncher-0.2.0-win-x64-portable.exe".to_string(),
            digest: None,
        },
    ];
    let p = select_launcher_asset(&assets, "windows", "x86_64", InstallMode::Portable).unwrap();
    assert_eq!(p.name, "AbiLauncher-0.2.0-win-x64-portable.exe");
    let inst = select_launcher_asset(&assets, "windows", "x86_64", InstallMode::Installer).unwrap();
    assert_eq!(inst.name, "AbiLauncher-0.2.0-win-x64.exe");
}

#[tokio::test]
async fn pack_updater_plan_conflicts_and_extra_mods() {
    let base = std::env::temp_dir().join(format!("abi_test_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("mods")).unwrap();
    std::fs::create_dir_all(base.join("config")).unwrap();
    std::fs::create_dir_all(base.join("saves/world")).unwrap();
    std::fs::create_dir_all(base.join(LAUNCHER_META_DIR)).unwrap();

    let mod_orig = b"original-mod";
    let mod_edited = b"edited-mod";
    let cfg_orig = b"cfg-v1";
    let cfg_v2 = b"cfg-v2";
    let obsolete_bytes = b"old-mod";

    std::fs::write(base.join("mods/req.jar"), mod_edited).unwrap();
    std::fs::write(base.join("mods/player-addon.jar"), b"user").unwrap();
    std::fs::write(base.join("mods/obsolete.jar"), obsolete_bytes).unwrap();
    std::fs::write(base.join("config/user.txt"), b"custom").unwrap();
    std::fs::write(base.join("saves/world/level.dat"), b"save").unwrap();

    let mut prev_managed = HashMap::new();
    prev_managed.insert(
        "mods/req.jar".to_string(),
        ManagedFileRecord {
            sha256: sha256_hex(mod_orig),
            size: mod_orig.len() as u64,
            mtime_ms: 1.0,
            mode: FileMode::Managed,
            kept_by_user: None,
            target_sha256: None,
        },
    );
    prev_managed.insert(
        "mods/obsolete.jar".to_string(),
        ManagedFileRecord {
            sha256: sha256_hex(obsolete_bytes),
            size: obsolete_bytes.len() as u64,
            mtime_ms: 1.0,
            mode: FileMode::Managed,
            kept_by_user: None,
            target_sha256: None,
        },
    );
    prev_managed.insert(
        "config/user.txt".to_string(),
        ManagedFileRecord {
            sha256: sha256_hex(cfg_orig),
            size: cfg_orig.len() as u64,
            mtime_ms: 1.0,
            mode: FileMode::Initial,
            kept_by_user: None,
            target_sha256: None,
        },
    );

    let state = PackInstanceState {
        schema_version: 1,
        pack_id: "tfg-modern".to_string(),
        version: "0.13.18.0".to_string(),
        updated_at: "2026-11-18T00:00:00Z".to_string(),
        managed: prev_managed,
    };
    std::fs::write(
        state_file_path(&base),
        serde_json::to_string(&state).unwrap(),
    )
    .unwrap();
    let _ = local_manifest_path(&base);

    let manifest = ManifestJson {
        schema_version: 1,
        pack_id: "tfg-modern".to_string(),
        version: "0.13.18.1".to_string(),
        created_at: None,
        minecraft: "1.20.1".to_string(),
        loader: Loader::Forge {
            version: "47.4.13".to_string(),
        },
        java: None,
        archives: Vec::new(),
        files: vec![
            ManifestFile {
                path: "mods/req.jar".to_string(),
                size: mod_orig.len() as u64,
                sha256: sha256_hex(mod_orig),
                mode: FileMode::Managed,
                required: true,
                source: ManifestFileSource::Url {
                    url: "https://github.com/AbiBok89/abi_tfg/releases/download/v1/req.jar"
                        .to_string(),
                },
            },
            ManifestFile {
                path: "mods/new.jar".to_string(),
                size: 3,
                sha256: sha256_hex(b"new"),
                mode: FileMode::Managed,
                required: true,
                source: ManifestFileSource::Url {
                    url: "https://github.com/AbiBok89/abi_tfg/releases/download/v1/new.jar"
                        .to_string(),
                },
            },
            ManifestFile {
                path: "config/user.txt".to_string(),
                size: cfg_v2.len() as u64,
                sha256: sha256_hex(cfg_v2),
                mode: FileMode::Initial,
                required: false,
                source: ManifestFileSource::Url {
                    url: "https://raw.githubusercontent.com/AbiBok89/abi_tfg/main/config/user.txt"
                        .to_string(),
                },
            },
        ],
    };

    let cancel = CancelToken::new();
    let plan = plan_pack_sync(&base, &manifest, true, &cancel, |_| {})
        .await
        .unwrap();

    assert_eq!(plan.to_download.len(), 1);
    assert_eq!(plan.to_download[0].path, "mods/new.jar");
    assert_eq!(plan.to_delete, vec!["mods/obsolete.jar".to_string()]);
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].path, "mods/req.jar");
    assert_eq!(plan.conflicts[0].kind, ConflictKind::Modified);
    assert!(!plan.conflicts[0].can_keep); // required managed mod -> can_keep == false
    assert!(!plan.warnings.is_empty()); // extra player-addon.jar warning

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn forge_launch_args_use_minecraft_version_in_ignore_list_and_full_id_in_game_args() {
    let runtime = PreparedRuntime {
        resolved: ResolvedVersion {
            id: "1.20.1-forge-47.4.13".to_string(),
            minecraft_version: "1.20.1".to_string(),
            main_class: "cpw.mods.bootstraplauncher.BootstrapLauncher".to_string(),
            version_type: "release".to_string(),
            assets: "5".to_string(),
            asset_index: None,
            downloads: HashMap::new(),
            libraries: Vec::new(),
            jvm_args: vec![
                serde_json::json!("-DignoreList=client-extra,fmlcore,forge-,${version_name}.jar"),
                serde_json::json!("-DlibraryDirectory=${library_directory}"),
                serde_json::json!("-cp"),
                serde_json::json!("${classpath}"),
            ],
            game_args: vec![
                serde_json::json!("--version"),
                serde_json::json!("${version_name}"),
                serde_json::json!("--gameDir"),
                serde_json::json!("${game_directory}"),
            ],
            legacy_args: None,
            logging: Some(LoggingClient {
                argument: "-Dlog4j.configurationFile=${path}".to_string(),
                file: LoggingClientFile {
                    id: "client-1.12.xml".to_string(),
                    sha1: String::new(),
                    size: 0,
                    url: String::new(),
                },
            }),
            java_major: Some(17),
        },
        java: JavaInfoView {
            path: "E:/Games/Sborki/runtimes/java-17/bin/java.exe".to_string(),
            version: "17.0.15".to_string(),
            major_version: 17,
            managed: true,
        },
        shared_dir: Path::new("E:/Games/Sborki/shared").to_path_buf(),
        version_id: "1.20.1-forge-47.4.13".to_string(),
    };

    let profile = Profile {
        id: "p1".to_string(),
        name: "PlayerOne".to_string(),
        uuid: "e2a6ed12-cd91-3221-b5be-a3304b8f74fe".to_string(),
        created_at: "2026-11-18T00:00:00Z".to_string(),
    };
    let resolution = Resolution {
        width: 1280,
        height: 720,
        fullscreen: false,
    };

    let args = build_launch_arguments(
        &runtime,
        Path::new("E:/Games/Sborki/instances/tfg"),
        Path::new("E:/Games/Sborki/shared/versions/1.20.1-forge-47.4.13/natives"),
        &profile,
        8192,
        &resolution,
        None,
        None,
        false,
        "0.2.1",
        None,
    );

    assert!(args.contains(&"-DignoreList=client-extra,fmlcore,forge-,1.20.1.jar".to_string()));
    assert!(!args.iter().any(|a| a.contains("1.20.1-forge-47.4.13.jar")));
    assert_eq!(
        args.iter().filter(|a| a.starts_with("-DlibraryDirectory=")).count(),
        1
    );

    let ver_pos = args.iter().position(|a| a == "--version").unwrap();
    assert_eq!(args[ver_pos + 1], "1.20.1-forge-47.4.13");

    let log_arg = args
        .iter()
        .find(|a| a.starts_with("-Dlog4j.configurationFile="))
        .unwrap();
    #[cfg(windows)]
    assert!(!log_arg.contains('/'), "Log4j path on Windows must use native separators: {log_arg}");
    assert!(log_arg.ends_with("client-1.12.xml"));
}

#[tokio::test]
async fn preserves_map_and_voice_settings_and_auto_syncs_servers_dat() {
    let dir = std::env::temp_dir().join(format!(
        "abi-launcher-test-map-voice-{}",
        std::process::id()
    ));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(dir.join("config/voicechat"))
        .await
        .unwrap();
    tokio::fs::create_dir_all(dir.join("config/xaero/minimap"))
        .await
        .unwrap();

    // Настройки игрока уже изменены на диске
    tokio::fs::write(
        dir.join("config/voicechat/voicechat-client.properties"),
        b"microphone=MyMic\nvolume=1.5\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        dir.join("config/xaero/minimap/config.txt"),
        b"minimapSize:250\n",
    )
    .await
    .unwrap();
    tokio::fs::write(dir.join("servers.dat"), b"old-servers-data")
        .await
        .unwrap();

    let new_voice = b"microphone=Default\n";
    let new_xaero = b"minimapSize:100\n";
    let new_servers = b"updated-servers-v2";

    // Даже если старый манифест пометил конфиги карты и voicechat как managed,
    // лаунчер должен сохранить пользовательские файлы без конфликтов,
    // а servers.dat — автоматически поставить на обновление без конфликта.
    let manifest = ManifestJson {
        schema_version: 1,
        pack_id: "test-pack".to_string(),
        version: "2.0.0".to_string(),
        minecraft: "1.20.1".to_string(),
        loader: Loader::Vanilla,
        java: None,
        created_at: None,
        archives: Vec::new(),
        files: vec![
            ManifestFile {
                path: "config/voicechat/voicechat-client.properties".to_string(),
                size: new_voice.len() as u64,
                sha256: sha256_hex(new_voice),
                mode: FileMode::Managed,
                required: true,
                source: ManifestFileSource::Url {
                    url: "https://raw.githubusercontent.com/a/b/main/v".to_string(),
                },
            },
            ManifestFile {
                path: "config/xaero/minimap/config.txt".to_string(),
                size: new_xaero.len() as u64,
                sha256: sha256_hex(new_xaero),
                mode: FileMode::Managed,
                required: true,
                source: ManifestFileSource::Url {
                    url: "https://raw.githubusercontent.com/a/b/main/x".to_string(),
                },
            },
            ManifestFile {
                path: "servers.dat".to_string(),
                size: new_servers.len() as u64,
                sha256: sha256_hex(new_servers),
                mode: FileMode::Managed,
                required: true,
                source: ManifestFileSource::Url {
                    url: "https://raw.githubusercontent.com/a/b/main/servers.dat".to_string(),
                },
            },
        ],
    };

    let cancel = CancelToken::new();
    let plan = plan_pack_sync(&dir, &manifest, true, &cancel, |_| {})
        .await
        .unwrap();

    assert!(
        plan.conflicts.is_empty(),
        "Настройки карты, voicechat и servers.dat не должны вызывать конфликтов: {:?}",
        plan.conflicts
    );
    assert_eq!(plan.to_download.len(), 1);
    assert_eq!(plan.to_download[0].path, "servers.dat");

    let def = crate::storage::default_settings(&dir);
    assert!(!def.auto_join_server);
    assert!(!def.resizable_window);

    let _ = tokio::fs::remove_dir_all(&dir).await;
}

fn push_nbt_string(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
}

#[tokio::test]
async fn servers_dat_extracts_only_20tps_ru_and_ping_enforces_domain() {
    use crate::server_ping::{
        extract_20tps_server_from_servers_dat, is_allowed_20tps_host, ping_minecraft_server,
    };

    assert!(is_allowed_20tps_host("slavka.20tps.ru"));
    assert!(is_allowed_20tps_host("ABIBOK.20TPS.RU."));
    assert!(!is_allowed_20tps_host("slavka.skuf.club"));
    assert!(!is_allowed_20tps_host("20tps.ru"));
    assert!(!is_allowed_20tps_host("fake20tps.ru"));

    // Собираем валидный несжатый NBT servers.dat с двумя серверами:
    // 1) Основа -> slavka.skuf.club (должен быть пропущен)
    // 2) Прокси -> slavka.20tps.ru:25577 (должен быть выбран)
    let mut nbt = Vec::new();
    nbt.push(0x0a); // TAG_Compound root
    push_nbt_string(&mut nbt, "");
    nbt.push(0x09); // TAG_List "servers"
    push_nbt_string(&mut nbt, "servers");
    nbt.push(0x0a); // elem type TAG_Compound
    nbt.extend_from_slice(&2i32.to_be_bytes());

    // Entry 1
    nbt.push(0x01); // TAG_Byte hidden
    push_nbt_string(&mut nbt, "hidden");
    nbt.push(0);
    nbt.push(0x08); // TAG_String ip
    push_nbt_string(&mut nbt, "ip");
    push_nbt_string(&mut nbt, "slavka.skuf.club");
    nbt.push(0x08); // TAG_String name
    push_nbt_string(&mut nbt, "name");
    push_nbt_string(&mut nbt, "Основа");
    nbt.push(0x00);

    // Entry 2
    nbt.push(0x01); // TAG_Byte hidden
    push_nbt_string(&mut nbt, "hidden");
    nbt.push(0);
    nbt.push(0x08); // TAG_String ip
    push_nbt_string(&mut nbt, "ip");
    push_nbt_string(&mut nbt, "slavka.20tps.ru:25577");
    nbt.push(0x08); // TAG_String name
    push_nbt_string(&mut nbt, "name");
    push_nbt_string(&mut nbt, "Прокси");
    nbt.push(0x00);

    nbt.push(0x00); // root end

    let parsed = extract_20tps_server_from_servers_dat(&nbt).unwrap();
    assert_eq!(parsed.name, "Прокси");
    assert_eq!(parsed.host, "slavka.20tps.ru");
    assert_eq!(parsed.port, Some(25577));

    // Пинг не-.20tps.ru хоста должен отклоняться сразу без сети
    let blocked = ping_minecraft_server("slavka.skuf.club", None, 200).await;
    assert!(!blocked.online);
    assert!(blocked.error.unwrap_or_default().contains("20tps.ru"));
}

#[test]
fn yggdrasil_launch_args_prepend_javaagent_and_real_tokens() {
    let runtime = PreparedRuntime {
        shared_dir: PathBuf::from("E:/Games/Sborki/shared"),
        version_id: "1.20.1-forge-47.4.13".to_string(),
        resolved: ResolvedVersion {
            id: "1.20.1-forge-47.4.13".to_string(),
            minecraft_version: "1.20.1".to_string(),
            version_type: "release".to_string(),
            main_class: "cpw.mods.bootstraplauncher.BootstrapLauncher".to_string(),
            assets: "5".to_string(),
            asset_index: None,
            downloads: HashMap::new(),
            libraries: vec![],
            jvm_args: vec![],
            game_args: vec![],
            legacy_args: Some(
                "--username ${auth_player_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type}".to_string(),
            ),
            logging: None,
            java_major: Some(17),
        },
        java: JavaInfoView {
            path: "C:/Java/bin/javaw.exe".to_string(),
            major_version: 17,
            version: "17.0.10".to_string(),
            managed: true,
        },
    };
    let profile = Profile {
        id: "id1".to_string(),
        name: "AbiBok".to_string(),
        uuid: "e2a6ed124c1b302a90e7b63761b12345".to_string(),
        created_at: String::new(),
    };
    let resolution = Resolution {
        width: 1280,
        height: 720,
        fullscreen: false,
    };
    let args = build_launch_arguments(
        &runtime,
        Path::new("E:/Games/Sborki/instances/tfg"),
        Path::new("E:/Games/Sborki/shared/natives"),
        &profile,
        4096,
        &resolution,
        None,
        None,
        false,
        "0.3.6",
        Some(YggdrasilLaunchAuth {
            access_token: "secret-access-token-123",
            authlib_injector_path: Path::new("E:/Games/My Launcher/shared/authlib-injector.jar"),
            yggdrasil_url: "http://localhost:3000/api/yggdrasil",
        }),
    );

    assert!(
        args[0].starts_with("-javaagent:") && args[0].ends_with("=http://localhost:3000/api/yggdrasil"),
        "Первый аргумент JVM должен быть -javaagent, получено: {}",
        args[0]
    );
    let token_pos = args.iter().position(|a| a == "--accessToken").unwrap();
    assert_eq!(args[token_pos + 1], "secret-access-token-123");
    let utype_pos = args.iter().position(|a| a == "--userType").unwrap();
    assert_eq!(args[utype_pos + 1], "mojang");
    let user_pos = args.iter().position(|a| a == "--username").unwrap();
    assert_eq!(args[user_pos + 1], "AbiBok");
}
