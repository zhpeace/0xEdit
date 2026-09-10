// 远程终端：SSH PTY + 事件推流。每个终端独立连接，复用账户凭据。
// ssh2 0.9 通道读取为阻塞式，读线程独占通道；写/缩放/关闭经 mpsc 排队由读线程消费，
// 保证通道不并发、写不卡死（静默时段命令延迟到下一次输出，属 SSH 阻塞读的固有限制）。
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct TermState(pub Mutex<HashMap<String, TermSession>>);

pub struct TermSession {
    tx: mpsc::Sender<TermCmd>,
    host: String,
    handle: Option<std::thread::JoinHandle<()>>,
}

enum TermCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Clone, Serialize)]
struct TermOut {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExit {
    id: String,
    reason: String,
}

fn connect_ssh(
    host: &str, port: u16, username: &str, password: &str,
    key_path: Option<&str>, passphrase: Option<&str>,
) -> Result<ssh2::Session, String> {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let addr: SocketAddr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS 解析失败: {e}"))?
        .next()
        .ok_or_else(|| "无法解析主机".to_string())?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(12)).map_err(|e| format!("连接失败(超时/拒绝): {e}"))?;
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
    let mut ses = ssh2::Session::new().map_err(|e| format!("会话失败: {e}"))?;
    ses.set_tcp_stream(tcp);
    retry_ssh(|| ses.handshake(), "握手失败", 15000)?;
    if let Some(key) = key_path.filter(|k| !k.is_empty()) {
        retry_ssh(
            || ses.userauth_pubkey_file(username, None, std::path::Path::new(key), passphrase),
            "密钥认证失败",
            10000,
        )?;
    } else {
        struct PassPrompter(String);
        impl ssh2::KeyboardInteractivePrompt for PassPrompter {
            fn prompt<'a>(&mut self, _username: &str, _instructions: &str, prompts: &[ssh2::Prompt<'a>]) -> Vec<String> {
                prompts.iter().map(|_| self.0.clone()).collect()
            }
        }
        if !password.is_empty() {
            let pw = password.to_string();
            let pw_ok = retry_ssh(|| ses.userauth_password(username, &pw), "密码认证失败", 10000).is_ok();
            if !pw_ok {
                let mut p = PassPrompter(pw);
                retry_ssh(|| ses.userauth_keyboard_interactive(username, &mut p), "密码认证失败", 10000)?;
            }
        } else {
            let mut p = PassPrompter(String::new());
            retry_ssh(|| ses.userauth_keyboard_interactive(username, &mut p), "认证失败", 10000)?;
        }
    }
    if !ses.authenticated() {
        return Err("认证失败（服务器拒绝了所有凭据）".into());
    }
    // 认证完成后切到 libssh2 非阻塞模式：channel.read 无数据时立即返回
    // LIBSSH2_ERROR_EAGAIN（WouldBlock），读线程得以轮询处理输入命令队列。
    ses.set_blocking(false);
    Ok(ses)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 判断 ssh2 错误是否为 EAGAIN（非阻塞模式与 ed25519 认证首次调用均可能出现）
fn is_again(e: &ssh2::Error) -> bool {
    let m = e.message();
    m.contains("Would block") || m.contains("EAGAIN")
}

fn is_again_io(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
        || e.kind() == std::io::ErrorKind::TimedOut
        || e.to_string().contains("EAGAIN")
}

/// 对可能返回 EAGAIN 的 ssh2 调用做有界重试（libssh2 非阻塞语义）
fn retry_ssh<T>(
    mut f: impl FnMut() -> Result<T, ssh2::Error>,
    label: &str,
    timeout_ms: u64,
) -> Result<T, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if is_again(&e) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(format!("{label}: {e}")),
        }
    }
}

