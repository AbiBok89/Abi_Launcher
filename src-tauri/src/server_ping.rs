use crate::types::{ServerRef, ServerStatus};
use flate2::read::GzDecoder;
use regex::Regex;
use serde_json::Value;
use std::io::Read;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub fn is_allowed_20tps_host(host: &str) -> bool {
    let clean = host.trim().trim_end_matches('.');
    let lower = clean.to_ascii_lowercase();
    lower.ends_with(".20tps.ru") && lower.len() > ".20tps.ru".len()
}

pub fn parse_server_address_20tps(name: &str, addr: &str) -> Option<ServerRef> {
    let raw = addr.trim();
    if raw.is_empty() || raw.len() > 260 {
        return None;
    }
    let mut host = raw.to_string();
    let mut port = None;
    if let Some(idx) = raw.rfind(':') {
        if idx > 0 {
            if let Ok(p) = raw[idx + 1..].parse::<u16>() {
                if p >= 1 {
                    host = raw[..idx].to_string();
                    port = Some(p);
                }
            }
        }
    }
    let clean_host = host.trim().trim_end_matches('.');
    let host_re = Regex::new(r"^[A-Za-z0-9.-]{1,253}$").unwrap();
    if !host_re.is_match(clean_host) || !is_allowed_20tps_host(clean_host) {
        return None;
    }
    let display_name = if name.trim().is_empty() {
        "Сервер сборки"
    } else {
        name.trim()
    };
    Some(ServerRef {
        name: display_name.chars().take(80).collect(),
        host: clean_host.to_string(),
        port,
    })
}

struct NbtCursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> NbtCursor<'a> {
    fn read_u8(&mut self) -> Option<u8> {
        let b = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn read_u16(&mut self) -> Option<u16> {
        let slice = self.data.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_be_bytes([slice[0], slice[1]]))
    }

    fn read_i32(&mut self) -> Option<i32> {
        let slice = self.data.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(i32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos.checked_add(n)? > self.data.len() {
            return None;
        }
        self.pos += n;
        Some(())
    }

    fn read_string(&mut self) -> Option<String> {
        let len = self.read_u16()? as usize;
        let slice = self.data.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(String::from_utf8_lossy(slice).into_owned())
    }

    fn skip_payload(&mut self, tag_type: u8, depth: usize) -> Option<()> {
        if depth > 32 {
            return None;
        }
        match tag_type {
            0 => Some(()),
            1 => self.skip(1),
            2 => self.skip(2),
            3 | 5 => self.skip(4),
            4 | 6 => self.skip(8),
            7 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return None;
                }
                self.skip(len as usize)
            }
            8 => {
                let len = self.read_u16()? as usize;
                self.skip(len)
            }
            9 => {
                let elem_type = self.read_u8()?;
                let len = self.read_i32()?;
                if len < 0 || len > 100_000 {
                    return None;
                }
                for _ in 0..len {
                    self.skip_payload(elem_type, depth + 1)?;
                }
                Some(())
            }
            10 => loop {
                let inner_type = self.read_u8()?;
                if inner_type == 0 {
                    break Some(());
                }
                let name_len = self.read_u16()? as usize;
                self.skip(name_len)?;
                self.skip_payload(inner_type, depth + 1)?;
            },
            11 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return None;
                }
                self.skip((len as usize).checked_mul(4)?)
            }
            12 => {
                let len = self.read_i32()?;
                if len < 0 {
                    return None;
                }
                self.skip((len as usize).checked_mul(8)?)
            }
            _ => None,
        }
    }
}

pub fn extract_20tps_server_from_servers_dat(raw_bytes: &[u8]) -> Option<ServerRef> {
    if raw_bytes.is_empty() || raw_bytes.len() > 8 * 1024 * 1024 {
        return None;
    }
    let decoded_storage;
    let bytes: &[u8] = if raw_bytes.len() >= 2 && raw_bytes[0] == 0x1f && raw_bytes[1] == 0x8b {
        let mut gz = GzDecoder::new(raw_bytes);
        let mut out = Vec::new();
        gz.read_to_end(&mut out).ok()?;
        if out.len() > 8 * 1024 * 1024 {
            return None;
        }
        decoded_storage = out;
        &decoded_storage
    } else {
        raw_bytes
    };

    let mut cur = NbtCursor {
        data: bytes,
        pos: 0,
    };
    let root_type = cur.read_u8()?;
    if root_type != 10 {
        return None;
    }
    let _root_name = cur.read_string()?;

    loop {
        let tag_type = cur.read_u8()?;
        if tag_type == 0 {
            break;
        }
        let tag_name = cur.read_string()?;
        if tag_type == 9 && tag_name == "servers" {
            let elem_type = cur.read_u8()?;
            let count = cur.read_i32()?;
            if elem_type != 10 || count <= 0 || count > 500 {
                return None;
            }
            for _ in 0..count {
                let mut srv_name = String::new();
                let mut srv_ip = String::new();
                loop {
                    let ft = cur.read_u8()?;
                    if ft == 0 {
                        break;
                    }
                    let fname = cur.read_string()?;
                    if ft == 8 && fname == "name" {
                        srv_name = cur.read_string()?;
                    } else if ft == 8 && fname == "ip" {
                        srv_ip = cur.read_string()?;
                    } else {
                        cur.skip_payload(ft, 1)?;
                    }
                }
                if let Some(matched) = parse_server_address_20tps(&srv_name, &srv_ip) {
                    return Some(matched);
                }
            }
            return None;
        } else {
            cur.skip_payload(tag_type, 1)?;
        }
    }
    None
}

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
    let clean_host = host.trim().trim_end_matches('.');
    let host_re = Regex::new(r"^[A-Za-z0-9.-]{1,253}$").unwrap();
    if clean_host.is_empty() || !host_re.is_match(clean_host) {
        return offline_status("Некорректный адрес сервера");
    }
    if !is_allowed_20tps_host(clean_host) {
        return offline_status("Проверка доступна только для серверов *.20tps.ru");
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
