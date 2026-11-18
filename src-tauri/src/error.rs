use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Offline,
    GithubUnavailable,
    ManifestInvalid,
    PackMismatch,
    DownloadFailed,
    Integrity,
    DiskSpace,
    Java,
    MinecraftInstall,
    Conflict,
    Cancelled,
    Busy,
    NoProfile,
    LaunchFailed,
    Filesystem,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserError {
    pub code: ErrorCode,
    pub title: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LauncherError {
    pub code: ErrorCode,
    pub title: String,
    pub message: String,
    pub hint: Option<String>,
}

impl LauncherError {
    pub fn new(
        code: ErrorCode,
        title: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            title: title.into(),
            message: message.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn cancelled() -> Self {
        Self::new(
            ErrorCode::Cancelled,
            "Операция отменена",
            "Операция отменена пользователем.",
        )
        .with_hint("Нажмите кнопку ещё раз, чтобы продолжить с места остановки.")
    }

    pub fn is_cancelled(&self) -> bool {
        self.code == ErrorCode::Cancelled
    }

    pub fn to_user_error(&self) -> UserError {
        UserError {
            code: self.code,
            title: self.title.clone(),
            message: self.message.clone(),
            hint: self.hint.clone(),
        }
    }
}

impl std::fmt::Display for LauncherError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.title, self.message)
    }
}

impl std::error::Error for LauncherError {}

impl From<std::io::Error> for LauncherError {
    fn from(err: std::io::Error) -> Self {
        let raw_os = err.raw_os_error();
        // Windows ERROR_DISK_FULL (112) or Unix ENOSPC (28)
        if err.kind() == std::io::ErrorKind::StorageFull
            || raw_os == Some(112)
            || raw_os == Some(28)
        {
            return LauncherError::new(
                ErrorCode::DiskSpace,
                "Недостаточно места на диске",
                "Во время записи закончилось свободное место.",
            )
            .with_hint(
                "Освободите место или выберите другую папку установки в настройках, затем повторите.",
            );
        }
        if err.kind() == std::io::ErrorKind::PermissionDenied
            || raw_os == Some(5)
            || raw_os == Some(32)
        {
            return LauncherError::new(
                ErrorCode::Filesystem,
                "Нет доступа к файлу",
                format!("Не удалось изменить файл: {err}."),
            )
            .with_hint(
                "Закройте игру и программы, которые могут держать файл открытым (антивирус, архиватор), и повторите.",
            );
        }
        LauncherError::new(
            ErrorCode::Filesystem,
            "Ошибка файловой системы",
            err.to_string(),
        )
    }
}

pub type AppResult<T> = Result<T, LauncherError>;

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ResultDto<T: Serialize> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: UserError },
}

impl<T: Serialize> ResultDto<T> {
    pub fn from_result(res: AppResult<T>) -> Self {
        match res {
            Ok(value) => Self::Ok { ok: true, value },
            Err(err) => Self::Err {
                ok: false,
                error: err.to_user_error(),
            },
        }
    }
}

#[derive(Clone, Default)]
pub struct CancelToken {
    aborted: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> AppResult<()> {
        if self.is_aborted() {
            Err(LauncherError::cancelled())
        } else {
            Ok(())
        }
    }

    pub async fn cancelled(&self) {
        if self.is_aborted() {
            return;
        }
        self.notify.notified().await;
    }
}
