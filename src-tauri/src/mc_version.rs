use crate::error::{AppResult, ErrorCode, LauncherError};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct LibraryInfo {
    pub name: String,
    pub group_id: String,
    pub artifact_id: String,
    pub version: String,
    pub classifier: String,
    pub ext: String,
    pub path: String,
}

impl LibraryInfo {
    pub fn resolve(raw_name: &str) -> Self {
        let (body, ext) = match raw_name.split_once('@') {
            Some((b, e)) => (b, e.to_string()),
            None => (raw_name, "jar".to_string()),
        };
        let parts: Vec<&str> = body.split(':').collect();
        let group_id = parts.first().copied().unwrap_or("").to_string();
        let artifact_id = parts.get(1).copied().unwrap_or("").to_string();
        let version = parts.get(2).copied().unwrap_or("").to_string();
        let classifier = parts.get(3).copied().unwrap_or("").to_string();

        let group_path = group_id.replace('.', "/");
        let mut base = format!("{group_path}/{artifact_id}/{version}/{artifact_id}-{version}");
        if !classifier.is_empty() {
            base.push('-');
            base.push_str(&classifier);
        }
        let path = format!("{base}.{ext}");
        Self {
            name: raw_name.to_string(),
            group_id,
            artifact_id,
            version,
            classifier,
            ext,
            path,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DownloadArtifact {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub sha1: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryRuleOs {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryRule {
    pub action: String,
    #[serde(default)]
    pub os: Option<LibraryRuleOs>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawLibrary {
    pub name: String,
    #[serde(default)]
    pub downloads: Option<RawLibraryDownloads>,
    #[serde(default)]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default)]
    pub rules: Option<Vec<LibraryRule>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub checksums: Option<Vec<String>>,
    #[serde(default)]
    pub extract: Option<RawExtract>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawLibraryDownloads {
    #[serde(default)]
    pub artifact: Option<DownloadArtifact>,
    #[serde(default)]
    pub classifiers: Option<HashMap<String, DownloadArtifact>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawExtract {
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ResolvedLibrary {
    pub name: String,
    pub group_id: String,
    pub artifact_id: String,
    pub classifier: String,
    pub download: DownloadArtifact,
    pub is_native: bool,
    pub extract_exclude: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AssetIndexRef {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
    #[serde(default, rename = "totalSize")]
    pub total_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingClientFile {
    pub id: String,
    #[serde(default)]
    pub sha1: String,
    #[serde(default)]
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingClient {
    pub argument: String,
    pub file: LoggingClientFile,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingSection {
    #[serde(default)]
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JavaVersionRef {
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawVersionJson {
    pub id: String,
    #[serde(default, rename = "inheritsFrom")]
    pub inherits_from: Option<String>,
    #[serde(default, rename = "clientVersion")]
    pub client_version: Option<String>,
    #[serde(default, rename = "mainClass")]
    pub main_class: Option<String>,
    #[serde(default, rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    #[serde(default)]
    pub arguments: Option<RawArguments>,
    #[serde(default)]
    pub libraries: Vec<RawLibrary>,
    #[serde(default)]
    pub downloads: HashMap<String, DownloadArtifact>,
    #[serde(default, rename = "assetIndex")]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default)]
    pub assets: Option<String>,
    #[serde(default, rename = "type")]
    pub version_type: Option<String>,
    #[serde(default)]
    pub logging: Option<LoggingSection>,
    #[serde(default, rename = "javaVersion")]
    pub java_version: Option<JavaVersionRef>,
    #[serde(default)]
    pub replace: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RawArguments {
    #[serde(default)]
    pub game: Vec<Value>,
    #[serde(default)]
    pub jvm: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct ResolvedVersion {
    pub id: String,
    pub minecraft_version: String,
    pub main_class: String,
    pub version_type: String,
    pub assets: String,
    pub asset_index: Option<AssetIndexRef>,
    pub downloads: HashMap<String, DownloadArtifact>,
    pub libraries: Vec<ResolvedLibrary>,
    pub jvm_args: Vec<Value>,
    pub game_args: Vec<Value>,
    pub legacy_args: Option<String>,
    pub logging: Option<LoggingClient>,
    pub java_major: Option<u32>,
}

pub fn current_mc_os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "osx",
        "linux" => "linux",
        other => other,
    }
}

pub fn current_mc_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        other => other,
    }
}

pub fn check_rules(rules: &[LibraryRule], features: &[&str]) -> bool {
    if rules.is_empty() {
        return true;
    }
    let os_name = current_mc_os();
    let arch_name = current_mc_arch();
    let mut allow = false;

    for rule in rules {
        let mut applies = true;
        if let Some(ref os) = rule.os {
            applies = false;
            let name_ok = os.name.as_deref().is_none_or(|n| n == os_name);
            let arch_ok = os.arch.as_deref().is_none_or(|a| {
                let norm = if a == "x86" { "ia32" } else { a };
                norm == arch_name
            });
            // Учёт os.version для старых Windows 10 правил
            let ver_ok = os
                .version
                .as_deref()
                .is_none_or(|v_pat| Regex::new(v_pat).map(|re| re.is_match("10.0")).unwrap_or(true));
            if name_ok && arch_ok && ver_ok {
                applies = true;
            }
        }
        if applies {
            if let Some(ref req_feat) = rule.features {
                applies = req_feat.iter().all(|(k, v)| {
                    if *v {
                        features.contains(&k.as_str())
                    } else {
                        !features.contains(&k.as_str())
                    }
                });
            }
        }
        if applies {
            allow = rule.action == "allow";
        }
    }
    allow
}

pub fn resolve_library(lib: &RawLibrary) -> Option<ResolvedLibrary> {
    if let Some(ref rules) = lib.rules {
        if !check_rules(rules, &[]) {
            return None;
        }
    }

    let os_name = current_mc_os();
    let arch_bits = if cfg!(target_pointer_width = "64") {
        "64"
    } else {
        "32"
    };

    if let Some(ref natives) = lib.natives {
        let raw_cls = natives.get(os_name)?;
        let classifier = raw_cls.replace("${arch}", arch_bits);
        let full_name = format!("{}:{classifier}", lib.name);
        let info = LibraryInfo::resolve(&full_name);
        let mut artifact = lib
            .downloads
            .as_ref()
            .and_then(|d| d.classifiers.as_ref())
            .and_then(|c| c.get(&classifier))
            .cloned()
            .unwrap_or_else(|| DownloadArtifact {
                path: info.path.clone(),
                sha1: String::new(),
                size: -1,
                url: format!("https://libraries.minecraft.net/{}", info.path),
            });
        if artifact.path.is_empty() {
            artifact.path = info.path.clone();
        }
        if artifact.url.is_empty() {
            artifact.url = format!("https://libraries.minecraft.net/{}", artifact.path);
        }
        let exclude = lib
            .extract
            .as_ref()
            .and_then(|e| e.exclude.clone())
            .unwrap_or_default();
        return Some(ResolvedLibrary {
            name: full_name,
            group_id: info.group_id,
            artifact_id: info.artifact_id,
            classifier: info.classifier,
            download: artifact,
            is_native: true,
            extract_exclude: exclude,
        });
    }

    let info = LibraryInfo::resolve(&lib.name);
    if let Some(ref dls) = lib.downloads {
        if let Some(mut art) = dls.artifact.clone() {
            if art.path.is_empty() {
                art.path = info.path.clone();
            }
            // Важно: если url пустой (как у forge universal/shim, извлекаемого из инсталлятора),
            // сохраняем пустым как маркер или резолвим позже при скачивании.
            return Some(ResolvedLibrary {
                name: lib.name.clone(),
                group_id: info.group_id,
                artifact_id: info.artifact_id,
                classifier: info.classifier,
                download: art,
                is_native: false,
                extract_exclude: Vec::new(),
            });
        }
    }

    let base_maven = lib
        .url
        .as_deref()
        .unwrap_or("https://libraries.minecraft.net/");
    let sep = if base_maven.ends_with('/') { "" } else { "/" };
    let art = DownloadArtifact {
        path: info.path.clone(),
        sha1: lib
            .checksums
            .as_ref()
            .and_then(|c| c.first())
            .cloned()
            .unwrap_or_default(),
        size: -1,
        url: format!("{base_maven}{sep}{}", info.path),
    };
    Some(ResolvedLibrary {
        name: lib.name.clone(),
        group_id: info.group_id,
        artifact_id: info.artifact_id,
        classifier: info.classifier,
        download: art,
        is_native: false,
        extract_exclude: Vec::new(),
    })
}

pub fn resolve_libraries(libs: &[RawLibrary]) -> Vec<ResolvedLibrary> {
    libs.iter().filter_map(resolve_library).collect()
}

pub fn version_json_path(shared_dir: &Path, id: &str) -> PathBuf {
    shared_dir.join("versions").join(id).join(format!("{id}.json"))
}

pub fn version_jar_path(shared_dir: &Path, mc_ver: &str) -> PathBuf {
    shared_dir
        .join("versions")
        .join(mc_ver)
        .join(format!("{mc_ver}.jar"))
}

pub fn library_path(shared_dir: &Path, rel_maven: &str) -> PathBuf {
    let mut p = shared_dir.join("libraries");
    for seg in rel_maven.split('/') {
        if !seg.is_empty() {
            p.push(seg);
        }
    }
    p
}

pub async fn parse_version(shared_dir: &Path, version_id: &str) -> AppResult<ResolvedVersion> {
    let mut chain: Vec<RawVersionJson> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cur_id = version_id.to_string();

    loop {
        if !seen.insert(cur_id.clone()) {
            return Err(LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Циклическая зависимость версий",
                cur_id,
            ));
        }
        let path = version_json_path(shared_dir, &cur_id);
        let raw = tokio::fs::read(&path).await.map_err(|_| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Отсутствует описание версии",
                format!("Не найден файл версии {}.", path.display()),
            )
        })?;
        let parsed: RawVersionJson = serde_json::from_slice(&raw).map_err(|e| {
            LauncherError::new(
                ErrorCode::MinecraftInstall,
                "Повреждённый JSON версии",
                format!("{}: {e}", path.display()),
            )
        })?;
        let next = parsed.inherits_from.clone();
        chain.push(parsed);
        match next {
            Some(parent_id) => cur_id = parent_id,
            None => break,
        }
    }

    let root = chain.last().unwrap();
    let top_id = chain.first().unwrap().id.clone();
    let minecraft_version = root
        .client_version
        .clone()
        .unwrap_or_else(|| root.id.clone());

    let mut asset_index = root.asset_index.clone();
    let mut assets = String::new();
    let mut main_class = String::new();
    let mut version_type = String::from("release");
    let mut logging = None;
    let mut java_major = None;
    let mut downloads = HashMap::new();
    let mut jvm_args = Vec::new();
    let mut game_args = Vec::new();
    let mut legacy_args = None;

    // Сохраняем порядок библиотек при перезаписи ключом group:artifact[-classifier;]
    let mut libs_order: Vec<(String, ResolvedLibrary)> = Vec::new();
    let mut natives_order: Vec<(String, ResolvedLibrary)> = Vec::new();

    for json in chain.into_iter().rev() {
        let replace = json.replace.unwrap_or(false);
        if let Some(args) = json.arguments {
            if replace {
                jvm_args = args.jvm;
                game_args = args.game;
            } else {
                jvm_args.extend(args.jvm);
                game_args.extend(args.game);
            }
        }
        if let Some(mc_args) = json.minecraft_arguments {
            legacy_args = Some(mc_args);
        }
        if let Some(mc) = json.main_class {
            if !mc.is_empty() {
                main_class = mc;
            }
        }
        if let Some(t) = json.version_type {
            if !t.is_empty() {
                version_type = t;
            }
        }
        if let Some(a) = json.assets {
            if !a.is_empty() {
                assets = a;
            }
        }
        if let Some(ai) = json.asset_index {
            asset_index = Some(ai);
        }
        if let Some(l) = json.logging.and_then(|s| s.client) {
            logging = Some(l);
        }
        if let Some(jv) = json.java_version {
            java_major = Some(jv.major_version);
        }
        for (k, v) in json.downloads {
            downloads.insert(k, v);
        }
        for lib in resolve_libraries(&json.libraries) {
            let mut key = format!("{}:{}", lib.group_id, lib.artifact_id);
            if !lib.classifier.is_empty() {
                key.push('-');
                key.push_str(&lib.classifier);
                key.push(';');
            }
            let target_vec = if lib.is_native {
                &mut natives_order
            } else {
                &mut libs_order
            };
            if let Some(pos) = target_vec.iter().position(|(k, _)| k == &key) {
                target_vec[pos].1 = lib;
            } else {
                target_vec.push((key, lib));
            }
        }
    }

    if main_class.is_empty() {
        return Err(LauncherError::new(
            ErrorCode::MinecraftInstall,
            "Некорректное описание версии",
            format!("Отсутствует mainClass в {top_id}"),
        ));
    }

    let mut libraries: Vec<ResolvedLibrary> = libs_order.into_iter().map(|(_, l)| l).collect();
    libraries.extend(natives_order.into_iter().map(|(_, l)| l));

    Ok(ResolvedVersion {
        id: top_id,
        minecraft_version,
        main_class,
        version_type,
        assets,
        asset_index,
        downloads,
        libraries,
        jvm_args,
        game_args,
        legacy_args,
        logging,
        java_major,
    })
}
