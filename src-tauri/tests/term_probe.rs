// 远程终端链路探针：连接本地临时 sshd（127.0.0.1:2222，密钥 /tmp/termtest/userkey）
// 完整复刻生产 remote_term.rs 流程：阻塞握手/认证（EAGAIN 重试）→ set_blocking(false)
// → 非阻塞 channel/pty/shell（EAGAIN 重试）→ 写输入 → 轮询读回显。
// 运行：UEC_TERM_PROBE=1 cargo test --release -- --ignored term_probe --nocapture
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn msg_again(m: &str) -> bool {
    m.contains("Would block") || m.contains("EAGAIN")
}
fn is_again(e: &ssh2::Error) -> bool {
    msg_again(&e.message())
}
fn is_again_io(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock
        || e.kind() == std::io::ErrorKind::TimedOut
        || e.to_string().contains("EAGAIN")
}
fn retry_ssh<T>(
    mut f: impl FnMut() -> Result<T, ssh2::Error>,
    label: &str,
    timeout_ms: u64,
) -> Result<T, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if is_again(&e) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("{label}: {e}")),
        }
    }
}

#[test]
#[ignore]
fn term_probe_pty_echo() {
    if std::env::var("UEC_TERM_PROBE").is_err() {
        eprintln!("需要 UEC_TERM_PROBE=1");
        return;
    }
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    let addr: SocketAddr = ("127.0.0.1", 2222u16).to_socket_addrs().unwrap().next().unwrap();
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    tcp.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut ses = ssh2::Session::new().unwrap();
    ses.set_tcp_stream(tcp);
    retry_ssh(|| ses.handshake(), "握手", 10000).unwrap();
    retry_ssh(
        || ses.userauth_pubkey_file("hp", None, std::path::Path::new("/tmp/termtest/userkey"), None),
        "认证",
        10000,
    )
    .unwrap();
    assert!(ses.authenticated(), "认证失败");
    ses.set_blocking(false);

    let mut chan = retry_ssh(|| ses.channel_session(), "通道", 8000).unwrap();
    retry_ssh(|| chan.request_pty("xterm", Some(ssh2::PtyModes::new()), None), "pty", 8000).unwrap();
    retry_ssh(|| chan.shell(), "shell", 8000).unwrap();

    // 发送输入
    let mut rest: &[u8] = b"echo TERM_PROBE_7F3A\n";
    let wdead = Instant::now() + Duration::from_secs(5);
    while !rest.is_empty() {
        match chan.write(rest) {
            Ok(0) => break,
            Ok(n) => rest = &rest[n..],
            Err(e) if is_again_io(&e) && Instant::now() < wdead => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => panic!("写失败: {e}"),
        }
    }

    // 非阻塞轮询读取，直到命中探测串
    let mut all = String::new();
    let mut buf = [0u8; 8192];
    let pdead = Instant::now() + Duration::from_secs(8);
    while Instant::now() < pdead {
        match chan.read(&mut buf) {
            Ok(0) => {
                eprintln!("EOF");
                break;
            }
            Ok(n) => {
                let s = String::from_utf8_lossy(&buf[..n]).to_string();
                eprint!("{s}");
                all.push_str(&s);
                if all.contains("TERM_PROBE_7F3A") {
                    eprintln!("\n[PASS] 输入链路可用，回显命中");
                    return;
                }
            }
            Err(e) if is_again_io(&e) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("读失败: {e}"),
        }
    }
    panic!("[FAIL] 未在超时内收到回显。已收集: {all:?}");
}
