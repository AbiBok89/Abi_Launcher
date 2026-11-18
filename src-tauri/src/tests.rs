use crate::catalog_service::parse_and_validate_manifest;
use crate::error::CancelToken;
use crate::game_launcher::{
    build_extra_jvm_args, parse_jvm_args, supports_legacy_server_arg, supports_quick_play,
};
use crate::github::{parse_repo_input, raw_url};
use crate::launcher_updater::{
    compare_semver, parse_sha256_digest, select_launcher_asset, GitHubReleaseAsset,
};
use crate::mc_version::LibraryInfo;
use crate::pack_updater::{
    local_manifest_path, plan_pack_sync, state_file_path, ManagedFileRecord, PackInstanceState,
    PROTECTED_USER_GLOBS,
};
use crate::paths::{check_relative_path, matches_any, LAUNCHER_META_DIR};
use crate::storage::{compute_default_memory_mb, offline_uuid_from_name, validate_nickname};
use crate::types::{
    ConflictKind, FileMode, InstallMode, Loader, ManifestFile, ManifestFileSource, ManifestJson,
};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

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
