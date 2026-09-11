#![cfg_attr(mobile, tauri::mobile_entry_point)]

use serde::{Serialize, Deserialize};
use std::fs;
use std::path::Path;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use ftp::FtpStream;
use tauri::Emitter;
use encoding_rs::{GBK, BIG5, SHIFT_JIS, WINDOWS_1252};
mod remote_term;

const TEXT_READ_LIMIT: usize = 20 * 1024 * 1024;
const BINARY_SNIFF: usize = 8192;

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let p = entry.path();
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let md = fs::metadata(&p).ok();
        let size = if ft.is_file() { md.as_ref().map(|m| m.len()).unwrap_or(0) } else { 0 };
        let modified = md
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
            size,
            modified,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Serialize)]
struct TextFile {
    text: String,
    truncated: bool,
    encoding: String,
    size: u64,
    is_binary: bool,
    line_endings: String,
}

fn detect_line_endings(raw: &[u8]) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let mut i = 0usize;
    while i < raw.len() {
        match raw[i] {
            b'\r' => {
                if i + 1 < raw.len() && raw[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                } else {
                    cr += 1;
                    i += 1;
                }
            }
            b'\n' => {
                lf += 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    if crlf > lf && crlf > cr {
        "crlf"
    } else if cr > lf && cr > crlf {
        "cr"
    } else {
        "lf"
    }
}

enum Detected {
    Utf8 { bom: bool },
    Utf16Le { has_bom: bool },
    Utf16Be { has_bom: bool },
    Binary,
}

fn detect(raw: &[u8]) -> Detected {
    let len = raw.len();
    if len >= 2 {
        if raw[0] == 0xFE && raw[1] == 0xFF {
            return Detected::Utf16Be { has_bom: true };
        }
        if raw[0] == 0xFF && raw[1] == 0xFE {
            if len >= 4 && raw[2] == 0x00 && raw[3] == 0x00 {
                return Detected::Binary; // UTF-32, treat as binary
            }
            return Detected::Utf16Le { has_bom: true };
        }
    }
    let sniff_end = raw.len().min(BINARY_SNIFF);
    let mut nulls = 0;
    for &b in &raw[..sniff_end] {
        if b == 0 {
            nulls += 1;
        }
    }
    if nulls > 0 {
        return Detected::Binary;
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Detected::Utf8 { bom: true };
    }
    if raw.is_empty() {
        return Detected::Binary;
    }
    match String::from_utf8(raw.to_vec()) {
        Ok(_) => Detected::Utf8 { bom: false },
        Err(_) => {
            // 绝大部分是合法 UTF-8（个别坏字节，如大文件中内嵌的异常数据）→ 仍按 UTF-8 解码，
            // 坏字节由 from_utf8_lossy 替换为 �。避免整个 UTF-8 文件被误判为 GBK/1252 导致大面积乱码。
            let lossy = String::from_utf8_lossy(raw);
            let bad = lossy.chars().filter(|c| *c == '\u{FFFD}').count();
            let ratio = bad as f64 / len.max(1) as f64;
            if ratio < 0.01 {
                Detected::Utf8 { bom: false }
            } else {
                Detected::Binary
            }
        }
    }
}

fn looks_binary_bytes(raw: &[u8]) -> bool {
    let end = raw.len().min(BINARY_SNIFF);
    raw[..end].contains(&0)
}

fn decode_cjk(raw: &[u8]) -> Option<(String, &'static str)> {
    // CJK 编码优先：它们对字节序列有合法性约束，能区分真实 CJK 文本。
    // 都不匹配时回退 UTF-8 lossy（现代文本默认 UTF-8，个别坏字节替换为 �）。
    // 不再用 windows-1252 兜底：它对任意字节都无解码错误，会把 UTF-8 中文误判成乱码。
    let cjk: [(&'static str, &'static encoding_rs::Encoding); 3] = [
        ("gbk", GBK),
        ("big5", BIG5),
        ("shift_jis", SHIFT_JIS),
    ];
    let mut best: Option<(String, &'static str, usize)> = None;
    for (label, enc) in cjk {
        let (cow, _, had_errors) = enc.decode(raw);
        let errors = cow.chars().filter(|c| *c == '\u{FFFD}').count();
        if had_errors && errors == 0 {
            best = Some((cow.into_owned(), label, 0));
            break;
        }
        if best.as_ref().map_or(true, |(_, _, e)| errors < *e) {
            best = Some((cow.into_owned(), label, errors));
        }
    }
    match best {
        Some((t, l, 0)) => Some((t, l)),
        Some((t, l, e)) if e < 32 => Some((t, l)),
        _ => {
            let cow = String::from_utf8_lossy(raw);
            Some((cow.into_owned(), "utf-8"))
        }
    }
}

#[tauri::command]
fn read_text_file(path: String) -> Result<TextFile, String> {
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let len = raw.len() as u64;
    if looks_binary_bytes(&raw) {
        return Ok(TextFile { text: "".into(), truncated: false, encoding: "binary".into(), size: len, is_binary: true, line_endings: "lf".into() });
    }
    let (text, encoding, is_binary): (String, String, bool) = match detect(&raw) {
        Detected::Binary => {
            match decode_cjk(&raw) {
                Some((t, label)) => (t, label.into(), false),
                None => ("".into(), "binary".into(), true),
            }
        }
        Detected::Utf8 { bom } => {
            let start = if bom { 3 } else { 0 };
            let s = String::from_utf8_lossy(&raw[start..]).into_owned();
            (s, if bom { "utf-8-bom".into() } else { "utf-8".into() }, false)
        }
        Detected::Utf16Le { has_bom } => {
            let start = if has_bom { 2 } else { 0 };
            let units: Vec<u16> = raw[start..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&units), "utf-16le".into(), false)
        }
        Detected::Utf16Be { has_bom } => {
            let start = if has_bom { 2 } else { 0 };
            let units: Vec<u16> = raw[start..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&units), "utf-16be".into(), false)
        }
    };
    let mut truncated = false;
    let mut final_text = text;
    if final_text.len() > TEXT_READ_LIMIT {
        let boundary = final_text.floor_char_boundary(TEXT_READ_LIMIT);
        final_text.truncate(boundary);
        truncated = true;
    }
    Ok(TextFile { text: final_text, truncated, encoding, size: len, is_binary, line_endings: detect_line_endings(&raw).into() })
}

// 按用户指定字符集重新解码文件（不改变文件内容，只改变查看解读；"重新打开为"）
#[tauri::command]
fn read_text_file_as(path: String, encoding: String) -> Result<TextFile, String> {
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let len = raw.len() as u64;
    let (text, label): (String, String) = match encoding.as_str() {
        "utf-8" | "utf8" => (String::from_utf8_lossy(&raw).into_owned(), "utf-8".into()),
        "utf-8-bom" => {
            let start = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
            (String::from_utf8_lossy(&raw[start..]).into_owned(), "utf-8-bom".into())
        }
        "gbk" => decode_bytes_with(&raw, GBK, "gbk"),
        "gb18030" => decode_bytes_with(&raw, encoding_rs::GB18030, "gb18030"),
        "big5" => decode_bytes_with(&raw, BIG5, "big5"),
        "shift_jis" => decode_bytes_with(&raw, SHIFT_JIS, "shift_jis"),
        "windows-1252" => decode_bytes_with(&raw, WINDOWS_1252, "windows-1252"),
        "utf-16le" => {
            let start = if raw.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
            let units: Vec<u16> = raw[start..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&units), "utf-16le".into())
        }
        "utf-16be" => {
            let start = if raw.starts_with(&[0xFE, 0xFF]) { 2 } else { 0 };
            let units: Vec<u16> = raw[start..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&units), "utf-16be".into())
        }
        _ => (String::from_utf8_lossy(&raw).into_owned(), "utf-8".into()),
    };
    let mut truncated = false;
    let mut final_text = text;
    if final_text.len() > TEXT_READ_LIMIT {
        let boundary = final_text.floor_char_boundary(TEXT_READ_LIMIT);
        final_text.truncate(boundary);
        truncated = true;
    }
    Ok(TextFile { text: final_text, truncated, encoding: label, size: len, is_binary: false, line_endings: detect_line_endings(&raw).into() })
}

fn decode_bytes_with(raw: &[u8], enc: &'static encoding_rs::Encoding, label: &str) -> (String, String) {
    let (cow, _, _) = enc.decode(raw);
    (cow.into_owned(), label.into())
}

