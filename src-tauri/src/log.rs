use crate::types::LogEntry;
use chrono::Utc;
use regex::Regex;
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_BUFFER: usize = 3000;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

type EmitFn = Arc<dyn Fn(LogEntry) + Send + Sync>;

struct LogInner {
    buffer: VecDeque<LogEntry>,
    file: Option<PathBuf>,
    redactions: Vec<(String, String)>,
    token_re: Regex,
    emitter: Option<EmitFn>,
}

#[derive(Clone)]
pub struct AppLogger {
    inner: Arc<Mutex<LogInner>>,
}

impl AppLogger {
    pub fn new() -> Self {
        let mut redactions: Vec<(String, String)> = Vec::new();
        if let Some(home) = home_dir_lossy() {
            add_redaction_variants(&mut redactions, &home, "~");
        }
        if let Ok(user) = std::env::var("USERNAME").or_else(|_| std::env::var("USER")) {
            if user.len() >= 3 {
                add_redaction_variants(&mut redactions, &user, "<user>");
            }
        }
        redactions.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

        let token_re = Regex::new(r#"(?i)(access[_-]?token|authorization|token)(["'=:\s]+)([^\s"',]+)"#)
            .expect("valid token regex");

        Self {
            inner: Arc::new(Mutex::new(LogInner {
                buffer: VecDeque::with_capacity(512),
                file: None,
                redactions,
                token_re,
                emitter: None,
            })),
        }
    }

    pub fn set_emitter<F>(&self, f: F)
    where
        F: Fn(LogEntry) + Send + Sync + 'static,
    {
        if let Ok(mut g) = self.inner.lock() {
            g.emitter = Some(Arc::new(f));
        }
    }

    pub fn set_file(&self, path: PathBuf) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(mut g) = self.inner.lock() {
            g.file = Some(path);
        }
    }

    pub fn redact(&self, text: &str) -> String {
        let Ok(g) = self.inner.lock() else {
            return text.to_string();
        };
        Self::redact_with(&g.redactions, &g.token_re, text)
    }

    fn redact_with(redactions: &[(String, String)], token_re: &Regex, text: &str) -> String {
        let mut out = text.to_string();
        for (needle, rep) in redactions {
            if needle.is_empty() {
                continue;
            }
            out = replace_case_insensitive(&out, needle, rep);
        }
        token_re
            .replace_all(&out, "${1}${2}<скрыто>")
            .into_owned()
    }

    pub fn entries(&self) -> Vec<LogEntry> {
        let Ok(g) = self.inner.lock() else {
            return Vec::new();
        };
        g.buffer.iter().cloned().collect()
    }

    pub fn log(&self, level: &str, scope: &str, message: &str) {
        let (entry, file_path, emitter) = {
            let Ok(mut g) = self.inner.lock() else {
                return;
            };
            let clean = Self::redact_with(&g.redactions, &g.token_re, message);
            let entry = LogEntry {
                ts: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                level: level.to_string(),
                scope: scope.to_string(),
                message: clean,
            };
            if g.buffer.len() >= MAX_BUFFER {
                g.buffer.pop_front();
            }
            g.buffer.push_back(entry.clone());
            (entry, g.file.clone(), g.emitter.clone())
        };

        if let Some(emit) = emitter {
            emit(entry.clone());
        }

        if level != "debug" || std::env::var_os("ABI_DEBUG").is_some() {
            let line = format!(
                "{} [{}] [{}] {}\n",
                entry.ts,
                entry.level.to_uppercase(),
                entry.scope,
                entry.message
            );
            if let Some(path) = file_path {
                write_log_file(&path, &line);
            }
        }
    }

    pub fn info(&self, scope: &str, msg: impl AsRef<str>) {
        self.log("info", scope, msg.as_ref());
    }

    pub fn warn(&self, scope: &str, msg: impl AsRef<str>) {
        self.log("warn", scope, msg.as_ref());
    }

    pub fn error(&self, scope: &str, msg: impl AsRef<str>) {
        self.log("error", scope, msg.as_ref());
    }
}

impl Default for AppLogger {
    fn default() -> Self {
        Self::new()
    }
}

fn add_redaction_variants(out: &mut Vec<(String, String)>, value: &str, replacement: &str) {
    if value.is_empty() {
        return;
    }
    let slash = value.replace('\\', "/");
    let back = value.replace('/', "\\");
    for v in [value.to_string(), slash, back] {
        if !out.iter().any(|(existing, _)| existing == &v) {
            out.push((v, replacement.to_string()));
        }
    }
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_hay = haystack.to_lowercase();
    let lower_needle = needle.to_lowercase();
    if lower_needle.is_empty() || !lower_hay.contains(&lower_needle) {
        return haystack.to_string();
    }
    let mut result = String::with_capacity(haystack.len());
    let mut last = 0;
    for (idx, _) in lower_hay.match_indices(&lower_needle) {
        // Защита от несовпадения границ UTF-8 при разной длине lower
        if haystack.is_char_boundary(idx) && haystack.is_char_boundary(idx + needle.len()) {
            result.push_str(&haystack[last..idx]);
            result.push_str(replacement);
            last = idx + needle.len();
        }
    }
    result.push_str(&haystack[last..]);
    result
}

fn write_log_file(path: &Path, line: &str) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_FILE_BYTES {
            let old = PathBuf::from(format!("{}.1", path.display()));
            let _ = fs::remove_file(&old);
            let _ = fs::rename(path, &old);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn home_dir_lossy() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}
