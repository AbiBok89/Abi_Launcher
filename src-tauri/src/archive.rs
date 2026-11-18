use crate::error::{AppResult, CancelToken, ErrorCode, LauncherError};
use crate::fsutil::{abs_lexical, is_inside, rename_with_retry};
use crate::paths::check_relative_path;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tar::Archive;
use zip::ZipArchive;

#[derive(Clone)]
pub struct ZipExtractSpec {
    pub target_abs_path: PathBuf,
    pub expected_size: u64,
    pub expected_sha256: String,
}

fn is_zip_symlink(unix_mode: Option<u32>) -> bool {
    unix_mode.is_some_and(|m| (m & 0o170000) == 0o120000)
}

fn validate_zip_entry_name(raw_name: &str) -> AppResult<(String, bool)> {
    let is_dir = raw_name.ends_with('/');
    let clean = raw_name.strip_suffix('/').unwrap_or(raw_name);
    if clean.is_empty() && is_dir {
        return Ok((String::new(), true));
    }
    if let Some(err) = check_relative_path(clean) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь в архиве",
            format!("Архив содержит недопустимый путь «{raw_name}»: {err}."),
        ));
    }
    Ok((clean.to_string(), is_dir))
}

pub async fn extract_zip_entries<F>(
    zip_path: &Path,
    entries: HashMap<String, ZipExtractSpec>,
    dest_root: &Path,
    cancel: &CancelToken,
    mut on_file_done: F,
) -> AppResult<()>
where
    F: FnMut(&str, u64) + Send + 'static,
{
    cancel.check()?;
    let resolved_root = abs_lexical(dest_root);
    fs::create_dir_all(&resolved_root)?;

    for (entry_name, spec) in &entries {
        if let Some(err) = check_relative_path(entry_name) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Небезопасный путь в архиве",
                format!("Путь «{entry_name}»: {err}."),
            ));
        }
        let target = abs_lexical(&spec.target_abs_path);
        if !is_inside(&resolved_root, &target) {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Небезопасный путь распаковки",
                format!("Путь назначения для «{entry_name}» выходит за пределы каталога."),
            ));
        }
    }

    let zip_path = zip_path.to_path_buf();
    let cancel_bg = cancel.clone();
    let mut remaining = entries;

    let done_files = tokio::task::spawn_blocking(move || -> AppResult<Vec<(PathBuf, PathBuf, String, u64)>> {
        let file = File::open(&zip_path).map_err(|e| {
            LauncherError::new(
                ErrorCode::Integrity,
                "Повреждённый архив",
                format!("Не удалось открыть ZIP-архив: {e}."),
            )
        })?;
        let mut zip = ZipArchive::new(file).map_err(|e| {
            LauncherError::new(
                ErrorCode::Integrity,
                "Повреждённый архив",
                format!("Не удалось открыть ZIP-архив: {e}."),
            )
        })?;

        let mut extracted = Vec::with_capacity(remaining.len());
        let real_root = fs::canonicalize(&resolved_root)?;
        let mut buf = vec![0u8; 64 * 1024];

        for i in 0..zip.len() {
            cancel_bg.check()?;
            let mut entry = zip.by_index(i).map_err(|e| {
                LauncherError::new(
                    ErrorCode::Integrity,
                    "Повреждённый архив",
                    format!("Ошибка чтения ZIP: {e}."),
                )
            })?;
            let raw_name = entry.name().to_string();
            if is_zip_symlink(entry.unix_mode()) {
                return Err(LauncherError::new(
                    ErrorCode::ManifestInvalid,
                    "Символическая ссылка в архиве",
                    format!("Архив содержит запрещённую символическую ссылку «{raw_name}»."),
                ));
            }
            let (clean, is_dir) = validate_zip_entry_name(&raw_name)?;
            if is_dir {
                continue;
            }
            let Some(spec) = remaining.remove(&clean) else {
                continue;
            };
            let target = abs_lexical(&spec.target_abs_path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
                let real_parent = fs::canonicalize(parent)?;
                if real_parent != real_root && !real_parent.starts_with(&real_root) {
                    return Err(LauncherError::new(
                        ErrorCode::Filesystem,
                        "Небезопасная ссылка",
                        format!("Каталог {} выходит за пределы сборки.", parent.display()),
                    ));
                }
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let tmp = PathBuf::from(format!("{}.{}.{}.tmp", target.display(), std::process::id(), stamp));
            let mut out = File::create(&tmp)?;
            let mut hasher = Sha256::new();
            let mut written: u64 = 0;

            let res: AppResult<()> = (|| {
                loop {
                    cancel_bg.check()?;
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    written += n as u64;
                    if written > spec.expected_size {
                        return Err(LauncherError::new(
                            ErrorCode::Integrity,
                            "Повреждённый архив",
                            format!(
                                "Файл «{clean}» в архиве превышает заявленный размер ({} байт).",
                                spec.expected_size
                            ),
                        ));
                    }
                    hasher.update(&buf[..n]);
                    out.write_all(&buf[..n])?;
                }
                out.flush()?;
                if written != spec.expected_size {
                    return Err(LauncherError::new(
                        ErrorCode::Integrity,
                        "Повреждённый архив",
                        format!(
                            "Размер файла «{clean}» ({written}) не совпал с манифестом ({}).",
                            spec.expected_size
                        ),
                    ));
                }
                let actual = hex::encode(hasher.finalize());
                if !actual.eq_ignore_ascii_case(&spec.expected_sha256) {
                    return Err(LauncherError::new(
                        ErrorCode::Integrity,
                        "Повреждённый файл в архиве",
                        format!("Контрольная сумма файла «{clean}» не совпала с манифестом."),
                    ));
                }
                Ok(())
            })();

            if let Err(e) = res {
                drop(out);
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
            extracted.push((tmp, target, clean, written));
        }

        if !remaining.is_empty() {
            let first = remaining.keys().next().cloned().unwrap_or_default();
            return Err(
                LauncherError::new(
                    ErrorCode::Integrity,
                    "Неполный архив",
                    format!("В архиве отсутствует ожидаемый файл «{first}»."),
                )
                .with_hint("Проверьте публикацию релиза или пересоберите архивы манифеста."),
            );
        }

        Ok(extracted)
    })
    .await
    .map_err(|e| LauncherError::new(ErrorCode::Unknown, "Ошибка фоновой задачи", e.to_string()))??;

    for (tmp, target, clean, written) in done_files {
        rename_with_retry(&tmp, &target).await?;
        on_file_done(&clean, written);
    }

    Ok(())
}

fn strip_archive_prefix(raw_name: &str, strip_components: usize) -> AppResult<Option<(String, bool)>> {
    let is_dir = raw_name.ends_with('/');
    let trimmed = raw_name.strip_suffix('/').unwrap_or(raw_name);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\\') || trimmed.starts_with('/') {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь в архиве",
            format!("Недопустимый путь «{raw_name}»."),
        ));
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    for part in &parts {
        if *part == ".." || *part == "." {
            return Err(LauncherError::new(
                ErrorCode::ManifestInvalid,
                "Небезопасный путь в архиве",
                format!("Недопустимый путь «{raw_name}»."),
            ));
        }
    }
    if parts.len() <= strip_components {
        return Ok(None);
    }
    let rel = parts[strip_components..].join("/");
    if let Some(err) = check_relative_path(&rel) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь в архиве",
            format!("Путь «{raw_name}»: {err}."),
        ));
    }
    Ok(Some((rel, is_dir)))
}