#[tauri::command]
fn save_text_file(path: String, text: String, encoding: Option<String>, line_ending: Option<String>, backup: Option<bool>) -> Result<(), String> {
    if backup.unwrap_or(false) && Path::new(&path).exists() {
        let _ = fs::copy(&path, format!("{path}.bak"));
    }
    let enc = encoding.unwrap_or_else(|| "utf-8".into());
    let text = match line_ending.as_deref() {
        Some("crlf") => text.replace('\n', "\r\n"),
        Some("cr") => text.replace('\n', "\r"),
        _ => text,
    };
    let bytes: Vec<u8> = match enc.as_str() {
        "utf-16le" => {
            let mut v = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                v.extend_from_slice(&unit.to_le_bytes());
            }
            v
        }
        "utf-16be" => {
            let mut v = vec![0xFE, 0xFF];
            for unit in text.encode_utf16() {
                v.extend_from_slice(&unit.to_be_bytes());
            }
            v
        }
        _ => {
            let mut v = Vec::with_capacity(text.len() + 3);
            if enc == "utf-8-bom" {
                v.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
                v.extend_from_slice(text.as_bytes());
            } else {
                let encoder = match enc.as_str() {
                    "gbk" => Some(GBK),
                    "big5" => Some(BIG5),
                    "shift_jis" => Some(SHIFT_JIS),
                    "windows-1252" => Some(WINDOWS_1252),
                    "gb18030" => Some(encoding_rs::GB18030),
                    _ => None,
                };
                if let Some(e) = encoder {
                    let (cow, _, _had) = e.encode(&text);
                    v.extend_from_slice(&cow);
                } else {
                    v.extend_from_slice(text.as_bytes());
                }
            }
            v
        }
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_hex_range(path: String, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    use std::io::{Read, Seek, SeekFrom};
    let mut f = file;
    let meta = f.metadata().map_err(|e| e.to_string())?;
    let file_len = meta.len();
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let available = (file_len.saturating_sub(offset)).min(length as u64) as usize;
    let mut buf = vec![0u8; available];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
fn write_hex_range(path: String, offset: u64, data: Vec<u8>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct BigPage {
    text: String,
    start: u64,
    done: bool,
    truncated_at: u64,
}

#[tauri::command]
fn text_page(path: String, offset: u64, max_len: usize) -> Result<BigPage, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let total = f.metadata().map(|m| m.len()).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let want = (total.saturating_sub(offset)).min(max_len as u64) as usize;
    let mut buf = vec![0u8; want];
    if want > 0 {
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // cut to the last newline if the chunk is full, to align on line boundaries
    let done = offset + want as u64 >= total;
    if !done {
        if let Some(pos) = text.rfind('\n') {
            text.truncate(pos + 1);
        }
    }
    let truncated = text.len() as u64;
    Ok(BigPage {
        text,
        start: offset,
        done,
        truncated_at: truncated,
    })
}

#[tauri::command]
fn text_write(path: String, offset: u64, text: String) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_is_dir(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

#[derive(Serialize)]
struct SearchItem {
    path: String,
    line: usize,
    content: String,
    index: usize,
}

#[derive(Serialize)]
struct SearchResult {
    items: Vec<SearchItem>,
    files: usize,
    truncated: bool,
}

fn looks_binary(buf: &[u8]) -> bool {
    let end = buf.len().min(8192);
    buf[..end].contains(&0)
}

#[tauri::command]
fn search_in_dir(
    dir: String,
    query: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
) -> Result<SearchResult, String> {
    let max_results = 2000usize;
    let matcher: Option<regex::Regex> = if regex {
        let expr = if whole_word {
            format!(r"\b{}\b", regex::escape(&query))
        } else {
            query.clone()
        };
        Some(regex::RegexBuilder::new(&expr)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("正则错误: {e}"))?)
    } else {
        None
    };
    let lower_query = query.to_lowercase();

    let mut items = Vec::new();
    let mut files = 0usize;
    let mut truncated = false;

    'outer: for entry in walkdir::WalkDir::new(&dir) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp" | "pdf" | "zip" | "tar" | "gz" | "7z" | "exe" | "dll" | "so" | "wasm" | "class" | "lock") {
            continue;
        }
        let raw = match fs::read(path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if looks_binary(&raw) {
            continue;
        }
        let Some(text) = String::from_utf8(raw).ok() else { continue };
        let mut found_here = false;
        let mut index = 0;
        for (ln, line) in text.lines().enumerate() {
            let hit = if let Some(re) = &matcher {
                re.is_match(line)
            } else if whole_word {
                let lower = line.to_lowercase();
                let (lq, ll) = if case_sensitive { (line.to_string(), query.clone()) } else { (lower, lower_query.clone()) };
                word_in(&lq, &ll)
            } else if case_sensitive {
                line.contains(&query)
            } else {
                line.to_lowercase().contains(&lower_query)
            };
            if hit {
                found_here = true;
                items.push(SearchItem {
                    path: path.to_string_lossy().to_string(),
                    line: ln + 1,
                    content: line.trim().chars().take(200).collect(),
                    index,
                });
                index += 1;
                if items.len() >= max_results {
                    truncated = true;
                    break 'outer;
                }
            }
        }
        if found_here {
            files += 1;
        }
    }
    Ok(SearchResult { items, files, truncated })
}

fn word_in(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut start = 0;
    while let Some(rel) = haystack[start..].find(needle) {
        let at = start + rel;
        let before = haystack[..at].chars().next_back().map(|c| c.is_alphanumeric()).unwrap_or(false);
        let after = haystack[at + needle.len()..].chars().next().map(|c| c.is_alphanumeric()).unwrap_or(false);
        if !before && !after {
            return true;
        }
        start = at + needle.len();
    }
    false
}

#[derive(Serialize)]
struct ReplaceOutcome {
    replaced: usize,
    failed: Vec<String>,
}

#[tauri::command]
fn replace_in_dir(
    dir: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
) -> Result<ReplaceOutcome, String> {
    let mut replaced = 0usize;
    let mut failed = Vec::new();
    for entry in walkdir::WalkDir::new(&dir) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp" | "pdf" | "zip" | "tar" | "gz" | "7z" | "exe" | "dll" | "so" | "wasm" | "class" | "lock") {
            continue;
        }
        let raw = match fs::read(path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if looks_binary(&raw) {
            continue;
        }
        let Ok(text) = String::from_utf8(raw) else { continue };
        let mut new_text = text.clone();
        let expr = if regex {
            if whole_word {
                format!(r"\b{}\b", query)
            } else {
                query.clone()
            }
        } else if whole_word {
            format!(r"\b{}\b", regex::escape(&query))
        } else {
            regex::escape(&query)
        };
        let Ok(re) = regex::RegexBuilder::new(&expr)
            .case_insensitive(!case_sensitive)
            .build()
        else {
            failed.push(path.to_string_lossy().to_string());
            continue;
        };
        if re.is_match(&new_text) {
            new_text = re.replace_all(&new_text, replacement.as_str()).into_owned();
        }
        if new_text != text {
            match fs::write(path, new_text.as_bytes()) {
                Ok(_) => replaced += 1,
                Err(_) => failed.push(path.to_string_lossy().to_string()),
            }
        }
    }
    Ok(ReplaceOutcome { replaced, failed })
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    dirs_home().ok_or_else(|| "no home".into())
}

#[tauri::command]
fn open_terminal(dir: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", &dir])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", "cmd", "/k", "cd", "/d", &dir])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("x-terminal-emulator")
            .args(["-e", &format!("cd '{}' && $SHELL", dir)])
            .spawn();
        let _ = std::process::Command::new("konsole")
            .args(["--workdir", &dir])
            .spawn();
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| {
        std::env::var("USERPROFILE").ok()
    })
}

fn recovery_dir() -> String {
    let home = dirs_home().unwrap_or_else(|| ".".into());
    format!("{home}/.0xedit_recovery")
}

fn recovery_file(key: &str) -> String {
    format!("{}/{}.json", recovery_dir(), key)
}

#[derive(Serialize, Deserialize)]
struct RecoveryMeta {
    name: String,
    text: String,
}

