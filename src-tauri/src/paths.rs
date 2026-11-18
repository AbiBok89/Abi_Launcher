use regex::Regex;
use unicode_normalization::UnicodeNormalization;

pub const LAUNCHER_META_DIR: &str = ".abilauncher";
pub const MAX_RELATIVE_PATH_LENGTH: usize = 400;

const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Проверяет относительный путь из удалённого манифеста.
/// Возвращает `None`, если путь безопасен, или текст ошибки.
pub fn check_relative_path(p: &str) -> Option<String> {
    if p.is_empty() {
        return Some("пустой путь".to_string());
    }
    if p.chars().count() > MAX_RELATIVE_PATH_LENGTH {
        return Some("слишком длинный путь".to_string());
    }
    if p.contains('\\') {
        return Some("обратные слеши запрещены".to_string());
    }
    if p.starts_with('/') {
        return Some("абсолютный путь запрещён".to_string());
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some("буква диска запрещена".to_string());
    }
    if p.chars().any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f) {
        return Some("управляющие символы запрещены".to_string());
    }
    if p.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Some("недопустимые символы в пути".to_string());
    }
    let segments: Vec<&str> = p.split('/').collect();
    for seg in &segments {
        if seg.is_empty() {
            return Some("пустой сегмент пути".to_string());
        }
        if *seg == "." || *seg == ".." {
            return Some("переход по каталогам запрещён".to_string());
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Some("сегмент не может оканчиваться точкой или пробелом".to_string());
        }
        let base = seg.split('.').next().unwrap_or("").to_lowercase();
        if WINDOWS_RESERVED.contains(&base.as_str()) {
            return Some(format!("зарезервированное имя «{seg}»"));
        }
    }
    if segments
        .first()
        .is_some_and(|s| s.eq_ignore_ascii_case(LAUNCHER_META_DIR))
    {
        return Some("служебная папка лаунчера защищена".to_string());
    }
    None
}

pub fn path_key(p: &str) -> String {
    p.nfc().collect::<String>().to_lowercase()
}

pub fn glob_to_regex(glob: &str) -> Option<Regex> {
    let chars: Vec<char> = glob.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                    continue;
                } else {
                    re.push_str(".*");
                    i += 2;
                    continue;
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else if "\\^$+.()|{}[]".contains(c) {
            re.push('\\');
            re.push(c);
        } else {
            re.push(c);
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&format!("(?i){re}")).ok()
}

pub fn matches_any(path: &str, globs: &[&str]) -> bool {
    globs
        .iter()
        .filter_map(|g| glob_to_regex(g))
        .any(|re| re.is_match(path))
}