#[derive(Clone, Copy)]
pub enum ArchiveFormat {
    Zip,
    TarGz,
}

pub async fn extract_archive_safe(
    archive_path: &Path,
    dest_dir: &Path,
    format: ArchiveFormat,
    strip_components: usize,
    cancel: &CancelToken,
) -> AppResult<()> {
    cancel.check()?;
    let archive_path = archive_path.to_path_buf();
    let dest_dir = abs_lexical(dest_dir);
    let cancel_bg = cancel.clone();

    tokio::task::spawn_blocking(move || -> AppResult<()> {
        fs::create_dir_all(&dest_dir)?;
        let real_root = fs::canonicalize(&dest_dir)?;

        match format {
            ArchiveFormat::Zip => {
                let file = File::open(&archive_path)?;
                let mut zip = ZipArchive::new(file).map_err(|e| {
                    LauncherError::new(
                        ErrorCode::Integrity,
                        "Повреждённый архив Java",
                        e.to_string(),
                    )
                })?;
                let mut buf = vec![0u8; 64 * 1024];
                for i in 0..zip.len() {
                    cancel_bg.check()?;
                    let mut entry = zip.by_index(i).map_err(|e| {
                        LauncherError::new(ErrorCode::Integrity, "Ошибка чтения ZIP", e.to_string())
                    })?;
                    let raw = entry.name().to_string();
                    if is_zip_symlink(entry.unix_mode()) {
                        return Err(LauncherError::new(
                            ErrorCode::ManifestInvalid,
                            "Символическая ссылка в архиве",
                            format!("Архив содержит символическую ссылку «{raw}»."),
                        ));
                    }
                    let Some((rel, is_dir)) = strip_archive_prefix(&raw, strip_components)? else {
                        continue;
                    };
                    let mut target = dest_dir.clone();
                    for seg in rel.split('/') {
                        target.push(seg);
                    }
                    if !is_inside(&dest_dir, &target) {
                        return Err(LauncherError::new(
                            ErrorCode::ManifestInvalid,
                            "Небезопасный путь в архиве",
                            raw,
                        ));
                    }
                    if is_dir {
                        fs::create_dir_all(&target)?;
                        continue;
                    }
                    if let Some(p) = target.parent() {
                        fs::create_dir_all(p)?;
                        let real_p = fs::canonicalize(p)?;
                        if real_p != real_root && !real_p.starts_with(&real_root) {
                            return Err(LauncherError::new(
                                ErrorCode::Filesystem,
                                "Небезопасная ссылка",
                                p.display().to_string(),
                            ));
                        }
                    }
                    let mut out = File::create(&target)?;
                    loop {
                        cancel_bg.check()?;
                        let n = entry.read(&mut buf)?;
                        if n == 0 {
                            break;
                        }
                        out.write_all(&buf[..n])?;
                    }
                    #[cfg(unix)]
                    if let Some(mode) = entry.unix_mode() {
                        use std::os::unix::fs::PermissionsExt;
                        if (mode & 0o111) != 0 {
                            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode | 0o600));
                        }
                    }
                }
            }
            ArchiveFormat::TarGz => {
                let file = File::open(&archive_path)?;
                let gz = GzDecoder::new(file);
                let mut tar = Archive::new(gz);
                for entry_res in tar.entries()? {
                    cancel_bg.check()?;
                    let mut entry = entry_res?;
                    let entry_type = entry.header().entry_type();
                    let raw = entry.path()?.to_string_lossy().replace('\\', "/");
                    if entry_type.is_symlink() || entry_type.is_hard_link() {
                        return Err(LauncherError::new(
                            ErrorCode::ManifestInvalid,
                            "Символическая ссылка в архиве",
                            format!("Запрещённая ссылка «{raw}»."),
                        ));
                    }
                    let Some((rel, is_dir)) = strip_archive_prefix(&raw, strip_components)? else {
                        continue;
                    };
                    let mut target = dest_dir.clone();
                    for seg in rel.split('/') {
                        target.push(seg);
                    }
                    if !is_inside(&dest_dir, &target) {
                        return Err(LauncherError::new(
                            ErrorCode::ManifestInvalid,
                            "Небезопасный путь в архиве",
                            raw,
                        ));
                    }
                    if is_dir || entry_type.is_dir() {
                        fs::create_dir_all(&target)?;
                    } else if entry_type.is_file() {
                        if let Some(p) = target.parent() {
                            fs::create_dir_all(p)?;
                        }
                        let mut out = File::create(&target)?;
                        std::io::copy(&mut entry, &mut out)?;
                        #[cfg(unix)]
                        if let Ok(mode) = entry.header().mode() {
                            use std::os::unix::fs::PermissionsExt;
                            if (mode & 0o111) != 0 {
                                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode | 0o600));
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| LauncherError::new(ErrorCode::Unknown, "Ошибка распаковки", e.to_string()))?
}