#[tauri::command]
fn write_recovery(key: String, name: String, text: String) -> Result<(), String> {
    let dir = recovery_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let meta = RecoveryMeta { name, text };
    fs::write(recovery_file(&key), serde_json::to_string(&meta).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct RecoveryItem {
    key: String,
    name: String,
    modified: String,
}

#[tauri::command]
fn list_recovery() -> Result<Vec<RecoveryItem>, String> {
    let dir = recovery_dir();
    let mut out = Vec::new();
    if !Path::new(&dir).exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(raw) = fs::read(&p) {
                if let Ok(meta) = serde_json::from_slice::<RecoveryMeta>(&raw) {
                    let key = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let modified = entry.metadata().map(|m| m.modified()).ok()
                        .and_then(|t| t.ok())
                        .and_then(|t| t.elapsed().ok())
                        .map(|d| format!("{} 前", humandur(d.as_secs())))
                        .unwrap_or_default();
                    out.push(RecoveryItem { key, name: meta.name, modified });
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn humandur(secs: u64) -> String {
    if secs < 60 { return format!("{secs}秒"); }
    if secs < 3600 { return format!("{}分", secs / 60); }
    if secs < 86400 { return format!("{}小时", secs / 3600); }
    format!("{}天", secs / 86400)
}

#[tauri::command]
fn read_recovery(key: String) -> Result<String, String> {
    let raw = fs::read(recovery_file(&key)).map_err(|e| e.to_string())?;
    let meta: RecoveryMeta = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    Ok(meta.text)
}

#[tauri::command]
fn clear_recovery(key: String) -> Result<(), String> {
    let _ = fs::remove_file(recovery_file(&key));
    Ok(())
}

pub struct FtpState(pub Arc<Mutex<HashMap<String, FtpStream>>>);
pub struct SshState(pub Arc<Mutex<HashMap<String, ssh2::Session>>>);

#[tauri::command]
fn ftp_connect(host: String, port: u16, username: String, password: String, state: tauri::State<'_, FtpState>) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    let (tx, rx) = mpsc::channel();
    let host2 = host.clone();
    let user2 = username.clone();
    let pass2 = password.clone();
    std::thread::spawn(move || {
        let result = (|| -> Result<FtpStream, String> {
            let mut ftp = FtpStream::connect((host2.as_str(), port)).map_err(|e| format!("连接失败: {e}"))?;
            ftp.login(&user2, &pass2).map_err(|e| format!("登录失败: {e}"))?;
            Ok(ftp)
        })();
        let _ = tx.send(result);
    });
    let res = rx.recv_timeout(Duration::from_secs(20))
        .map_err(|_| "连接超时（20 秒无响应）".to_string())??;
    let id = format!("{host}:{port}:{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    state.0.lock().unwrap().insert(id.clone(), res);
    Ok(id)
}

#[tauri::command]
fn ftp_disconnect(id: String, state: tauri::State<'_, FtpState>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut ftp) = map.remove(&id) {
        let _ = ftp.quit();
    }
    Ok(())
}

fn with_ftp<F, R>(id: &str, state: &FtpState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut FtpStream) -> Result<R, ftp::FtpError>,
{
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let ftp = map.get_mut(id).ok_or_else(|| "未连接 FTP".to_string())?;
    f(ftp).map_err(|e| format!("FTP 错误: {e}"))
}

#[derive(Serialize)]
struct FtpEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
struct FtpListResult {
    pwd: String,
    entries: Vec<FtpEntry>,
}

#[tauri::command]
fn ftp_list(id: String, path: Option<String>, state: tauri::State<'_, FtpState>) -> Result<FtpListResult, String> {
    with_ftp(&id, state.inner(), |ftp| {
        let prev = ftp.pwd()?;
        // 可选 path：临时进入子目录列出其内容（不改变连接当前目录），用于树内展开
        if let Some(p) = path.as_deref() {
            if !p.is_empty() && p != "/" && p != "." {
                ftp.cwd(p)?;
            }
        }
        let pwd = ftp.pwd()?;
        let raw = ftp.list(None)?;
        if path.is_some() && !pwd.is_empty() {
            // 恢复原目录（忽略失败，避免展开失败影响连接状态）
            let _ = ftp.cwd(&prev);
        }
        let mut out = Vec::new();
        for line in raw {
            if let Some((name, is_dir, size)) = parse_ftp_list_line(line.trim_start(), true) {
                out.push(FtpEntry {
                    name,
                    is_dir,
                    size,
                    // FTP LIST 时间格式繁杂且不可靠，统一 0（前端 mtime 排序回退名称）
                    modified: 0,
                });
            }
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(FtpListResult { pwd, entries: out })
    })
}

#[tauri::command]
fn ftp_cwd(id: String, path: String, state: tauri::State<'_, FtpState>) -> Result<String, String> {
    with_ftp(&id, state.inner(), |ftp| {
        if path == ".." {
            ftp.cdup()?;
        } else {
            ftp.cwd(&path)?;
        }
        ftp.pwd()
    })
}

#[tauri::command]
async fn ftp_upload(id: String, local_path: String, state: tauri::State<'_, FtpState>, remote_name: Option<String>, task_id: String, app: tauri::AppHandle) -> Result<String, String> {
    let ftp_st = FtpState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
    let res = with_ftp(&id, &ftp_st, |ftp| {
            let name = remote_name.unwrap_or_else(|| Path::new(&local_path).file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default());
            let total = fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            let mut file = fs::File::open(&local_path).map_err(|e| ftp::FtpError::InvalidResponse(format!("本地文件: {e}")))?;
            let mut pr = ProgressReader {
                inner: &mut file,
                done: 0, last_emit: 0,
                base: 0,
                total,
                task_id: task_id.clone(),
                name: name.clone(),
                app: app.clone(),
            };
            let pwd = ftp.pwd()?;
            ftp.put(&name, &mut pr)?;
            emit_transfer(&app, &task_id, "up", &name, total, total, "done", None);
            Ok(pwd)
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "up", &local_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
async fn ftp_download(id: String, remote_name: String, task_id: String, state: tauri::State<'_, FtpState>, app: tauri::AppHandle) -> Result<String, String> {
    let ftp_st = FtpState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
    let res = with_ftp(&id, &ftp_st, |ftp| {
            let name = Path::new(&remote_name).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_name.clone());
            let total = ftp.size(&remote_name).ok().flatten().map(|v| v as u64).unwrap_or(0);
            let tmp = std::env::temp_dir().join(format!("uec_ftp_{}_{}", name, nanos()));
            let mut file = fs::File::create(&tmp).map_err(|e| ftp::FtpError::ConnectionError(e))?;
            let file_cell = std::cell::RefCell::new(&mut file);
            let name_ref = name.clone();
            let task_ref = task_id.clone();
            let app_ref = app.clone();
            ftp.retr(&remote_name, |reader| {
                let mut pr = ProgressReader {
                    inner: reader,
                    done: 0, last_emit: 0,
                    base: 0,
                    total,
                    task_id: task_ref.clone(),
                    name: name_ref.clone(),
                    app: app_ref.clone(),
                };
                pump_copy(&mut pr, &mut *file_cell.borrow_mut())
                    .map(|_| ())
                    .map_err(|e| ftp::FtpError::ConnectionError(e))
            })?;
            emit_transfer(&app, &task_id, "down", &name, total, total, "done", None);
            Ok(tmp.to_string_lossy().to_string())
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "down", &remote_name, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
fn ftp_delete(id: String, name: String, is_dir: bool, state: tauri::State<'_, FtpState>) -> Result<(), String> {
    with_ftp(&id, state.inner(), |ftp| {
        if is_dir {
            ftp.rmdir(&name)
        } else {
            ftp.rm(&name)
        }
    })
}

#[tauri::command]
fn ftp_mkdir(id: String, name: String, state: tauri::State<'_, FtpState>) -> Result<(), String> {
    with_ftp(&id, state.inner(), |ftp| ftp.mkdir(&name))
}

#[tauri::command]
fn ftp_create_file(id: String, name: String, state: tauri::State<'_, FtpState>) -> Result<String, String> {
    with_ftp(&id, state.inner(), |ftp| {
        let mut empty = std::io::Cursor::new(Vec::<u8>::new());
        let pwd = ftp.pwd()?;
        ftp.put(&name, &mut empty)?;
        Ok(pwd)
    })
}

#[tauri::command]
fn copy_file(src: String, dst: String) -> Result<(), String> {
    if let Some(dir) = Path::new(&dst).parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct DirCompareItem {
    rel: String,
    exists_left: bool,
    exists_right: bool,
    is_dir: bool,
    size_left: u64,
    size_right: u64,
    modified_left: u64,
    modified_right: u64,
    same: bool,
}

fn collect_files(dir: &str, base: &str, out: &mut Vec<(String, u64, u64, bool)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        let md = entry.metadata();
        let (mtime, size) = md.map(|m| (m.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)).unwrap_or(0), m.len())).unwrap_or((0, 0));
        let is_dir = p.is_dir();
        out.push((rel, size, mtime, is_dir));
        if is_dir {
            collect_files(p.to_str().unwrap_or(""), base, out);
        }
    }
}

#[tauri::command]
fn compare_dirs(left: String, right: String) -> Result<Vec<DirCompareItem>, String> {
    let mut lf = Vec::new();
    let mut rf = Vec::new();
    collect_files(&left, &left, &mut lf);
    collect_files(&right, &right, &mut rf);
    let mut map: std::collections::BTreeMap<String, DirCompareItem> = std::collections::BTreeMap::new();
    for (rel, size, mtime, is_dir) in lf {
        map.insert(rel.clone(), DirCompareItem { rel, exists_left: true, exists_right: false, is_dir, size_left: size, size_right: 0, modified_left: mtime, modified_right: 0, same: false });
    }
    for (rel, size, mtime, is_dir) in rf {
        match map.get_mut(&rel) {
            Some(it) => {
                it.exists_right = true;
                it.size_right = size;
                it.modified_right = mtime;
                it.is_dir = it.is_dir || is_dir;
                it.same = it.is_dir || (it.size_left == size && it.modified_left == mtime);
            }
            None => {
                map.insert(rel.clone(), DirCompareItem { rel, exists_left: false, exists_right: true, is_dir, size_left: 0, size_right: size, modified_left: 0, modified_right: mtime, same: false });
            }
        }
    }
    Ok(map.into_values().collect())
}

fn with_ssh<F, R>(id: &str, state: &SshState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ssh2::Session) -> Result<R, String>,
{
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let ses = map.get_mut(id).ok_or_else(|| "未连接 SSH".to_string())?;
    f(ses)
}

// ---------- 传输进度（上传/下载/另存/目录下载统一事件流） ----------

#[derive(Serialize, Clone)]
struct TransferPayload {
    task_id: String,
    kind: String,
    name: String,
    done: u64,
    total: u64,
    state: String,
    error: Option<String>,
}

fn emit_transfer(app: &tauri::AppHandle, task_id: &str, kind: &str, name: &str, done: u64, total: u64, state: &str, error: Option<&str>) {
    let _ = app.emit(
        "uec-transfer",
        TransferPayload {
            task_id: task_id.to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
            done,
            total,
            state: state.to_string(),
            error: error.map(|s| s.to_string()),
        },
    );
}

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

// 包一层 Read：每次读取回报进度（done = base + 已读字节）
struct ProgressReader<'a, R: std::io::Read + ?Sized> {
    inner: &'a mut R,
    done: u64,
    last_emit: u64,
    base: u64,
    total: u64,
    task_id: String,
    name: String,
    app: tauri::AppHandle,
}

impl<'a, R: std::io::Read + ?Sized> std::io::Read for ProgressReader<'a, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.done += n as u64;
            if self.done < self.last_emit + 2_097_152 && !(self.total > 0 && self.done >= self.total) {
                return Ok(n);
            }
            self.last_emit = self.done;
            emit_transfer(
                &self.app,
                &self.task_id,
                "file",
                &self.name,
                self.base + self.done,
                self.total,
                "running",
                None,
            );
        }
        Ok(n)
    }
}

// FTP LIST 行解析：返回 (名称, 是否目录, 大小)；无法解析返回 None
// include_hidden=true 时保留隐藏文件（树列表用，前端开关控制过滤）；下载/统计保持 false
fn parse_ftp_list_line(trimmed: &str, include_hidden: bool) -> Option<(String, bool, u64)> {
    if trimmed.is_empty() {
        return None;
    }
    let is_link = trimmed.starts_with('l');
    if !trimmed.starts_with('d') && !is_link && !trimmed.starts_with('-') {
        return None;
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() < 9 {
        return None;
    }
    let name = fields[8..].join(" ");
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if !include_hidden && name.starts_with('.') {
        return None;
    }
    let is_dir = trimmed.starts_with('d');
    let size = if is_dir { 0 } else { fields[4].parse::<u64>().unwrap_or(0) };
    Some((name, is_dir || is_link, size))
}

// 256KB 缓冲拷贝（替代 io::copy 默认 8KB，显著减少 SFTP/FTP 往返）
fn pump_copy<R: std::io::Read, W: std::io::Write>(r: &mut R, w: &mut W) -> std::io::Result<u64> {
    let mut buf = [0u8; 262_144];
    let mut total = 0u64;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        total += n as u64;
    }
    Ok(total)
}

// SFTP 目录递归统计（文件数、总字节）
fn count_sftp_dir(sftp: &ssh2::Sftp, path: &Path, files: &mut u64, bytes: &mut u64) -> Result<(), String> {
    let entries = sftp.readdir(path).map_err(|e| e.to_string())?;
    for (p, stat) in entries {
        if stat.is_dir() {
            count_sftp_dir(sftp, &p, files, bytes)?;
        } else {
            *files += 1;
            *bytes += stat.size.unwrap_or(0);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn pull_sftp_dir(
    sftp: &ssh2::Sftp,
    remote: &Path,
    local: &Path,
    done: &mut u64,
    total: u64,
    task_id: &str,
    name: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    fs::create_dir_all(local).map_err(|e| e.to_string())?;
    let entries = sftp.readdir(remote).map_err(|e| e.to_string())?;
    for (p, stat) in entries {
        let fname = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if fname.is_empty() || fname.starts_with('.') {
            continue;
        }
        let local_child = local.join(&fname);
        if stat.is_dir() {
            pull_sftp_dir(sftp, &p, &local_child, done, total, task_id, name, app)?;
        } else {
            let size = stat.size.unwrap_or(0);
            let mut remote_file = sftp.open(&p).map_err(|e| e.to_string())?;
            let mut lf = fs::File::create(&local_child).map_err(|e| e.to_string())?;
            {
                let mut pr = ProgressReader {
                    inner: &mut remote_file,
                    done: 0, last_emit: 0,
                    base: *done,
                    total,
                    task_id: task_id.to_string(),
                    name: format!("{name}/{fname}"),
                    app: app.clone(),
                };
                pump_copy(&mut pr, &mut lf).map_err(|e| e.to_string())?;
            }
            *done += size;
        }
    }
    Ok(())
}

// FTP 目录递归统计
fn count_ftp_dir(ftp: &mut FtpStream, remote_rel: &str, files: &mut u64, bytes: &mut u64) -> Result<(), ftp::FtpError> {
    ftp.cwd(remote_rel)?;
    let raw = ftp.list(None)?;
    for line in raw {
        if let Some((name, is_dir, size)) = parse_ftp_list_line(line.trim_start(), false) {
            if is_dir {
                count_ftp_dir(ftp, &format!("{remote_rel}/{name}"), files, bytes)?;
            } else {
                *files += 1;
                *bytes += size;
            }
        }
    }
    ftp.cdup()?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn ftp_pull_dir(
    ftp: &mut FtpStream,
    remote_rel: &str,
    local_root: &Path,
    done: &mut u64,
    total: u64,
    task_id: &str,
    name: &str,
    app: &tauri::AppHandle,
) -> Result<(), ftp::FtpError> {
    ftp.cwd(remote_rel)?;
    fs::create_dir_all(local_root).map_err(|e| ftp::FtpError::ConnectionError(e))?;
    let raw = ftp.list(None)?;
    for line in raw {
        if let Some((fname, is_dir, size)) = parse_ftp_list_line(line.trim_start(), false) {
            if is_dir {
                let local_child = local_root.join(&fname);
                ftp_pull_dir(ftp, &format!("{remote_rel}/{fname}"), &local_child, done, total, task_id, name, app)?;
            } else {
                let local_file = local_root.join(&fname);
                let mut lf = fs::File::create(&local_file).map_err(|e| ftp::FtpError::ConnectionError(e))?;
                let file_cell = std::cell::RefCell::new(&mut lf);
                ftp.retr(&fname, |reader| {
                    let mut pr = ProgressReader {
                        inner: reader,
                        done: 0, last_emit: 0,
                        base: *done,
                        total,
                        task_id: task_id.to_string(),
                        name: format!("{name}/{fname}"),
                        app: app.clone(),
                    };
                    pump_copy(&mut pr, &mut *file_cell.borrow_mut())
                        .map(|_| ())
                        .map_err(|e| ftp::FtpError::ConnectionError(e))
                })?;
                *done += size;
            }
        }
    }
    ftp.cdup()?;
    Ok(())
}

#[tauri::command]
fn sftp_connect(
    host: String,
    port: u16,
    username: String,
    password: String,
    key_path: Option<String>,
    passphrase: Option<String>,
    auth_method: Option<String>,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    use std::net::{TcpStream, SocketAddr, ToSocketAddrs};
    use std::time::Duration;
    let addr: SocketAddr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS 解析失败: {e}"))?
        .next()
        .ok_or_else(|| "无法解析主机".to_string())?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(12)).map_err(|e| format!("连接失败(超时/拒绝): {e}"))?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
    let mut ses = ssh2::Session::new().map_err(|e| format!("会话失败: {e}"))?;
    ses.set_tcp_stream(tcp);
    ses.handshake().map_err(|e| format!("握手失败: {e}"))?;

    let server_methods = ses.auth_methods(&username).ok().map(|s| s.to_string());
    let want = auth_method.as_deref().unwrap_or("auto");

    struct PassPrompter(String);
    impl ssh2::KeyboardInteractivePrompt for PassPrompter {
        fn prompt<'a>(&mut self, _username: &str, _instructions: &str, prompts: &[ssh2::Prompt<'a>]) -> Vec<String> {
            prompts.iter().map(|_| self.0.clone()).collect()
        }
    }

    let auth = (|| -> Result<(), String> {
        match want {
            "key" => {
                let k = key_path.filter(|k| !k.is_empty()).unwrap_or_default();
                ses.userauth_pubkey_file(&username, None, std::path::Path::new(&k), passphrase.as_deref())
                    .map_err(|e| format!("密钥认证失败: {e}"))?;
                return Ok(());
            }
            "keyboard" => {
                let mut p = PassPrompter(password.clone());
                ses.userauth_keyboard_interactive(&username, &mut p)
                    .map_err(|e| format!("键盘交互认证失败: {e}"))?;
                return Ok(());
            }
            _ => {}
        }
        if let Some(key) = key_path.filter(|k| !k.is_empty()) {
            ses.userauth_pubkey_file(&username, None, std::path::Path::new(&key), passphrase.as_deref())
                .map_err(|e| format!("密钥认证失败（请检查私钥路径与口令）: {e}"))?;
            return Ok(());
        }
        let password_err: Option<String> = if !password.is_empty() {
            ses.userauth_password(&username, &password).err().map(|e| e.to_string())
        } else {
            Some("未提供密码".into())
        };
        if !ses.authenticated() {
            let mut p = PassPrompter(password.clone());
            let kbd = ses.userauth_keyboard_interactive(&username, &mut p);
            if !ses.authenticated() {
                return Err(format!(
                    "认证失败。请检查用户名/密码是否正确，或服务器是否允许密码登录。\n密码认证: {}\n键盘交互认证: {}\n服务器支持的认证方式: {}",
                    password_err.unwrap_or_else(|| "（接受或未尝试）".into()),
                    kbd.map(|_| "（被拒绝）".to_string()).unwrap_or_default(),
                    server_methods.clone().unwrap_or_else(|| "（无法获取）".into())
                ));
            }
        }
        Ok(())
    })();

    if auth.is_err() {
        return Err(auth.unwrap_err());
    }
    if !ses.authenticated() {
        return Err(format!(
            "认证失败（服务器拒绝了所有凭据）。服务器支持的认证方式: {}",
            server_methods.unwrap_or_else(|| "（无法获取）".into())
        ));
    }
    let id = format!("{host}:{port}:{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    state.0.lock().unwrap().insert(id.clone(), ses);
    Ok(id)
}

#[tauri::command]
fn sftp_disconnect(id: String, state: tauri::State<'_, SshState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
fn sftp_list(id: String, path: String, state: tauri::State<'_, SshState>) -> Result<FtpListResult, String> {
    with_ssh(&id, state.inner(), |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let entries = sftp.readdir(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (p, stat) in entries {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            // 隐藏文件不过滤：由前端 showHidden 开关统一控制（与本地树一致）
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            out.push(FtpEntry {
                name,
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0),
                modified: stat.mtime.unwrap_or(0),
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(FtpListResult { pwd: path, entries: out })
    })
}

#[tauri::command]
async fn sftp_download(id: String, remote_path: String, task_id: String, state: tauri::State<'_, SshState>, app: tauri::AppHandle) -> Result<String, String> {
    let st = SshState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
    let res = with_ssh(&id, &st, |ses| {
            let sftp = ses.sftp().map_err(|e| e.to_string())?;
            let name = Path::new(&remote_path).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_path.clone());
            let total = sftp.stat(Path::new(&remote_path)).map(|st| st.size.unwrap_or(0)).unwrap_or(0);
            let tmp = std::env::temp_dir().join(format!("uec_sftp_{}_{}", name, nanos()));
            let mut remote = sftp.open(Path::new(&remote_path)).map_err(|e| e.to_string())?;
            let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            {
                let mut pr = ProgressReader {
                    inner: &mut remote,
                    done: 0, last_emit: 0,
                    base: 0,
                    total,
                    task_id: task_id.clone(),
                    name: name.clone(),
                    app: app.clone(),
                };
                pump_copy(&mut pr, &mut file).map_err(|e| e.to_string())?;
            }
            emit_transfer(&app, &task_id, "down", &name, total, total, "done", None);
            Ok(tmp.to_string_lossy().to_string())
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "down", &remote_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
async fn sftp_upload(id: String, local_path: String, remote_path: String, task_id: String, state: tauri::State<'_, SshState>, app: tauri::AppHandle) -> Result<(), String> {
    let st = SshState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
    let res = with_ssh(&id, &st, |ses| {
            let sftp = ses.sftp().map_err(|e| e.to_string())?;
            let name = Path::new(&remote_path).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_path.clone());
            let total = fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            let mut lf = fs::File::open(&local_path).map_err(|e| e.to_string())?;
            let mut remote = sftp.create(Path::new(&remote_path)).map_err(|e| e.to_string())?;
            {
                let mut pr = ProgressReader {
                    inner: &mut lf,
                    done: 0, last_emit: 0,
                    base: 0,
                    total,
                    task_id: task_id.clone(),
                    name: name.clone(),
                    app: app.clone(),
                };
                let mut buf = [0u8; 65536];
                loop {
                    let n = pr.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    remote.write(&buf[..n]).map_err(|e| e.to_string())?;
                }
            }
            emit_transfer(&app, &task_id, "up", &name, total, total, "done", None);
            Ok(())
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "up", &remote_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
fn sftp_mkdir(id: String, path: String, state: tauri::State<'_, SshState>) -> Result<(), String> {
    with_ssh(&id, state.inner(), |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        sftp.mkdir(std::path::Path::new(&path), 0o755).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn sftp_create_file(id: String, path: String, state: tauri::State<'_, SshState>) -> Result<(), String> {
    with_ssh(&id, state.inner(), |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let _file = sftp.create(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
fn sftp_delete(id: String, path: String, is_dir: bool, state: tauri::State<'_, SshState>) -> Result<(), String> {
    with_ssh(&id, state.inner(), |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        if is_dir {
            sftp.rmdir(std::path::Path::new(&path)).map_err(|e| e.to_string())
        } else {
            sftp.unlink(std::path::Path::new(&path)).map_err(|e| e.to_string())
        }
    })
}

#[derive(Serialize)]
struct KeyGenResult {
    private_path: String,
    public_key: String,
}

#[tauri::command]
fn ssh_generate_key(path: String, passphrase: Option<String>) -> Result<KeyGenResult, String> {
    let pp = passphrase.unwrap_or_default();
    let status = std::process::Command::new("ssh-keygen")
        .args(["-t", "ed25519", "-f", &path, "-N", &pp, "-C", "uec"])
        .status()
        .map_err(|e| format!("无法调用 ssh-keygen（请确认系统已安装 OpenSSH）: {e}"))?;
    if !status.success() {
        return Err("ssh-keygen 执行失败".into());
    }
    let pubkey = std::fs::read_to_string(format!("{}.pub", path)).map_err(|e| e.to_string())?;
    Ok(KeyGenResult {
        private_path: path,
        public_key: pubkey.trim().to_string(),
    })
}

#[tauri::command]
fn sftp_rename(id: String, old_path: String, new_name: String, state: tauri::State<'_, SshState>) -> Result<(), String> {
    with_ssh(&id, state.inner(), |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let parent = std::path::Path::new(&old_path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/"));
        let new_path = parent.join(&new_name);
        sftp.rename(std::path::Path::new(&old_path), &new_path, None).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn ftp_rename(id: String, old_name: String, new_name: String, state: tauri::State<'_, FtpState>) -> Result<(), String> {
    with_ftp(&id, state.inner(), |ftp| {
        ftp.rename(&old_name, &new_name).map_err(|e| ftp::FtpError::InvalidResponse(format!("重命名失败: {e}")))
    })
}


#[tauri::command]
async fn sftp_download_dir(id: String, remote_path: String, local_root: String, task_id: String, state: tauri::State<'_, SshState>, app: tauri::AppHandle) -> Result<u64, String> {
    let st = SshState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
    let res = with_ssh(&id, &st, |ses| {
            let sftp = ses.sftp().map_err(|e| e.to_string())?;
            let name = Path::new(&remote_path).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_path.clone());
            emit_transfer(&app, &task_id, "dir", &name, 0, 0, "running", None);
            let mut files = 0u64;
            let mut bytes = 0u64;
            count_sftp_dir(&sftp, Path::new(&remote_path), &mut files, &mut bytes)?;
            let mut done = 0u64;
            let target = Path::new(&local_root).join(&name);
            pull_sftp_dir(&sftp, Path::new(&remote_path), &target, &mut done, bytes, &task_id, &name, &app)?;
            emit_transfer(&app, &task_id, "dir", &name, bytes, bytes, "done", None);
            Ok(files)
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "dir", &remote_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
async fn ftp_download_dir(id: String, remote_path: String, local_root: String, task_id: String, state: tauri::State<'_, FtpState>, app: tauri::AppHandle) -> Result<u64, String> {
    let ftp_st = FtpState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
    let res = with_ftp(&id, &ftp_st, |ftp| {
            let name = remote_path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&remote_path).to_string();
            emit_transfer(&app, &task_id, "dir", &name, 0, 0, "running", None);
            let mut files = 0u64;
            let mut bytes = 0u64;
            count_ftp_dir(ftp, &remote_path, &mut files, &mut bytes)?;
            let mut done = 0u64;
            let target = Path::new(&local_root).join(&name);
            ftp_pull_dir(ftp, &remote_path, &target, &mut done, bytes, &task_id, &name, &app)?;
            emit_transfer(&app, &task_id, "dir", &name, bytes, bytes, "done", None);
            Ok(files)
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "dir", &remote_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
async fn sftp_save_as(id: String, remote_path: String, local_path: String, task_id: String, state: tauri::State<'_, SshState>, app: tauri::AppHandle) -> Result<(), String> {
    let st = SshState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
    let res = with_ssh(&id, &st, |ses| {
            let sftp = ses.sftp().map_err(|e| e.to_string())?;
            let name = Path::new(&remote_path).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_path.clone());
            let total = sftp.stat(Path::new(&remote_path)).map(|st| st.size.unwrap_or(0)).unwrap_or(0);
            let mut remote = sftp.open(Path::new(&remote_path)).map_err(|e| e.to_string())?;
            let mut lf = fs::File::create(&local_path).map_err(|e| e.to_string())?;
            {
                let mut pr = ProgressReader {
                    inner: &mut remote,
                    done: 0, last_emit: 0,
                    base: 0,
                    total,
                    task_id: task_id.clone(),
                    name: name.clone(),
                    app: app.clone(),
                };
                pump_copy(&mut pr, &mut lf).map_err(|e| e.to_string())?;
            }
            emit_transfer(&app, &task_id, "down", &name, total, total, "done", None);
            Ok(())
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "down", &remote_path, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


#[tauri::command]
async fn ftp_save_as(id: String, remote_name: String, local_path: String, task_id: String, state: tauri::State<'_, FtpState>, app: tauri::AppHandle) -> Result<(), String> {
    let ftp_st = FtpState(state.0.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
    let res = with_ftp(&id, &ftp_st, |ftp| {
            let name = Path::new(&remote_name).file_name()
                .map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| remote_name.clone());
            let total = ftp.size(&remote_name).ok().flatten().map(|v| v as u64).unwrap_or(0);
            let mut file = fs::File::create(&local_path).map_err(|e| ftp::FtpError::ConnectionError(e))?;
            let file_cell = std::cell::RefCell::new(&mut file);
            let name_ref = name.clone();
            let task_ref = task_id.clone();
            let app_ref = app.clone();
            ftp.retr(&remote_name, |reader| {
                let mut pr = ProgressReader {
                    inner: reader,
                    done: 0, last_emit: 0,
                    base: 0,
                    total,
                    task_id: task_ref.clone(),
                    name: name_ref.clone(),
                    app: app_ref.clone(),
                };
                pump_copy(&mut pr, &mut *file_cell.borrow_mut())
                    .map(|_| ())
                    .map_err(|e| ftp::FtpError::ConnectionError(e))
            })?;
            emit_transfer(&app, &task_id, "down", &name, total, total, "done", None);
            Ok(())
        });
        if let Err(e) = &res {
            emit_transfer(&app, &task_id, "down", &remote_name, 0, 0, "error", Some(e));
        }
        res
    })
    .await
    .map_err(|e| format!("传输任务被中止: {e}"))?
}


// ============ 归档虚拟文件夹（tar/tar.gz/tar.bz2/zip） ============

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    TarPlain,
    TarGz,
    TarBz2,
    Zip,
    External, // bsdtar 支持的外部格式（rar/7z/iso/cab/tar.xz 等），只读
}

#[derive(serde::Serialize)]
struct ArchiveEntry {
    name: String,
    size: u64,
    is_dir: bool,
}

#[derive(serde::Serialize)]
struct ArchivePreview {
    text: String,
    is_binary: bool,
    truncated: bool,
    size: u64,
}

// 需要 bsdtar（libarchive）处理的外部归档扩展名
const EXTERNAL_ARCHIVE_EXTS: &[&str] = &[
    ".rar", ".7z", ".iso", ".cab", ".cpio", ".deb", ".rpm", ".zst", ".lz4",
    ".txz", ".tar.xz", ".tar.zst",
];

// 按魔数与扩展名识别归档格式
fn detect_archive_kind(path: &str) -> Result<ArchiveKind, String> {
    use std::io::Read;
    let lower = path.to_lowercase();
    let mut head = [0u8; 512];
    let n = {
        let mut f = std::fs::File::open(path).map_err(|e| format!("打开文件: {e}"))?;
        f.read(&mut head).map_err(|e| e.to_string())?
    };
    let sig = &head[..n];
    if sig.starts_with(b"PK\x03\x04") || lower.ends_with(".zip") {
        Ok(ArchiveKind::Zip) // jar/war/ear 等 zip 家族走 PK 魔数
    } else if sig.starts_with(&[0x1f, 0x8b]) {
        Ok(ArchiveKind::TarGz)
    } else if sig.starts_with(&[0x42, 0x5a, 0x68]) || lower.ends_with(".bz2") || lower.ends_with(".tbz2") {
        Ok(ArchiveKind::TarBz2)
    } else if sig.starts_with(&[0xfd, 0x37, 0x7a, 0x58, 0x5a]) // xz
        || sig.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) // zstd
        || sig.starts_with(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) // 7z
        || sig.starts_with(b"Rar!\x1a\x07") // rar
        || EXTERNAL_ARCHIVE_EXTS.iter().any(|e| lower.ends_with(e))
    {
        Ok(ArchiveKind::External)
    } else if n > 262 && &sig[257..262] == b"ustar" {
        Ok(ArchiveKind::TarPlain)
    } else {
        Err("无法识别的归档格式".to_string())
    }
}

// tar 家族读取器（gz/bz2/明文）
fn open_tar_reader(path: &str, kind: ArchiveKind) -> Result<Box<dyn std::io::Read + 'static>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件: {e}"))?;
    match kind {
        ArchiveKind::TarGz => Ok(Box::new(flate2::read::GzDecoder::new(file))),
        ArchiveKind::TarBz2 => Ok(Box::new(bzip2::read::BzDecoder::new(file))),
        _ => Ok(Box::new(file)),
    }
}

// 规范化归档内条目名（去前导 /，目录去尾 /）
fn norm_entry(name: &str) -> String {
    let mut s = name.trim_start_matches('/').to_string();
    while s.ends_with('/') {
        s.pop();
    }
    s
}

fn list_tar_entries(path: &str, kind: ArchiveKind) -> Result<Vec<ArchiveEntry>, String> {
    let reader = open_tar_reader(path, kind)?;
    let mut ar = tar::Archive::new(reader);
    let mut out = Vec::new();
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let raw = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if raw.is_empty() {
            continue;
        }
        let name = norm_entry(&raw);
        if name.is_empty() {
            continue;
        }
        out.push(ArchiveEntry {
            name,
            size: entry.size(),
            is_dir: entry.header().entry_type().is_dir(),
        });
    }
    Ok(out)
}

fn list_zip_entries(path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件: {e}"))?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for i in 0..z.len() {
        let e = z.by_index(i).map_err(|e| e.to_string())?;
        let raw = e.name().to_string();
        if raw.is_empty() {
            continue;
        }
        let name = norm_entry(&raw);
        if name.is_empty() {
            continue;
        }
        out.push(ArchiveEntry {
            name,
            size: e.size(),
            is_dir: e.is_dir(),
        });
    }
    Ok(out)
}

// 读取字节 → 截断/NUL 探测 → ArchivePreview
fn finish_preview(mut buf: Vec<u8>, max_bytes: usize) -> ArchivePreview {
    let truncated = buf.len() > max_bytes;
    if truncated {
        buf.truncate(max_bytes);
    }
    let is_binary = buf.contains(&0);
    ArchivePreview {
        text: if is_binary { String::new() } else { String::from_utf8_lossy(&buf).to_string() },
        is_binary,
        truncated,
        size: buf.len() as u64,
    }
}

fn read_tar_entry(path: &str, kind: ArchiveKind, entry_name: &str, max_bytes: usize) -> Result<ArchivePreview, String> {
    use std::io::Read;
    let reader = open_tar_reader(path, kind)?;
    let mut ar = tar::Archive::new(reader);
    for entry in ar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let raw = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        if norm_entry(&raw) != entry_name {
            continue;
        }
        let mut buf = Vec::new();
        entry.take(max_bytes as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        return Ok(finish_preview(buf, max_bytes));
    }
    Err(format!("归档内未找到条目: {entry_name}"))
}

fn read_zip_entry(path: &str, entry_name: &str, max_bytes: usize) -> Result<ArchivePreview, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件: {e}"))?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut f = z.by_name(entry_name).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(max_bytes as u64 + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(finish_preview(buf, max_bytes))
}

// 重建 tar 家族归档：保留其余条目（header + 数据），替换目标条目内容，写临时文件后原子替换
fn rebuild_tar(path: &str, kind: ArchiveKind, entry_name: &str, new_content: &str) -> Result<(), String> {
    use std::io::{Read, Write};
    let reader = open_tar_reader(path, kind)?;
    let mut ar = tar::Archive::new(reader);
    let mut out: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut out);
        for entry in ar.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let raw = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let name = norm_entry(&raw);
            if name.is_empty() {
                continue;
            }
            let mut header = entry.header().clone();
            if name == entry_name {
                header.set_size(new_content.len() as u64);
                builder.append_data(&mut header, name.as_str(), new_content.as_bytes()).map_err(|e| e.to_string())?;
            } else if header.entry_type().is_dir() {
                header.set_size(0);
                builder.append_data(&mut header, name.as_str(), std::io::empty()).map_err(|e| e.to_string())?;
            } else {
                let mut data = Vec::new();
                entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
                header.set_size(data.len() as u64);
                builder.append_data(&mut header, name.as_str(), data.as_slice()).map_err(|e| e.to_string())?;
            }
        }
        builder.finish().map_err(|e| e.to_string())?;
    }
    let compressed: Vec<u8> = match kind {
        ArchiveKind::TarGz => {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&out).map_err(|e| e.to_string())?;
            enc.finish().map_err(|e| e.to_string())?
        }
        ArchiveKind::TarBz2 => {
            let mut enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
            enc.write_all(&out).map_err(|e| e.to_string())?;
            enc.finish().map_err(|e| e.to_string())?
        }
        _ => out,
    };
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, &compressed).map_err(|e| format!("写入临时文件: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换原文件: {e}"))?;
    Ok(())
}

// 重建 zip 归档：全量重写临时文件后原子替换
fn rebuild_zip(path: &str, entry_name: &str, new_content: &str) -> Result<(), String> {
    use std::io::{Read, Write};
    let file = std::fs::File::open(path).map_err(|e| format!("打开文件: {e}"))?;
    let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let tmp = format!("{path}.tmp");
    {
        let out_file = std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件: {e}"))?;
        let mut zw = zip::ZipWriter::new(out_file);
        for i in 0..z.len() {
            let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            let is_dir = entry.is_dir();
            let mut options = zip::write::SimpleFileOptions::default()
                .compression_method(entry.compression())
                .unix_permissions(entry.unix_mode().unwrap_or(if is_dir { 0o755 } else { 0o644 }));
            if name == entry_name {
                options = options.compression_method(zip::CompressionMethod::Deflated);
                zw.start_file(&name, options).map_err(|e| e.to_string())?;
                zw.write_all(new_content.as_bytes()).map_err(|e| e.to_string())?;
            } else if is_dir {
                zw.add_directory(&name, options).map_err(|e| e.to_string())?;
            } else {
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                zw.start_file(&name, options).map_err(|e| e.to_string())?;
                zw.write_all(&buf).map_err(|e| e.to_string())?;
            }
        }
        zw.finish().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换原文件: {e}"))?;
    Ok(())
}

// 列出归档内文件清单（tar/tar.gz/tar.bz2/zip + bsdtar 外部格式）
#[tauri::command]
fn archive_list(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let kind = detect_archive_kind(&path)?;
    match kind {
        ArchiveKind::Zip => list_zip_entries(&path),
        ArchiveKind::External => list_external_entries(&path),
        _ => list_tar_entries(&path, kind),
    }
}

// 读取归档内单个条目的内容（最多 max_bytes 字节，用于打开/预览）
#[tauri::command]
fn archive_read(path: String, entry_name: String, max_bytes: usize) -> Result<ArchivePreview, String> {
    let kind = detect_archive_kind(&path)?;
    match kind {
        ArchiveKind::Zip => read_zip_entry(&path, &entry_name, max_bytes),
        ArchiveKind::External => read_external_entry(&path, &entry_name, max_bytes),
        _ => read_tar_entry(&path, kind, &entry_name, max_bytes),
    }
}

// 更新归档内单个条目内容（重建归档回写，本地就地更新；远程由前端先同步到缓存临时副本）
#[tauri::command]
fn archive_update(path: String, entry_name: String, new_content: String) -> Result<(), String> {
    let kind = detect_archive_kind(&path)?;
    match kind {
        ArchiveKind::Zip => rebuild_zip(&path, &entry_name, &new_content),
        ArchiveKind::External => Err("该归档格式（rar/7z/iso 等）不支持编辑回写，请下载到本地后编辑保存".to_string()),
        _ => rebuild_tar(&path, kind, &entry_name, &new_content),
    }
}

// bsdtar（macOS 自带 libarchive）列出外部归档条目：-tvf 输出 权限 用户 组 大小 日期 时间 名称
fn list_external_entries(path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let out = std::process::Command::new("bsdtar")
        .args(["-tvf", path])
        .env("LANG", "C")
        .output()
        .map_err(|e| format!("无法执行 bsdtar: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut result = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        // libarchive -tvf 固定布局：权限 用户 组 大小 月 日 时间 名称（C locale）
        if fields.len() < 9 {
            continue;
        }
        let perms = fields[0];
        let size = fields[4].parse::<u64>().unwrap_or(0);
        // 名称从日期时间（3 个 token）之后开始，可含空格
        let raw = fields[8..].join(" ");
        let name = norm_entry(&raw);
        if name.is_empty() || name == "." {
            continue;
        }
        result.push(ArchiveEntry {
            name,
            size,
            is_dir: perms.starts_with('d'),
        });
    }
    Ok(result)
}

// bsdtar 读取外部归档内条目（-xOf 输出原始字节，二进制安全）
fn read_external_entry(path: &str, entry_name: &str, max_bytes: usize) -> Result<ArchivePreview, String> {
    let out = std::process::Command::new("bsdtar")
        .args(["-xOf", path, entry_name])
        .env("LANG", "C")
        .output()
        .map_err(|e| format!("无法执行 bsdtar: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(finish_preview(out.stdout, max_bytes))
}

// 安全拼接待提取目标路径（防 zip-slip：拒绝绝对路径与 .. 穿越）
fn safe_extract_target(target_dir: &str, entry: &str) -> Result<std::path::PathBuf, String> {
    let norm = norm_entry(entry);
    if norm.is_empty() {
        return Err("空条目名".to_string());
    }
    let clean = norm.trim_start_matches('/');
    if clean == ".." || clean.starts_with("../") || clean.split('/').any(|seg| seg == "..") {
        return Err(format!("非法条目路径: {clean}"));
    }
    let base = std::path::Path::new(target_dir);
    let out = base.join(clean);
    if !out.starts_with(base) {
        return Err(format!("非法条目路径: {clean}"));
    }
    Ok(out)
}

// 条目命中：目录提取整个子树（entry_name 为空 = 提取根下全部），文件精确匹配
fn entry_matches(entry: &str, key: &str, is_dir: bool) -> bool {
    if is_dir {
        key.is_empty() || entry == key || entry.starts_with(&format!("{key}/"))
    } else {
        entry == key
    }
}

// 从归档中提取文件/目录到目标目录（zip/tar 家族走库，rar/7z/iso 等外部格式走 bsdtar）
#[tauri::command]
fn extract_archive_entry(path: String, entry_name: String, target_dir: String, is_dir: bool) -> Result<Vec<String>, String> {
    let kind = detect_archive_kind(&path)?;
    let mut extracted: Vec<String> = Vec::new();
    match kind {
        ArchiveKind::Zip => {
            let file = std::fs::File::open(&path).map_err(|e| format!("打开文件: {e}"))?;
            let mut z = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            let key = norm_entry(&entry_name);
            for i in 0..z.len() {
                let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
                let raw = entry.name().to_string();
                let norm = norm_entry(&raw);
                if norm.is_empty() || !entry_matches(&norm, &key, is_dir) {
                    continue;
                }
                let target = safe_extract_target(&target_dir, &norm)?;
                if entry.is_dir() {
                    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                }
                extracted.push(norm);
            }
        }
        ArchiveKind::TarPlain | ArchiveKind::TarGz | ArchiveKind::TarBz2 => {
            let reader = open_tar_reader(&path, kind)?;
            let mut ar = tar::Archive::new(reader);
            let key = norm_entry(&entry_name);
            for entry in ar.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                let raw = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                let norm = norm_entry(&raw);
                if norm.is_empty() || !entry_matches(&norm, &key, is_dir) {
                    continue;
                }
                let target = safe_extract_target(&target_dir, &norm)?;
                if entry.header().entry_type().is_dir() {
                    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                }
                extracted.push(norm);
            }
        }
        ArchiveKind::External => {
            let key = norm_entry(&entry_name);
            let entries = list_external_entries(&path)?;
            for e in entries {
                let norm = norm_entry(&e.name);
                if norm.is_empty() || !entry_matches(&norm, &key, is_dir) {
                    continue;
                }
                let target = safe_extract_target(&target_dir, &norm)?;
                if e.is_dir {
                    fs::create_dir_all(&target).map_err(|err| err.to_string())?;
                    continue;
                }
                let out = std::process::Command::new("bsdtar")
                    .args(["-xOf", &path, &e.name])
                    .env("LANG", "C")
                    .output()
                    .map_err(|err| format!("无法执行 bsdtar: {err}"))?;
                if !out.status.success() {
                    return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                std::fs::write(&target, &out.stdout).map_err(|err| err.to_string())?;
                extracted.push(norm);
            }
        }
    }
    if extracted.is_empty() {
        Err(format!("归档内未找到条目: {entry_name}"))
    } else {
        Ok(extracted)
    }
}

// 测试归档完整性：zip/tar 家族全量读取校验（含 CRC），rar/7z 等外部格式用 bsdtar 解压到空输出校验
// 测试归档完整性：zip/tar 家族全量读取校验（含 CRC），rar/7z 等外部格式用 bsdtar 解压到空输出校验
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_search_and_replace() {
        let dir = std::env::temp_dir().join("uec_test_dir");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "hello world\nfoo bar\nhello again").unwrap();
        fs::write(dir.join("sub/b.txt"), "Hello World\nnothing").unwrap();
        fs::write(dir.join("img.png"), [0u8, 1, 2, 3, 0, 5, 6, 7]).unwrap();

        let dir_str = dir.to_string_lossy().to_string();
        let res = search_in_dir(dir_str.clone(), "hello".into(), false, false, false).unwrap();
        assert_eq!(res.files, 2, "two text files should match");
        assert_eq!(res.items.len(), 3, "3 'hello' occurrences");
        assert!(res.items.iter().all(|i| !i.path.ends_with("png")));

        let res2 = search_in_dir(dir_str.clone(), "Hello".into(), false, true, false).unwrap();
        assert_eq!(res2.items.len(), 3, "case-insensitive regex matches all hello variants");

        let repl = replace_in_dir(dir_str.clone(), "hello".into(), "bye".into(), false, false, false).unwrap();
        assert_eq!(repl.replaced, 2);
        let check = fs::read_to_string(dir.join("a.txt")).unwrap();
        assert!(!check.contains("hello") && check.contains("bye"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_line_endings() {
        assert_eq!(detect_line_endings(b"a\r\nb\r\n") , "crlf");
        assert_eq!(detect_line_endings(b"a\nb\n"), "lf");
        assert_eq!(detect_line_endings(b"a\rb\r"), "cr");
    }

    #[test]
    fn test_cjk_encoding_roundtrip() {
        let tmp = std::env::temp_dir().join("uec_gbk_test.txt");
        let text = "中文测试 \u{6587}\u{4ef6}\u{6d4b}\u{8bd5} 123";
        save_text_file(tmp.to_string_lossy().to_string(), text.to_string(), Some("gbk".into()), Some("lf".into()), None).unwrap();
        let res = read_text_file(tmp.to_string_lossy().to_string()).unwrap();
        assert!(!res.is_binary, "GBK file must decode as text");
        assert_eq!(res.encoding, "gbk");
        assert_eq!(res.text, text);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    #[ignore = "需要环境变量 UEC_SFTP_TEST_HOST/PORT/USER/PASS 指定的可连接 SFTP 服务器"]
    fn test_live_sftp_debug() {
        use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
        use std::time::Duration;
        // 凭据通过环境变量注入，避免在代码中硬编码服务器地址与口令
        let (Ok(host), Ok(port), Ok(user), Ok(pass)) = (
            std::env::var("UEC_SFTP_TEST_HOST"),
            std::env::var("UEC_SFTP_TEST_PORT"),
            std::env::var("UEC_SFTP_TEST_USER"),
            std::env::var("UEC_SFTP_TEST_PASS"),
        ) else {
            println!(">> 未配置 UEC_SFTP_TEST_* 环境变量，跳过");
            return;
        };
        let port: u16 = port.parse().unwrap_or(22);
        let addr: SocketAddr = (host.as_str(), port)
            .to_socket_addrs()
            .unwrap()
            .next()
            .unwrap();
        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).expect("connect");
        let mut ses = ssh2::Session::new().expect("session");
        ses.set_tcp_stream(tcp);
        ses.handshake().expect("handshake");
        println!(">> 服务器支持的认证方式: {:?}", ses.auth_methods(&user));
        let pwd = ses.userauth_password(&user, &pass);
        println!(">> 密码认证: {:?}, authenticated={}", pwd.map_err(|e| e.to_string()), ses.authenticated());
        if !ses.authenticated() {
            struct P(String);
            impl ssh2::KeyboardInteractivePrompt for P {
                fn prompt<'a>(&mut self, _u: &str, _i: &str, ps: &[ssh2::Prompt<'a>]) -> Vec<String> {
                    ps.iter().map(|_| self.0.clone()).collect()
                }
            }
            let mut p = P(pass.clone());
            let kbd = ses.userauth_keyboard_interactive(&user, &mut p);
            println!(">> 键盘交互: {:?}, authenticated={}", kbd.map_err(|e| e.to_string()), ses.authenticated());
        }
        if ses.authenticated() {
            let sftp = ses.sftp();
            println!(">> sftp 子系统是否可用: {}", sftp.is_ok());
            if let Ok(s) = sftp {
                println!(">> 根目录条目数: {:?}", s.readdir(std::path::Path::new("/")).map(|v| v.len()));
            }
        }
    }

    #[test]
    fn test_big_page_pagination() {
        let tmp = std::env::temp_dir().join("uec_bigpage.txt");
        let mut lines = String::new();
        for i in 0..200 {
            lines.push_str(&format!("line {i:04}\n"));
        }
        fs::write(&tmp, lines.as_bytes()).unwrap();
        let p1 = text_page(tmp.to_string_lossy().to_string(), 0, 300).unwrap();
        assert!(p1.done == false || p1.truncated_at > 0);
        assert!(p1.text.starts_with("line 0000\n"));
        assert!(p1.text.ends_with('\n'), "should cut at newline boundary");
        let next = p1.start + p1.truncated_at;
        let p2 = text_page(tmp.to_string_lossy().to_string(), next, 300).unwrap();
        assert_eq!(p2.start, next, "next page continues at previous boundary");
        // write back a page and verify roundtrip
        text_write(tmp.to_string_lossy().to_string(), 0, "line 0000".repeat(1)).unwrap();
        let chk = text_page(tmp.to_string_lossy().to_string(), 0, 40).unwrap();
        assert!(chk.text.starts_with("line 0"));
        let _ = fs::remove_file(&tmp);
    }

    // ---------- 归档虚拟文件夹 ----------

    // 构建测试 tar.gz（files: (条目名, 内容)，目录条目以 / 结尾）
    fn make_tar_gz(path: &std::path::Path, files: &[(&str, &str)]) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut enc);
            for (name, content) in files {
                let mut header = tar::Header::new_gnu();
                if name.ends_with('/') {
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_mode(0o755);
                    header.set_size(0);
                    builder.append_data(&mut header, *name, std::io::empty()).unwrap();
                } else {
                    header.set_entry_type(tar::EntryType::Regular);
                    header.set_mode(0o644);
                    header.set_size(content.len() as u64);
                    builder.append_data(&mut header, *name, content.as_bytes()).unwrap();
                }
            }
            builder.finish().unwrap();
        }
        enc.finish().unwrap();
    }

    // 构建测试 zip（files: (条目名, 内容)）
    fn make_zip(path: &std::path::Path, files: &[(&str, &str)]) {
        use std::io::Write;
        let file = fs::File::create(path).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in files {
            if name.ends_with('/') {
                zw.add_directory(*name, opts).unwrap();
            } else {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(content.as_bytes()).unwrap();
            }
        }
        zw.finish().unwrap();
    }

    #[test]
    fn test_archive_list_and_read() {
        let dir = std::env::temp_dir().join("uec_arc_list");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.tar.gz");
        make_tar_gz(&ps, &[("hello.txt", "hello world\n"), ("conf/app.yaml", "port: 8080\n")]);
        let entries = archive_list(ps.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 2, "tar.gz 应列出 2 个条目");
        let prev = archive_read(ps.to_string_lossy().to_string(), "hello.txt".to_string(), 65536).unwrap();
        assert!(!prev.is_binary && !prev.truncated);
        assert_eq!(prev.text, "hello world\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_extract_archive_entry_zip() {
        let dir = std::env::temp_dir().join("uec_extract");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.zip");
        make_zip(&ps, &[("root.txt", "root content\n"), ("sub/", ""), ("sub/inner.txt", "inner content\n")]);
        let out = dir.join("out");
        // 单文件提取
        let files = extract_archive_entry(ps.to_string_lossy().to_string(), "root.txt".to_string(), out.to_string_lossy().to_string(), false).unwrap();
        assert_eq!(files, vec!["root.txt"]);
        assert_eq!(fs::read_to_string(out.join("root.txt")).unwrap(), "root content\n");
        // 目录子树提取
        let files = extract_archive_entry(ps.to_string_lossy().to_string(), "sub".to_string(), out.to_string_lossy().to_string(), true).unwrap();
        assert!(files.contains(&"sub/inner.txt".to_string()));
        assert_eq!(fs::read_to_string(out.join("sub/inner.txt")).unwrap(), "inner content\n");
        // 根目录整体解压（entry_name 为空 + is_dir=true）
        let out2 = dir.join("out2");
        let files = extract_archive_entry(ps.to_string_lossy().to_string(), "".to_string(), out2.to_string_lossy().to_string(), true).unwrap();
        assert!(files.contains(&"root.txt".to_string()) && files.contains(&"sub/inner.txt".to_string()));
        assert_eq!(fs::read_to_string(out2.join("sub/inner.txt")).unwrap(), "inner content\n");
        // zip-slip 防护：.. 穿越必须拒绝
        let evil = safe_extract_target(out.to_string_lossy().as_ref(), "../evil.txt");
        assert!(evil.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_archive_read_truncates() {
        let dir = std::env::temp_dir().join("uec_arc_trunc");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.tar.gz");
        make_tar_gz(&ps, &[("hello.txt", "hello world\n")]);
        let prev = archive_read(ps.to_string_lossy().to_string(), "hello.txt".to_string(), 5).unwrap();
        assert!(prev.truncated, "超过 max_bytes 应标记截断");
        assert_eq!(prev.text, "hello");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_zip_list_read_and_update() {
        let dir = std::env::temp_dir().join("uec_arc_zip");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.zip");
        make_zip(&ps, &[("conf/app.yaml", "port: 8080\n"), ("readme.txt", "keep me\n")]);
        let entries = archive_list(ps.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 2, "zip 应列出 2 个条目");
        let prev = archive_read(ps.to_string_lossy().to_string(), "conf/app.yaml".to_string(), 65536).unwrap();
        assert_eq!(prev.text, "port: 8080\n");
        archive_update(ps.to_string_lossy().to_string(), "conf/app.yaml".to_string(), "port: 9090\n".to_string()).unwrap();
        let after = archive_read(ps.to_string_lossy().to_string(), "conf/app.yaml".to_string(), 65536).unwrap();
        assert_eq!(after.text, "port: 9090\n");
        let keep = archive_read(ps.to_string_lossy().to_string(), "readme.txt".to_string(), 65536).unwrap();
        assert_eq!(keep.text, "keep me\n", "未编辑条目应保留");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_jar_identified_as_zip() {
        let dir = std::env::temp_dir().join("uec_arc_jar");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("app.jar");
        make_zip(&ps, &[("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n"), ("com/App.class", "\u{0}\u{ca}\u{fe}\u{ba}\u{be}")]);
        let entries = archive_list(ps.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 2, "jar 应列出 2 个条目");
        let prev = archive_read(ps.to_string_lossy().to_string(), "META-INF/MANIFEST.MF".to_string(), 65536).unwrap();
        assert_eq!(prev.text, "Manifest-Version: 1.0\n");
        let bin = archive_read(ps.to_string_lossy().to_string(), "com/App.class".to_string(), 65536).unwrap();
        assert!(bin.is_binary, "class 文件应判定为二进制");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_external_archive_7z_via_bsdtar() {
        let dir = std::env::temp_dir().join("uec_arc_7z");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "hello 7z\n").unwrap();
        fs::write(dir.join("sub/b.bin"), [0u8, 1, 2, 3, 0, 5]).unwrap();
        let ps = dir.join("sample.7z");
        let mk = std::process::Command::new("bsdtar")
            .args(["-a", "-cf"])
            .arg(&ps)
            .arg("-C")
            .arg(&dir)
            .arg("a.txt")
            .arg("sub")
            .status();
        if mk.is_err() {
            eprintln!("bsdtar 不可用，跳过外部格式测试");
            return;
        }
        let entries = archive_list(ps.to_string_lossy().to_string()).unwrap();
        assert!(entries.iter().any(|e| e.name == "a.txt" && !e.is_dir), "7z 应包含 a.txt");
        assert!(entries.iter().any(|e| e.name == "sub/b.bin"), "7z 应包含 sub/b.bin");
        let prev = archive_read(ps.to_string_lossy().to_string(), "a.txt".to_string(), 65536).unwrap();
        assert_eq!(prev.text, "hello 7z\n");
        let bin = archive_read(ps.to_string_lossy().to_string(), "sub/b.bin".to_string(), 65536).unwrap();
        assert!(bin.is_binary, "二进制条目应判定为二进制");
        let err = archive_update(ps.to_string_lossy().to_string(), "a.txt".to_string(), "x".to_string());
        assert!(err.is_err(), "外部格式应拒绝回写");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_tar_gz_update_preserves_others() {
        let dir = std::env::temp_dir().join("uec_arc_tgz_upd");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.tar.gz");
        make_tar_gz(&ps, &[("hello.txt", "old hello\n"), ("readme.txt", "keep me\n")]);
        archive_update(ps.to_string_lossy().to_string(), "hello.txt".to_string(), "changed!\n".to_string()).unwrap();
        let after = archive_read(ps.to_string_lossy().to_string(), "hello.txt".to_string(), 65536).unwrap();
        assert_eq!(after.text, "changed!\n");
        let keep = archive_read(ps.to_string_lossy().to_string(), "readme.txt".to_string(), 65536).unwrap();
        assert_eq!(keep.text, "keep me\n", "未编辑条目应保留");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_archive_list_detects_bzip2() {
        use std::io::Write;
        let dir = std::env::temp_dir().join("uec_arc_bz2");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ps = dir.join("sample.tar.bz2");
        let file = fs::File::create(&ps).unwrap();
        let mut enc = bzip2::write::BzEncoder::new(file, bzip2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut enc);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_size(5);
            builder.append_data(&mut header, "b.txt", &b"hello"[..]).unwrap();
            builder.finish().unwrap();
        }
        enc.finish().unwrap();
        let entries = archive_list(ps.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 1, "tar.bz2 应识别并列出条目");
        let prev = archive_read(ps.to_string_lossy().to_string(), "b.txt".to_string(), 65536).unwrap();
        assert_eq!(prev.text, "hello");
        let _ = fs::remove_dir_all(&dir);
    }
}

// ============ 本地文件操作（右键菜单） ============

#[tauri::command]
fn create_local_file(dir: String, name: String) -> Result<(), String> {
    let p = std::path::Path::new(&dir).join(&name);
    if p.exists() {
        return Err(format!("已存在: {name}"));
    }
    std::fs::write(&p, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_local_dir(dir: String, name: String) -> Result<(), String> {
    let p = std::path::Path::new(&dir).join(&name);
    if p.exists() {
        return Err(format!("已存在: {name}"));
    }
    std::fs::create_dir(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_local(old_path: String, new_name: String) -> Result<(), String> {
    let p = std::path::Path::new(&old_path);
    let parent = p.parent().ok_or_else(|| "无法确定父目录".to_string())?;
    let np = parent.join(&new_name);
    if np.exists() {
        return Err(format!("已存在: {new_name}"));
    }
    std::fs::rename(p, &np).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| e.to_string())?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_local(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

/// 目标已存在时生成不覆盖的路径：file.txt → file (2).txt → file (3).txt …
fn unique_dest(dest: &std::path::Path) -> std::path::PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().unwrap_or_else(|| std::path::Path::new("."));
    let name = dest
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "copy".to_string());
    for i in 2.. {
        let candidate = parent.join(format!("{name} ({i})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let to = dst.join(entry.file_name());
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_dir() {
                copy_tree(&entry.path(), &to)?;
            } else {
                std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 复制到指定目录（重名自动加序号，不覆盖）
#[tauri::command]
fn copy_to(src: String, dest_dir: String) -> Result<String, String> {
    let src_p = std::path::Path::new(&src);
    if !src_p.exists() {
        return Err("源路径不存在".to_string());
    }
    let dir = std::path::Path::new(&dest_dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = src_p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let base = dir.join(&name);
    // 目录复制到自己内部会无限递归，禁止
    if src_p.is_dir() && base.starts_with(src_p) {
        return Err("目标不能位于源目录内部".to_string());
    }
    let dest = unique_dest(&base);
    copy_tree(src_p, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 移动到指定目录（重名自动加序号；跨磁盘自动复制后删除）
#[tauri::command]
fn move_to(src: String, dest_dir: String) -> Result<String, String> {
    let src_p = std::path::Path::new(&src);
    if !src_p.exists() {
        return Err("源路径不存在".to_string());
    }
    let dir = std::path::Path::new(&dest_dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = src_p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| "无法确定文件名".to_string())?;
    let base = dir.join(&name);
    if base == src_p {
        return Err("目标位置与原位置相同".to_string());
    }
    if src_p.is_dir() && base.starts_with(src_p) {
        return Err("目标不能位于源目录内部".to_string());
    }
    let dest = unique_dest(&base);
    if std::fs::rename(src_p, &dest).is_ok() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    // 跨设备/文件系统：复制后删除原位置
    copy_tree(src_p, &dest)?;
    if src_p.is_dir() {
        std::fs::remove_dir_all(src_p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(src_p).map_err(|e| e.to_string())?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<(), String> {    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!("win-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    WebviewWindowBuilder::new(&app, label, WebviewUrl::default())
        .title("0xEdit — 新窗口")
        .inner_size(1000.0, 720.0)
        .min_inner_size(700.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(FtpState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(SshState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(remote_term::TermState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            read_text_file_as,
            save_text_file,
            read_hex_range,
            write_hex_range,
            file_size,
            path_is_dir,
            home_dir,
            search_in_dir,
            replace_in_dir,
            open_terminal,
            ftp_connect,
            ftp_disconnect,
            ftp_list,
            ftp_cwd,
            ftp_upload,
            ftp_download,
            ftp_download_dir,
            ftp_mkdir,
            ftp_create_file,
            ftp_delete,
            sftp_connect,
            sftp_disconnect,
            sftp_list,
            sftp_download,
            sftp_download_dir,
            sftp_upload,
            sftp_mkdir,
            sftp_create_file,
            sftp_delete,
            sftp_rename,
            sftp_save_as,
            ftp_rename,
            ftp_save_as,
            ssh_generate_key,
            write_recovery,
            list_recovery,
            read_recovery,
            clear_recovery,
            compare_dirs,
            copy_file,
            text_page,
            text_write,
            new_window,
            archive_list,
            archive_read,
            archive_update,
            extract_archive_entry,
            create_local_file,
            create_local_dir,
            rename_local,
            delete_local,
            copy_to,
            move_to,
            write_binary_file,
            remote_term::open_remote_shell,
            remote_term::write_shell,
            remote_term::resize_shell,
            remote_term::close_shell,
        ])
        .setup(|app| {
            // 移除 Tauri 默认英文原生菜单，统一使用窗口内自绘菜单
            let _ = app.remove_menu();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}