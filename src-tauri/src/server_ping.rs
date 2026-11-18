use crate::types::ServerStatus;
use regex::Regex;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn write_varint(out: &mut Vec<u8>, mut value: i32) {
    let mut v = value as u32;
    loop {
        let mut temp = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            temp |= 0x80;
        }
        out.push(temp);
        if v == 0 {
            break;
        }
    }
    let _ = &mut value;
}

fn read_varint(buf: &[u8], offset: usize) -> Result<Option<(i32, usize)>, &'static str> {
    let mut num_read = 0usize;
    let mut result = 0i32;
    loop {
        if offset + num_read >= buf.len() {
            return Ok(None);
        }
        let read = buf[offset + num_read];
        result |= ((read & 0x7f) as i32) << (7 * num_read);
        num_read += 1;
        if num_read > 5 {
            return Err("Некорректный VarInt в ответе сервера");
        }
        if (read & 0x80) == 0 {
            break;
        }
    }
    Ok(Some((result, num_read)))
}

fn build_handshake_and_request(host: &str, port: u16) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(0x00);
    write_varint(&mut payload, -1);
    let host_bytes = host.as_bytes();
    write_varint(&mut payload, host_bytes.len() as i32);
    payload.extend_from_slice(host_bytes);
    payload.extend_from_slice(&port.to_be_bytes());
    payload.push(0x01);

    let mut packet = Vec::new();
    write_varint(&mut packet, payload.len() as i32);
    packet.extend_from_slice(&payload);
    packet.extend_from_slice(&[0x01, 0x00]);
    packet
}

