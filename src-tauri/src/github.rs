use crate::error::{AppResult, ErrorCode, LauncherError};
use crate::paths::check_relative_path;
use crate::types::{default_pack_path, CustomRepo};
use regex::Regex;
use url::Url;

fn invalid(msg: &str) -> LauncherError {
    LauncherError::new(
        ErrorCode::ManifestInvalid,
        "Некорректный адрес репозитория",
        msg,
    )
}

fn slug_regex() -> Regex {
    Regex::new(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$").unwrap()
}

fn branch_regex() -> Regex {
    Regex::new(r"^[A-Za-z0-9._/-]{1,100}$").unwrap()
}

pub fn parse_repo_input(input: &str, branch_override: Option<&str>) -> AppResult<CustomRepo> {
    let raw = input.trim();
    let slug: String;
    let mut branch = branch_override
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    if raw.to_ascii_lowercase().starts_with("http://")
        || raw.to_ascii_lowercase().starts_with("https://")
    {
        let u = Url::parse(raw)
            .map_err(|_| invalid("Укажите репозиторий в виде owner/repo или ссылку https://github.com/owner/repo"))?;
        let host = u.host_str().unwrap_or("").to_ascii_lowercase();
        if host != "github.com" || u.scheme() != "https" {
            return Err(invalid("Поддерживаются только репозитории на https://github.com"));
        }
        let parts: Vec<&str> = u
            .path()
            .split('/')
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() < 2 {
            return Err(invalid("Укажите репозиторий в виде owner/repo или ссылку https://github.com/owner/repo"));
        }
        let repo_name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        slug = format!("{}/{repo_name}", parts[0]);
        if branch.is_empty() && parts.get(2) == Some(&"tree") && parts.len() >= 4 {
            branch = parts[3..].join("/");
        }
    } else {
        slug = raw.strip_suffix(".git").unwrap_or(raw).to_string();
    }

    if !slug_regex().is_match(&slug) || slug.contains("..") {
        return Err(invalid("Укажите репозиторий в виде owner/repo или ссылку https://github.com/owner/repo"));
    }
    if branch.is_empty() {
        branch = "main".to_string();
    }
    if !branch_regex().is_match(&branch) || branch.contains("..") {
        return Err(invalid("Некорректное имя ветки"));
    }

    Ok(CustomRepo {
        repo: slug,
        branch,
        path: default_pack_path(),
    })
}

fn percent_encode_segment(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn raw_url(repo: &str, branch: &str, path: &str) -> AppResult<String> {
    if let Some(err) = check_relative_path(path) {
        return Err(LauncherError::new(
            ErrorCode::ManifestInvalid,
            "Небезопасный путь",
            format!("Путь «{path}»: {err}"),
        ));
    }
    let enc_branch = branch
        .split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    let enc_path = path
        .split('/')
        .map(percent_encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!(
        "https://raw.githubusercontent.com/{repo}/{enc_branch}/{enc_path}"
    ))
}

pub fn normalize_catalog_url(input: &str) -> AppResult<String> {
    let s = input.trim();
    if s.is_empty() {
        return Ok(String::new());
    }
    let u = Url::parse(s).map_err(|_| invalid("Некорректная ссылка на каталог"))?;
    if u.scheme() != "https" {
        return Err(invalid("Ссылка на каталог должна начинаться с https://"));
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "github.com" {
        let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() >= 5 && parts[2] == "blob" {
            return Ok(format!(
                "https://raw.githubusercontent.com/{}/{}/{}",
                parts[0],
                parts[1],
                parts[3..].join("/")
            ));
        }
    }
    if host != "raw.githubusercontent.com" && host != "github.com" {
        return Err(invalid("Каталог должен находиться на GitHub (raw.githubusercontent.com)"));
    }
    Ok(u.to_string())
}
