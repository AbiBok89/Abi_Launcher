use crate::error::UserError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeSetting {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AfterLaunch {
    Keep,
    Minimize,
    Hide,
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRepo {
    pub repo: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default = "default_pack_path")]
    pub path: String,
}

fn default_branch() -> String {
    "main".to_string()
}

pub fn default_pack_path() -> String {
    "ForLauncher/pack.json".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOverride {
    #[serde(default)]
    pub memory_mb: Option<u32>,
    #[serde(default)]
    pub java_path: Option<String>,
    #[serde(default)]
    pub extra_jvm_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemeSetting,
    pub install_dir: String,
    pub catalog_url: String,
    pub custom_repos: Vec<CustomRepo>,
    pub default_memory_mb: Option<u32>,
    pub java_path: Option<String>,
    pub resolution: Resolution,
    pub after_launch: AfterLaunch,
    pub full_verify_on_launch: bool,
    pub auto_join_server: bool,
    #[serde(default)]
    pub extra_jvm_args: String,
    #[serde(default = "default_true")]
    pub auto_check_launcher_updates: bool,
    #[serde(default)]
    pub pack_overrides: HashMap<String, PackOverride>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionPatch {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fullscreen: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<ThemeSetting>,
    pub install_dir: Option<String>,
    pub catalog_url: Option<String>,
    pub custom_repos: Option<Vec<CustomRepo>>,
    pub default_memory_mb: Option<Option<u32>>,
    pub java_path: Option<Option<String>>,
    pub resolution: Option<ResolutionPatch>,
    pub after_launch: Option<AfterLaunch>,
    pub full_verify_on_launch: Option<bool>,
    pub auto_join_server: Option<bool>,
    pub extra_jvm_args: Option<String>,
    pub auto_check_launcher_updates: Option<bool>,
    pub pack_overrides: Option<HashMap<String, PackOverride>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub uuid: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesState {
    pub profiles: Vec<Profile>,
    pub selected_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Loader {
    Vanilla,
    Fabric { version: String },
    Forge { version: String },
    Neoforge { version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    pub name: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PackStatus {
    NotInstalled,
    Checking,
    Downloading,
    UpdateAvailable,
    Ready,
    Conflict,
    Error,
    Launching,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSourceView {
    pub repo: String,
    pub branch: String,
    pub official: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    Modified,
    Untracked,
    ObsoleteModified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConflictChoice {
    Replace,
    Keep,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub path: String,
    pub kind: ConflictKind,
    pub can_keep: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackView {
    pub key: String,
    pub id: String,
    pub source: PackSourceView,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub cover_data_url: Option<String>,
    pub version: String,
    pub minecraft: String,
    pub loader: Loader,
    pub recommended_memory_mb: u32,
    pub min_memory_mb: Option<u32>,
    pub server: Option<ServerRef>,
    pub installed_version: Option<String>,
    pub status: PackStatus,
    pub last_error: Option<UserError>,
    pub conflicts: Vec<ConflictView>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackLoadError {
    pub repo: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResult {
    pub packs: Vec<PackView>,
    pub errors: Vec<PackLoadError>,
    pub from_cache: bool,
    pub catalog_error: Option<String>,
    pub loaded_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Check,
    Verify,
    Download,
    Extract,
    Apply,
    Java,
    Minecraft,
    Loader,
    Launch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub pack_key: String,
    pub operation: String,
    pub stage: Stage,
    pub label: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: usize,
    pub files_total: usize,
    pub speed: u64,
    pub cancellable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub scope: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInfoView {
    pub path: String,
    pub version: String,
    pub major_version: u32,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub online: bool,
    pub players_online: Option<u32>,
    pub players_max: Option<u32>,
    pub version: Option<String>,
    pub motd: Option<String>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsItemView {
    pub id: String,
    pub date: String,
    pub title: String,
    pub body: String,
    pub pack_version: Option<String>,
    pub pack_key: String,
    pub pack_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsResult {
    pub items: Vec<NewsItemView>,
    pub errors: Vec<PackLoadError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub electron: String,
    pub node: String,
    pub platform: String,
    pub arch: String,
    pub total_memory_mb: u64,
    pub user_data_dir: String,
    pub default_install_dir: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PackSubfolder {
    Root,
    Mods,
    Screenshots,
    CrashReports,
    Logs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportView {
    pub file_name: String,
    pub modified_at: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEvent {
    pub pack_key: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_report_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStateEvent {
    pub pack_key: String,
    pub status: PackStatus,
    pub installed_version: Option<String>,
    pub last_error: Option<UserError>,
    pub conflicts: Vec<ConflictView>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LauncherUpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Downloaded,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallMode {
    Portable,
    Installer,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherReleaseAssetInfo {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpdateState {
    pub phase: LauncherUpdatePhase,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_name: Option<String>,
    pub release_notes: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub asset: Option<LauncherReleaseAssetInfo>,
    pub downloaded_path: Option<String>,
    pub progress_bytes_done: u64,
    pub progress_bytes_total: u64,
    pub progress_speed: u64,
    pub error: Option<String>,
    pub can_auto_install: bool,
    pub install_mode: InstallMode,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlayOptions {
    pub resolutions: Option<HashMap<String, ConflictChoice>>,
    pub join_server: Option<bool>,
}

// --- Удалённые JSON-схемы ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryJson {
    pub repo: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default = "default_pack_path")]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogJson {
    pub schema_version: u32,
    #[serde(default)]
    pub name: Option<String>,
    pub packs: Vec<CatalogEntryJson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfoJson {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cover: Option<String>,
    pub version: String,
    pub minecraft: String,
    pub loader: Loader,
    #[serde(default = "default_recommended_mem")]
    pub recommended_memory_mb: u32,
    #[serde(default)]
    pub min_memory_mb: Option<u32>,
    pub manifest_url: String,
    #[serde(default)]
    pub server: Option<ServerRef>,
    #[serde(default = "default_news_path")]
    pub news: String,
}

fn default_recommended_mem() -> u32 {
    8192
}

fn default_news_path() -> String {
    "ForLauncher/news.json".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileMode {
    Managed,
    Initial,
}

impl Default for FileMode {
    fn default() -> Self {
        FileMode::Managed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ManifestFileSource {
    Url { url: String },
    Archive { archive: String, entry: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub mode: FileMode,
    #[serde(default = "default_true")]
    pub required: bool,
    pub source: ManifestFileSource,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawManifestFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub mode: FileMode,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default)]
    pub source: Option<ManifestFileSource>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestArchive {
    pub id: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestJava {
    pub major: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestJson {
    pub schema_version: u32,
    pub pack_id: String,
    pub version: String,
    #[serde(default)]
    pub created_at: Option<String>,
    pub minecraft: String,
    pub loader: Loader,
    #[serde(default)]
    pub java: Option<ManifestJava>,
    #[serde(default)]
    pub archives: Vec<ManifestArchive>,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawManifestJson {
    pub schema_version: u32,
    pub pack_id: String,
    pub version: String,
    #[serde(default)]
    pub created_at: Option<String>,
    pub minecraft: String,
    pub loader: Loader,
    #[serde(default)]
    pub java: Option<ManifestJava>,
    #[serde(default)]
    pub archives: Vec<ManifestArchive>,
    pub files: Vec<RawManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsItemJson {
    pub id: String,
    pub date: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub pack_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewsJson {
    pub schema_version: u32,
    pub items: Vec<NewsItemJson>,
}
