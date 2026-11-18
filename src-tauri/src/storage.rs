use crate::error::{AppResult, ErrorCode, LauncherError};
use crate::fsutil::{abs_lexical, ensure_dir, read_json_file, write_json_atomic};
use crate::github::normalize_catalog_url;
use crate::paths::check_relative_path;
use crate::types::{
    AfterLaunch, CustomRepo, Profile, ProfilesState, Resolution, Settings, SettingsPatch,
    ThemeSetting,
};
use chrono::Utc;
use md5::{Digest, Md5};
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

pub const DEFAULT_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/AbiBok89/Abi_Launcher/main/catalog/catalog.json";

pub fn default_custom_repos() -> Vec<CustomRepo> {
    vec![CustomRepo {
        repo: "AbiBok89/abi_tfg".to_string(),
        branch: "main".to_string(),
        path: "ForLauncher/pack.json".to_string(),
    }]
}

#[cfg(windows)]
pub fn total_system_memory_mb() -> u64 {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut stat: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    stat.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut stat as *mut MEMORYSTATUSEX) };
    if ok != 0 {
        (stat.ullTotalPhys / (1024 * 1024)).max(2048)
    } else {
        16384
    }
}

#[cfg(not(windows))]
pub fn total_system_memory_mb() -> u64 {
    if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                if let Some(kb_str) = rest.split_whitespace().next() {
                    if let Ok(kb) = kb_str.parse::<u64>() {
                        return (kb / 1024).max(2048);
                    }
                }
            }
        }
    }
    16384
}

pub fn compute_default_memory_mb(total_mb: u64) -> u32 {
    if total_mb >= 10240 {
        return 8192;
    }
    let safe = ((total_mb.saturating_sub(1024)) / 512) * 512;
    safe.max(2048) as u32
}

pub fn offline_uuid_from_name(name: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("OfflinePlayer:{name}").as_bytes());
    let mut hash = hasher.finalize();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    let h = hex::encode(hash);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

pub fn validate_nickname(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let re = Regex::new(r"^[A-Za-z0-9_]{3,16}$").unwrap();
    if !re.is_match(name) {
        return Err(LauncherError::new(
            ErrorCode::NoProfile,
            "Некорректный никнейм",
            "Никнейм должен содержать от 3 до 16 символов: латинские буквы, цифры и знак подчёркивания (_).",
        ));
    }
    Ok(name.to_string())
}

pub fn default_settings(user_data_dir: &Path) -> Settings {
    Settings {
        theme: ThemeSetting::System,
        install_dir: user_data_dir.join("gamedata").to_string_lossy().into_owned(),
        catalog_url: DEFAULT_CATALOG_URL.to_string(),
        custom_repos: default_custom_repos(),
        default_memory_mb: Some(compute_default_memory_mb(total_system_memory_mb())),
        java_path: None,
        resolution: Resolution {
            width: 1280,
            height: 720,
            fullscreen: false,
        },
        after_launch: AfterLaunch::Keep,
        full_verify_on_launch: false,
        auto_join_server: true,
        extra_jvm_args: String::new(),
        auto_check_launcher_updates: true,
        pack_overrides: HashMap::new(),
    }
}

fn validate_jvm_args(s: &str) -> AppResult<()> {
    if s.chars().count() > 2000 || s.contains('\n') || s.contains('\r') || s.contains('\0') {
        return Err(LauncherError::new(
            ErrorCode::Unknown,
            "Некорректные JVM-аргументы",
            "Аргументы JVM не должны превышать 2000 символов или содержать переносы строк.",
        ));
    }
    Ok(())
}

async fn check_writable(dir: &Path) -> bool {
    if ensure_dir(dir).await.is_err() {
        return false;
    }
    let probe = dir.join(format!(".abi-write-test-{}", std::process::id()));
    match tokio::fs::write(&probe, b"ok").await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&probe).await;
            true
        }
        Err(_) => false,
    }
}

fn clamp_settings_limits(mut s: Settings) -> Settings {
    let total_mb = total_system_memory_mb() as u32;
    s.default_memory_mb = s
        .default_memory_mb
        .map(|m| m.clamp(1024, total_mb));
    for ov in s.pack_overrides.values_mut() {
        ov.memory_mb = ov.memory_mb.map(|m| m.clamp(1024, total_mb));
    }
    s
}

