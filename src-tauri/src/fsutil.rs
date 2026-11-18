use crate::error::{AppResult, ErrorCode, LauncherError};
use crate::paths::check_relative_path;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tokio::io::AsyncWriteExt;

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp);
                }
            }
            _ => out.push(comp),
        }
    }
    out
}

pub fn abs_lexical(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexical(path)
    } else if let Ok(cwd) = std::env::current_dir() {
        normalize_lexical(&cwd.join(path))
    } else {
        normalize_lexical(path)
    }
}

pub fn is_inside(base: &Path, target: &Path) -> bool {
    let b = abs_lexical(base);
    let t = abs_lexical(target);
    #[cfg(windows)]
    {
        let b_str = b.to_string_lossy().to_lowercase();
        let t_str = t.to_string_lossy().to_lowercase();
        if b_str == t_str {
            return false;
        }
        t_str.starts_with(&format!("{}\\", b_str.trim_end_matches(['\\', '/'])))
    }
    #[cfg(not(windows))]
    {
        t != b && t.starts_with(&b)
    }
}

pub fn safe_join(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if let Some(err) = check_relative_path(rel) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь",
            format!("Путь «{rel}» отклонён: {err}."),
        ));
    }
    let base = abs_lexical(root);
    let mut target = base.clone();
    for seg in rel.split('/') {
        target.push(seg);
    }
    if !is_inside(&base, &target) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь",
            format!("Путь «{rel}» выходит за пределы папки сборки."),
        ));
    }
    Ok(target)
}

pub async fn assert_real_inside(root: &Path, target: &Path) -> AppResult<()> {
    let real_root = tokio::fs::canonicalize(root).await?;
    let mut probe = target.parent().unwrap_or(target).to_path_buf();
    loop {
        if tokio::fs::symlink_metadata(&probe).await.is_ok() {
            break;
        }
        match probe.parent() {
            Some(p) if p != probe => probe = p.to_path_buf(),
            _ => return Ok(()),
        }
    }
    let real = tokio::fs::canonicalize(&probe).await?;
    if real != real_root && !real.starts_with(&real_root) {
        return Err(LauncherError::new(
            ErrorCode::Filesystem,
            "Небезопасная ссылка",
            format!(
                "Каталог {} указывает за пределы папки сборки.",
                probe.display()
            ),
        )
        .with_hint("Удалите символическую ссылку или junction из папки сборки."));
    }
    if let Ok(meta) = tokio::fs::symlink_metadata(target).await {
        if meta.file_type().is_symlink() {
            return Err(LauncherError::new(
                ErrorCode::Filesystem,
                "Небезопасная ссылка",
                format!("Файл {} является символической ссылкой.", target.display()),
            )
            .with_hint("Удалите ссылку и повторите."));
        }
    }
    Ok(())
}

pub async fn ensure_dir(p: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(p).await?;
    Ok(())
}

pub async fn exists_async(p: &Path) -> bool {
    tokio::fs::try_exists(p).await.unwrap_or(false)
}

pub async fn remove_quiet(p: &Path) {
    if let Ok(meta) = tokio::fs::symlink_metadata(p).await {
        if meta.is_dir() {
            let _ = tokio::fs::remove_dir_all(p).await;
        } else {
            let _ = tokio::fs::remove_file(p).await;
        }
    }
}

pub async fn rename_with_retry(from: &Path, to: &Path) -> AppResult<()> {
    let mut last_err: Option<std::io::Error> = None;
    for i in 0..6 {
        match tokio::fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if i < 5 {
                    tokio::time::sleep(std::time::Duration::from_millis(80 * (i + 1) as u64)).await;
                    continue;
                }
            }
        }
    }
    // Если rename упёрся в существование целевого файла на Windows или cross-device — пробуем copy+unlink
    if let Some(parent) = to.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::remove_file(to).await;
    match tokio::fs::rename(from, to).await {
        Ok(()) => Ok(()),
        Err(_) => {
            if tokio::fs::copy(from, to).await.is_ok() {
                let _ = tokio::fs::remove_file(from).await;
                Ok(())
            } else {
                Err(LauncherError::from(last_err.unwrap_or_else(|| {
                    std::io::Error::other("rename failed")
                })))
            }
        }
    }
}

pub async fn write_json_atomic<T: Serialize + ?Sized>(path: &Path, data: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent).await?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("data"),
        std::process::id(),
        stamp
    ));
    let json = serde_json::to_vec_pretty(data).map_err(|e| {
        LauncherError::new(
            ErrorCode::Unknown,
            "Ошибка сериализации JSON",
            e.to_string(),
        )
    })?;
    {
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(&json).await?;
        f.sync_all().await?;
    }
    rename_with_retry(&tmp, path).await
}

pub async fn read_json_file<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let parsed = serde_json::from_slice(&bytes).map_err(|e| {
                LauncherError::new(
                    ErrorCode::Filesystem,
                    "Ошибка чтения JSON",
                    format!("{}: {e}", path.display()),
                )
            })?;
            Ok(Some(parsed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub async fn assert_free_space(target_dir: &Path, required_bytes: u64) -> AppResult<()> {
    if required_bytes == 0 {
        return Ok(());
    }
    let mut probe = target_dir.to_path_buf();
    while tokio::fs::symlink_metadata(&probe).await.is_err() {
        match probe.parent() {
            Some(p) if p != probe => probe = p.to_path_buf(),
            _ => return Ok(()),
        }
    }
    let free = free_disk_bytes(&probe);
    if let Some(available) = free {
        let safety_margin = 64 * 1024 * 1024_u64;
        if available < required_bytes.saturating_add(safety_margin) {
            let need_mb = (required_bytes + safety_margin) / (1024 * 1024);
            let avail_mb = available / (1024 * 1024);
            return Err(LauncherError::new(
                ErrorCode::DiskSpace,
                "Недостаточно места на диске",
                format!(
                    "Требуется около {need_mb} МБ, но свободно только {avail_mb} МБ в «{}».",
                    probe.display()
                ),
            )
            .with_hint("Освободите место или выберите другой диск в настройках лаунчера."));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn free_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut avail: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut avail as *mut u64,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok != 0 {
        Some(avail)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn free_disk_bytes(_path: &Path) -> Option<u64> {
    None
}
