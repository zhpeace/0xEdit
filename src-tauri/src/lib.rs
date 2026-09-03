#![cfg_attr(mobile, tauri::mobile_entry_point)]

use serde::{Serialize, Deserialize};
use std::fs;
use std::path::Path;
use std::collections::HashMap;
use std::sync::Mutex;
use std::io::Write;
use ftp::FtpStream;
use encoding_rs::{GBK, BIG5, SHIFT_JIS, WINDOWS_1252};

const TEXT_READ_LIMIT: usize = 20 * 1024 * 1024;
const BINARY_SNIFF: usize = 8192;

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let p = entry.path();
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let size = if ft.is_file() { fs::metadata(&p).map(|m| m.len()).unwrap_or(0) } else { 0 };
        out.push(DirEntry {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
            size,
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
        Err(_) => Detected::Binary,
    }
}

fn looks_binary_bytes(raw: &[u8]) -> bool {
    let end = raw.len().min(BINARY_SNIFF);
    raw[..end].contains(&0)
}

fn decode_cjk(raw: &[u8]) -> Option<(String, &'static str)> {
    let candidates: [(&'static str, &'static encoding_rs::Encoding); 4] = [
        ("gbk", GBK),
        ("big5", BIG5),
        ("shift_jis", SHIFT_JIS),
        ("windows-1252", WINDOWS_1252),
    ];
    let mut best: Option<(String, &'static str, usize)> = None;
    for (label, enc) in candidates {
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
    best.map(|(t, l, e)| {
        if e >= 32 { None } else { Some((t, l)) }
    }).flatten()
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

pub struct FtpState(pub Mutex<HashMap<String, FtpStream>>);
pub struct SshState(pub Mutex<HashMap<String, ssh2::Session>>);

#[tauri::command]
fn ftp_connect(host: String, port: u16, username: String, password: String, state: tauri::State<FtpState>) -> Result<String, String> {
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
fn ftp_disconnect(id: String, state: tauri::State<FtpState>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut ftp) = map.remove(&id) {
        let _ = ftp.quit();
    }
    Ok(())
}

fn with_ftp<F, R>(id: &str, state: &tauri::State<FtpState>, f: F) -> Result<R, String>
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
}

#[derive(Serialize)]
struct FtpListResult {
    pwd: String,
    entries: Vec<FtpEntry>,
}

#[tauri::command]
fn ftp_list(id: String, state: tauri::State<FtpState>) -> Result<FtpListResult, String> {
    with_ftp(&id, &state, |ftp| {
        let pwd = ftp.pwd()?;
        let raw = ftp.list(None)?;
        let mut out = Vec::new();
        for line in raw {
            let trimmed = line.trim_start();
            if trimmed.is_empty() {
                continue;
            }
            let is_link = trimmed.starts_with('l');
            if !trimmed.starts_with('d') && !is_link && !trimmed.starts_with('-') {
                continue;
            }
            let fields: Vec<&str> = trimmed.split_whitespace().collect();
            if fields.len() < 9 {
                continue;
            }
let name = fields[8..].join(" ");
                    if name.is_empty() || name == "." || name == ".." || name.starts_with('.') {
                        continue;
                    }
                    let is_dir = trimmed.starts_with('d');
                    let size = if is_dir { 0 } else { fields[4].parse::<u64>().unwrap_or(0) };
                    out.push(FtpEntry {
                        name,
                        is_dir: is_dir || is_link,
                        size,
                    });
                }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(FtpListResult { pwd, entries: out })
    })
}

#[tauri::command]
fn ftp_cwd(id: String, path: String, state: tauri::State<FtpState>) -> Result<String, String> {
    with_ftp(&id, &state, |ftp| {
        if path == ".." {
            ftp.cdup()?;
        } else {
            ftp.cwd(&path)?;
        }
        ftp.pwd()
    })
}

#[tauri::command]
fn ftp_upload(id: String, local_path: String, state: tauri::State<FtpState>) -> Result<String, String> {
    with_ftp(&id, &state, |ftp| {
        let name = Path::new(&local_path).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut file = fs::File::open(&local_path).map_err(|e| ftp::FtpError::InvalidResponse(format!("本地文件: {e}")))?;
        let pwd = ftp.pwd()?;
        ftp.put(&name, &mut file)?;
        Ok(pwd)
    })
}

#[tauri::command]
fn ftp_download(id: String, remote_name: String, state: tauri::State<FtpState>) -> Result<String, String> {
    with_ftp(&id, &state, |ftp| {
        let tmp = std::env::temp_dir().join(format!("uec_ftp_{}_{}", remote_name, std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        let mut file = fs::File::create(&tmp).map_err(|e| ftp::FtpError::ConnectionError(e))?;
        let file_cell = std::cell::RefCell::new(&mut file);
        ftp.retr(&remote_name, |reader| {
            std::io::copy(reader, &mut *file_cell.borrow_mut())
                .map(|_| ())
                .map_err(|e| ftp::FtpError::ConnectionError(e))
        })?;
        Ok(tmp.to_string_lossy().to_string())
    })
}

#[tauri::command]
fn ftp_delete(id: String, name: String, is_dir: bool, state: tauri::State<FtpState>) -> Result<(), String> {
    with_ftp(&id, &state, |ftp| {
        if is_dir {
            ftp.rmdir(&name)
        } else {
            ftp.rm(&name)
        }
    })
}

#[tauri::command]
fn ftp_mkdir(id: String, name: String, state: tauri::State<FtpState>) -> Result<(), String> {
    with_ftp(&id, &state, |ftp| ftp.mkdir(&name))
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

fn with_ssh<F, R>(id: &str, state: &tauri::State<SshState>, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ssh2::Session) -> Result<R, String>,
{
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let ses = map.get_mut(id).ok_or_else(|| "未连接 SSH".to_string())?;
    f(ses)
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
    state: tauri::State<SshState>,
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
fn sftp_disconnect(id: String, state: tauri::State<SshState>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[tauri::command]
fn sftp_list(id: String, path: String, state: tauri::State<SshState>) -> Result<FtpListResult, String> {
    with_ssh(&id, &state, |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let entries = sftp.readdir(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (p, stat) in entries {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            out.push(FtpEntry {
                name,
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0),
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(FtpListResult { pwd: path, entries: out })
    })
}

#[tauri::command]
fn sftp_download(id: String, remote_path: String, state: tauri::State<SshState>) -> Result<String, String> {
    with_ssh(&id, &state, |ses| {
        let name = std::path::Path::new(&remote_path).file_name()
            .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let tmp = std::env::temp_dir().join(format!("uec_sftp_{}_{}", name, std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let mut remote = sftp.open(std::path::Path::new(&remote_path)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut remote, &mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, buf).map_err(|e| e.to_string())?;
        Ok(tmp.to_string_lossy().to_string())
    })
}

#[tauri::command]
fn sftp_upload(id: String, local_path: String, remote_path: String, state: tauri::State<SshState>) -> Result<(), String> {
    with_ssh(&id, &state, |ses| {
        let data = std::fs::read(&local_path).map_err(|e| e.to_string())?;
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let mut remote = sftp.create(std::path::Path::new(&remote_path)).map_err(|e| e.to_string())?;
        remote.write_all(&data).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
fn sftp_mkdir(id: String, path: String, state: tauri::State<SshState>) -> Result<(), String> {
    with_ssh(&id, &state, |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        sftp.mkdir(std::path::Path::new(&path), 0o755).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn sftp_delete(id: String, path: String, is_dir: bool, state: tauri::State<SshState>) -> Result<(), String> {
    with_ssh(&id, &state, |ses| {
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
fn sftp_rename(id: String, old_path: String, new_name: String, state: tauri::State<SshState>) -> Result<(), String> {
    with_ssh(&id, &state, |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let parent = std::path::Path::new(&old_path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/"));
        let new_path = parent.join(&new_name);
        sftp.rename(std::path::Path::new(&old_path), &new_path, None).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn ftp_rename(id: String, old_name: String, new_name: String, state: tauri::State<FtpState>) -> Result<(), String> {
    with_ftp(&id, &state, |ftp| {
        ftp.rename(&old_name, &new_name).map_err(|e| ftp::FtpError::InvalidResponse(format!("重命名失败: {e}")))
    })
}

#[tauri::command]
fn sftp_save_as(id: String, remote_path: String, local_path: String, state: tauri::State<SshState>) -> Result<(), String> {
    with_ssh(&id, &state, |ses| {
        let sftp = ses.sftp().map_err(|e| e.to_string())?;
        let mut remote = sftp.open(std::path::Path::new(&remote_path)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut remote, &mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&local_path, buf).map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn ftp_save_as(id: String, remote_name: String, local_path: String, state: tauri::State<FtpState>) -> Result<(), String> {
    with_ftp(&id, &state, |ftp| {
        let mut reader = ftp.get(&remote_name)?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut buf).map_err(ftp::FtpError::ConnectionError)?;
        std::fs::write(&local_path, buf).map_err(ftp::FtpError::ConnectionError)
    })
}

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
}

#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
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
        .manage(FtpState(Mutex::new(HashMap::new())))
        .manage(SshState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
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
            ftp_mkdir,
            ftp_delete,
            sftp_connect,
            sftp_disconnect,
            sftp_list,
            sftp_download,
            sftp_upload,
            sftp_mkdir,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}