fn strip_color_codes(text: &str) -> String {
    let re = Regex::new(r"(?i)§[0-9a-fklmnorx]").unwrap();
    let stripped = re.replace_all(text, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_plain_description(val: &Value, depth: usize) -> String {
    if depth > 8 {
        return String::new();
    }
    match val {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(|x| extract_plain_description(x, depth + 1))
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(map) => {
            let mut out = if let Some(Value::String(t)) = map.get("text") {
                t.clone()
            } else if let Some(Value::String(t)) = map.get("translate") {
                t.clone()
            } else {
                String::new()
            };
            if let Some(Value::Array(extra)) = map.get("extra") {
                for item in extra {
                    out.push_str(&extract_plain_description(item, depth + 1));
                }
            }
            out
        }
        _ => String::new(),
    }
}

fn offline_status(error: impl Into<String>) -> ServerStatus {
    ServerStatus {
        online: false,
        players_online: None,
        players_max: None,
        version: None,
        motd: None,
        latency_ms: None,
        error: Some(error.into()),
    }
}

#[cfg(windows)]
async fn resolve_minecraft_srv(host: &str) -> Option<(String, u16)> {
    let name = format!("_minecraft._tcp.{host}");
    tokio::task::spawn_blocking(move || unsafe {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::NetworkManagement::Dns::{
            DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA,
            DNS_RECORDW, DNS_TYPE_SRV,
        };
        let wide: Vec<u16> = OsStr::new(&name).encode_wide().chain(Some(0)).collect();
        let mut ptr: *mut DNS_RECORDW = std::ptr::null_mut();
        let status = DnsQuery_W(
            wide.as_ptr(),
            DNS_TYPE_SRV as u16,
            DNS_QUERY_STANDARD,
            std::ptr::null_mut(),
            &mut ptr as *mut *mut DNS_RECORDW as *mut *mut DNS_RECORDA,
            std::ptr::null_mut(),
        );
        if status != 0 || ptr.is_null() {
            return None;
        }
        let mut cur = ptr;
        let mut result: Option<(String, u16)> = None;
        while !cur.is_null() {
            let rec = &*cur;
            if rec.wType == DNS_TYPE_SRV as u16 {
                let srv = rec.Data.Srv;
                if !srv.pNameTarget.is_null() {
                    let mut len = 0usize;
                    while *srv.pNameTarget.add(len) != 0 {
                        len += 1;
                    }
                    let slice = std::slice::from_raw_parts(srv.pNameTarget, len);
                    let target = String::from_utf16_lossy(slice).trim_end_matches('.').to_string();
                    if !target.is_empty() && srv.wPort > 0 {
                        result = Some((target, srv.wPort));
                        break;
                    }
                }
            }
            cur = rec.pNext;
        }
        DnsFree(ptr as *const core::ffi::c_void, DnsFreeRecordList);
        result
    })
    .await
    .ok()
    .flatten()
}

#[cfg(not(windows))]
async fn resolve_minecraft_srv(_host: &str) -> Option<(String, u16)> {
    None
}

pub async fn ping_minecraft_server(
    host: &str,
    port: Option<u16>,
    timeout_ms: u64,
) -> ServerStatus {
    let clean_host = host.trim();
    let host_re = Regex::new(r"^[A-Za-z0-9.-]{1,253}$").unwrap();
    if clean_host.is_empty() || !host_re.is_match(clean_host) {
        return offline_status("Некорректный адрес сервера");
    }

    let mut target_host = clean_host.to_string();
    let mut target_port = port.unwrap_or(25565);

    if port.is_none() {
        if let Some((srv_host, srv_port)) = resolve_minecraft_srv(clean_host).await {
            target_host = srv_host;
            target_port = srv_port;
        }
    }

    let fut = async {
        let start = Instant::now();
        let mut stream = TcpStream::connect((target_host.as_str(), target_port))
            .await
            .map_err(|e| e.to_string())?;
        let latency = start.elapsed().as_millis() as u64;

        let req = build_handshake_and_request(clean_host, target_port);
        stream.write_all(&req).await.map_err(|e| e.to_string())?;

        let mut buf = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        const MAX_RESPONSE_BYTES: usize = 512 * 1024;

        loop {
            let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Сервер закрыл соединение до отправки ответа".to_string());
            }
            if buf.len() + n > MAX_RESPONSE_BYTES {
                return Err("Слишком большой ответ сервера".to_string());
            }
            buf.extend_from_slice(&chunk[..n]);

            let packet_len = match read_varint(&buf, 0).map_err(|s| s.to_string())? {
                Some(v) => v,
                None => continue,
            };
            if packet_len.0 < 0 || buf.len() < packet_len.1 + packet_len.0 as usize {
                continue;
            }
            let mut offset = packet_len.1;
            let packet_id = match read_varint(&buf, offset).map_err(|s| s.to_string())? {
                Some(v) => v,
                None => continue,
            };
            offset += packet_id.1;
            if packet_id.0 != 0x00 {
                return Err(format!("Неожиданный код пакета: {}", packet_id.0));
            }
            let json_len = match read_varint(&buf, offset).map_err(|s| s.to_string())? {
                Some(v) => v,
                None => continue,
            };
            offset += json_len.1;
            if json_len.0 < 0 || buf.len() < offset + json_len.0 as usize {
                continue;
            }
            let json_str = std::str::from_utf8(&buf[offset..offset + json_len.0 as usize])
                .map_err(|e| format!("Некорректный JSON от сервера: {e}"))?;
            let parsed: Value = serde_json::from_str(json_str)
                .map_err(|e| format!("Некорректный ответ сервера: {e}"))?;

            let motd = parsed
                .get("description")
                .map(|d| strip_color_codes(&extract_plain_description(d, 0)))
                .filter(|s| !s.is_empty());
            let version = parsed
                .pointer("/version/name")
                .and_then(|v| v.as_str())
                .map(strip_color_codes)
                .filter(|s| !s.is_empty());
            let players_online = parsed
                .pointer("/players/online")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let players_max = parsed
                .pointer("/players/max")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);

            return Ok(ServerStatus {
                online: true,
                players_online,
                players_max,
                version,
                motd,
                latency_ms: Some(latency),
                error: None,
            });
        }
    };

    match tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await {
        Ok(Ok(st)) => st,
        Ok(Err(msg)) => offline_status(msg),
        Err(_) => offline_status(format!("Таймаут ответа сервера ({timeout_ms} мс)")),
    }
}