fn validate_custom_repo(r: &CustomRepo) -> AppResult<()> {
    let repo_re = Regex::new(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$").unwrap();
    let branch_re = Regex::new(r"^[A-Za-z0-9._/-]{1,100}$").unwrap();
    if !repo_re.is_match(&r.repo) || r.repo.contains("..") {
        return Err(LauncherError::new(
            ErrorCode::Unknown,
            "Некорректный репозиторий",
            r.repo.clone(),
        ));
    }
    if !branch_re.is_match(&r.branch) || r.branch.contains("..") {
        return Err(LauncherError::new(
            ErrorCode::Unknown,
            "Некорректная ветка",
            r.branch.clone(),
        ));
    }
    if check_relative_path(&r.path).is_some() {
        return Err(LauncherError::new(
            ErrorCode::Unknown,
            "Некорректный путь в репозитории",
            r.path.clone(),
        ));
    }
    Ok(())
}

pub struct SettingsStore {
    user_data_dir: PathBuf,
    file_path: PathBuf,
    cached: Mutex<Option<Settings>>,
}

impl SettingsStore {
    pub fn new(user_data_dir: PathBuf) -> Self {
        let file_path = user_data_dir.join("settings.json");
        Self {
            user_data_dir,
            file_path,
            cached: Mutex::new(None),
        }
    }

    pub async fn load(&self) -> AppResult<Settings> {
        {
            let g = self.cached.lock().await;
            if let Some(ref s) = *g {
                return Ok(s.clone());
            }
        }
        let defaults = default_settings(&self.user_data_dir);
        let raw_opt: Option<Settings> = read_json_file(&self.file_path).await.ok().flatten();
        let needs_write = raw_opt.is_none();
        let normalized = clamp_settings_limits(raw_opt.unwrap_or_else(|| defaults.clone()));
        if needs_write {
            let _ = write_json_atomic(&self.file_path, &normalized).await;
        }
        let mut g = self.cached.lock().await;
        *g = Some(normalized.clone());
        Ok(normalized)
    }

    pub async fn update(&self, patch: SettingsPatch) -> AppResult<Settings> {
        let mut next = self.load().await?;
        if let Some(theme) = patch.theme {
            next.theme = theme;
        }
        if let Some(install_dir) = patch.install_dir {
            let trimmed = install_dir.trim();
            if trimmed.is_empty() || trimmed.len() > 1024 {
                return Err(LauncherError::new(
                    ErrorCode::Filesystem,
                    "Некорректная папка",
                    "Укажите путь к папке установки.",
                ));
            }
            let target = abs_lexical(Path::new(trimmed));
            if !check_writable(&target).await {
                return Err(
                    LauncherError::new(
                        ErrorCode::Filesystem,
                        "Папка недоступна для записи",
                        format!("Лаунчер не может создавать файлы в папке «{}».", target.display()),
                    )
                    .with_hint("Выберите другую папку, например в каталоге пользователя."),
                );
            }
            next.install_dir = target.to_string_lossy().into_owned();
        }
        if let Some(catalog_url) = patch.catalog_url {
            next.catalog_url = normalize_catalog_url(&catalog_url)?;
        }
        if let Some(repos) = patch.custom_repos {
            if repos.len() > 100 {
                return Err(LauncherError::new(
                    ErrorCode::Unknown,
                    "Слишком много репозиториев",
                    "Максимум 100 репозиториев.",
                ));
            }
            for r in &repos {
                validate_custom_repo(r)?;
            }
            next.custom_repos = repos;
        }
        if let Some(def_mem) = patch.default_memory_mb {
            next.default_memory_mb = def_mem;
        }
        if let Some(java_path) = patch.java_path {
            next.java_path = java_path
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        if let Some(res) = patch.resolution {
            if let Some(w) = res.width {
                if !(640..=7680).contains(&w) {
                    return Err(LauncherError::new(
                        ErrorCode::Unknown,
                        "Некорректная ширина окна",
                        "Допустимо от 640 до 7680.",
                    ));
                }
                next.resolution.width = w;
            }
            if let Some(h) = res.height {
                if !(480..=4320).contains(&h) {
                    return Err(LauncherError::new(
                        ErrorCode::Unknown,
                        "Некорректная высота окна",
                        "Допустимо от 480 до 4320.",
                    ));
                }
                next.resolution.height = h;
            }
            if let Some(fs) = res.fullscreen {
                next.resolution.fullscreen = fs;
            }
        }
        if let Some(al) = patch.after_launch {
            next.after_launch = al;
        }
        if let Some(fv) = patch.full_verify_on_launch {
            next.full_verify_on_launch = fv;
        }
        if let Some(aj) = patch.auto_join_server {
            next.auto_join_server = aj;
        }
        if let Some(jvm) = patch.extra_jvm_args {
            validate_jvm_args(&jvm)?;
            next.extra_jvm_args = jvm;
        }
        if let Some(ac) = patch.auto_check_launcher_updates {
            next.auto_check_launcher_updates = ac;
        }
        if let Some(ov) = patch.pack_overrides {
            next.pack_overrides = ov;
        }

        let total_mb = total_system_memory_mb() as u32;
        if let Some(mem) = next.default_memory_mb {
            if mem < 1024 || mem > total_mb {
                return Err(LauncherError::new(
                    ErrorCode::Unknown,
                    "Некорректный объём памяти",
                    format!("Укажите значение от 1024 до {total_mb} МБ."),
                ));
            }
        }
        for (key, ov) in &next.pack_overrides {
            if let Some(mem) = ov.memory_mb {
                if mem < 1024 || mem > total_mb {
                    return Err(LauncherError::new(
                        ErrorCode::Unknown,
                        "Некорректный объём памяти для сборки",
                        format!("Для сборки «{key}» укажите от 1024 до {total_mb} МБ."),
                    ));
                }
            }
            if let Some(ref jvm) = ov.extra_jvm_args {
                validate_jvm_args(jvm)?;
            }
        }

        let clamped = clamp_settings_limits(next);
        write_json_atomic(&self.file_path, &clamped).await?;
        let mut g = self.cached.lock().await;
        *g = Some(clamped.clone());
        Ok(clamped)
    }
}

pub struct ProfileStore {
    file_path: PathBuf,
    state: Mutex<Option<ProfilesState>>,
}

impl ProfileStore {
    pub fn new(user_data_dir: PathBuf) -> Self {
        Self {
            file_path: user_data_dir.join("profiles.json"),
            state: Mutex::new(None),
        }
    }

    pub async fn load(&self) -> AppResult<ProfilesState> {
        {
            let g = self.state.lock().await;
            if let Some(ref st) = *g {
                return Ok(st.clone());
            }
        }
        let parsed: Option<ProfilesState> = read_json_file(&self.file_path).await.ok().flatten();
        let st = match parsed {
            Some(mut p) => {
                if let Some(ref sel) = p.selected_id {
                    if !p.profiles.iter().any(|x| &x.id == sel) {
                        p.selected_id = p.profiles.first().map(|x| x.id.clone());
                    }
                } else {
                    p.selected_id = p.profiles.first().map(|x| x.id.clone());
                }
                p
            }
            None => ProfilesState::default(),
        };
        let mut g = self.state.lock().await;
        *g = Some(st.clone());
        Ok(st)
    }

    pub async fn create_profile(&self, raw_name: &str) -> AppResult<ProfilesState> {
        let name = validate_nickname(raw_name)?;
        let mut st = self.load().await?;
        if st
            .profiles
            .iter()
            .any(|p| p.name.eq_ignore_ascii_case(&name))
        {
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Профиль уже существует",
                format!("Профиль с именем «{name}» уже создан."),
            ));
        }
        let id = offline_uuid_from_name(&format!(
            "profile:{name}:{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let profile = Profile {
            id: id.clone(),
            name: name.clone(),
            uuid: offline_uuid_from_name(&name),
            created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        st.profiles.push(profile);
        st.selected_id = Some(id);
        write_json_atomic(&self.file_path, &st).await?;
        let mut g = self.state.lock().await;
        *g = Some(st.clone());
        Ok(st)
    }

    pub async fn rename_profile(&self, id: &str, raw_name: &str) -> AppResult<ProfilesState> {
        let name = validate_nickname(raw_name)?;
        let mut st = self.load().await?;
        if st
            .profiles
            .iter()
            .any(|p| p.id != id && p.name.eq_ignore_ascii_case(&name))
        {
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Никнейм занят",
                format!("Другой профиль уже использует никнейм «{name}»."),
            ));
        }
        let Some(target) = st.profiles.iter_mut().find(|p| p.id == id) else {
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Профиль не найден",
                "Указанный профиль не найден.",
            ));
        };
        target.name = name.clone();
        target.uuid = offline_uuid_from_name(&name);
        write_json_atomic(&self.file_path, &st).await?;
        let mut g = self.state.lock().await;
        *g = Some(st.clone());
        Ok(st)
    }

    pub async fn delete_profile(&self, id: &str) -> AppResult<ProfilesState> {
        let mut st = self.load().await?;
        st.profiles.retain(|p| p.id != id);
        if st.selected_id.as_deref() == Some(id) {
            st.selected_id = st.profiles.first().map(|p| p.id.clone());
        }
        write_json_atomic(&self.file_path, &st).await?;
        let mut g = self.state.lock().await;
        *g = Some(st.clone());
        Ok(st)
    }

    pub async fn select_profile(&self, id: &str) -> AppResult<ProfilesState> {
        let mut st = self.load().await?;
        if !st.profiles.iter().any(|p| p.id == id) {
            return Err(LauncherError::new(
                ErrorCode::NoProfile,
                "Профиль не найден",
                "Указанный профиль не найден.",
            ));
        }
        st.selected_id = Some(id.to_string());
        write_json_atomic(&self.file_path, &st).await?;
        let mut g = self.state.lock().await;
        *g = Some(st.clone());
        Ok(st)
    }

    pub async fn get_selected_profile(&self) -> AppResult<Option<Profile>> {
        let st = self.load().await?;
        let Some(sel) = st.selected_id else {
            return Ok(None);
        };
        Ok(st.profiles.into_iter().find(|p| p.id == sel))
    }
}