#[tauri::command]
pub fn open_remote_shell(
    key: String, host: String, port: u16, username: String, password: String,
    key_path: Option<String>, passphrase: Option<String>, initial_dir: Option<String>,
    state: State<TermState>, app: AppHandle,
) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("无效的终端标识".into());
    }
    let ses = connect_ssh(&host, port, &username, &password, key_path.as_deref(), passphrase.as_deref())?;
    // 认证后 session 已切非阻塞：以下调用可能返回 EAGAIN，逐一有界重试
    let mut chan = retry_ssh(|| ses.channel_session(), "打开通道失败", 8000)?;
    retry_ssh(|| chan.request_pty("xterm", Some(ssh2::PtyModes::new()), None), "请求 PTY 失败", 8000)?;
    retry_ssh(|| chan.shell(), "启动 shell 失败", 8000)?;
    if let Some(dir) = initial_dir.filter(|d| !d.is_empty()) {
        let cmd = format!("cd {}\n", shell_quote(&dir));
        let mut rest = cmd.as_bytes();
        while !rest.is_empty() {
            match chan.write(rest) {
                Ok(0) => break,
                Ok(n) => rest = &rest[n..],
                Err(e) if is_again_io(&e) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break,
            }
        }
        let _ = chan.flush();
    }
    let id = key;
    let (tx, rx) = mpsc::channel::<TermCmd>();
    let app2 = app.clone();
    let id2 = id.clone();
    let handle = std::thread::spawn(move || {
        let mut chan = chan;
        let mut closed = false;
        loop {
            // 先消费待发送命令（输入/缩放/关闭）
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    TermCmd::Data(d) => {
                        log_term(&format!("DATA_RECV len={} head={:?}", d.len(), String::from_utf8_lossy(&d[..d.len().min(16)])));
                        let mut rest = &d[..];
                        let mut tries = 0;
                        while !rest.is_empty() && tries < 200 {
                            match chan.write(rest) {
                                Ok(0) => { log_term("WRITE ZERO"); break; }
                                Ok(n) => { log_term(&format!("WRITE n={} remain={}", n, rest.len() - n)); rest = &rest[n..]; }
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    tries += 1;
                                    if tries == 1 || tries % 50 == 0 { log_term(&format!("WRITE BLOCK tries={}", tries)); }
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                                Err(e) => { log_term(&format!("WRITE ERR {}", e)); break; }
                            }
                        }
                        tries = 0;
                        loop {
                            match chan.flush() {
                                Ok(()) => break,
                                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && tries < 200 => {
                                    tries += 1;
                                    if tries == 1 || tries % 50 == 0 { log_term(&format!("FLUSH BLOCK tries={}", tries)); }
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                                Err(e) => { log_term(&format!("FLUSH ERR {}", e)); break; }
                            }
                        }
                        log_term("DATA DONE");
                    }
                    TermCmd::Resize(cols, rows) => {
                        let _ = chan.request_pty_size(cols, rows, None, None);
                    }
                    TermCmd::Close => {
                        let _ = chan.send_eof();
                        let _ = chan.wait_close();
                        closed = true;
                        break;
                    }
                }
            }
            if closed {
                let _ = app2.emit("term-exit", TermExit { id: id2.clone(), reason: "连接已关闭".to_string() });
                return;
            }
            let mut buf = [0u8; 16384];
            match chan.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    log_term(&format!("TERM_OUT n={} head={:?}", n, s.chars().take(32).collect::<String>()));
                    let _ = app2.emit("term-out", TermOut { id: id2.clone(), data: s });
                }
                Err(e) => {
                    // socket 读超时（80ms）与 EAGAIN 属轮询节拍：回到循环顶处理输入队列
                    let k = e.kind();
                    if k == std::io::ErrorKind::TimedOut || k == std::io::ErrorKind::WouldBlock {
                        continue;
                    }
                    break;
                }
            }
        }
        let _ = app2.emit("term-exit", TermExit { id: id2.clone(), reason: "连接已关闭".to_string() });
    });
    state.0.lock().map_err(|e| e.to_string())?.insert(id.clone(), TermSession {
        tx,
        host,
        handle: Some(handle),
    });
    Ok(id)
}

// 诊断日志：/tmp/0xedit-term.log（排查终端输入问题时启用，后续可移除）
fn log_term(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/0xedit-term.log") {
        let _ = writeln!(f, "[{}] {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), msg);
    }
}

#[tauri::command]
pub fn write_shell(id: String, data: String, state: State<TermState>) -> Result<(), String> {
    log_term(&format!("write_shell id={} len={} data={:?}", id, data.len(), data.chars().take(16).collect::<String>()));
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let t = map.get(&id).ok_or_else(|| {
        log_term(&format!("write_shell MISS id={}", id));
        "终端不存在".to_string()
    })?;
    let bytes = data.into_bytes();
    let n = bytes.len();
    t.tx.send(TermCmd::Data(bytes)).map_err(|e| {
        log_term(&format!("write_shell SEND_ERR id={} err={}", id, e));
        e.to_string()
    })?;
    log_term(&format!("write_shell OK id={} n={}", id, n));
    Ok(())
}

#[tauri::command]
pub fn resize_shell(id: String, cols: u32, rows: u32, state: State<TermState>) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let t = map.get(&id).ok_or_else(|| "终端不存在".to_string())?;
    t.tx.send(TermCmd::Resize(cols, rows)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_shell(id: String, state: State<TermState>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(t) = map.remove(&id) {
        let _ = t.tx.send(TermCmd::Close);
        // 不 join：读线程可能阻塞在 ssh2 read，待其下一次读返回后消费 Close 并退出
    }
    Ok(())
}
