//! The native messaging protocol.
//!
//! Chrome frames every message as a 4-byte little-endian length followed by
//! one UTF-8 JSON object. The host never writes anything but frames to stdout;
//! diagnostics go to stderr.
//!
//! Requests carry a `requestId` that is echoed back, so a client can keep more
//! than one call in flight. `id` is reserved for document ids.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use nooksuite_library::library::Library;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::{self, Read, Write};
use std::path::Path;

pub const PROTOCOL_VERSION: u32 = 1;

/// Chrome caps messages *from* the host at 1 MB. A 512 KB raw chunk becomes
/// about 683 KB of base64, which leaves room for the record and the envelope.
pub const READ_CHUNK_BYTES: usize = 512 * 1024;

/// Chrome allows very large messages *to* the host, but a runaway client
/// should not make the host allocate without limit.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Ping,
    List,
    Import {
        name: String,
        #[serde(default, rename = "mediaType")]
        media_type: Option<String>,
        data: String,
    },
    Read {
        id: String,
        #[serde(default)]
        offset: u64,
        #[serde(default)]
        length: Option<u64>,
    },
    Rename {
        id: String,
        name: String,
    },
    Remove {
        id: String,
    },
}

#[derive(Debug)]
struct HostError {
    code: &'static str,
    message: String,
}

impl HostError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new("bad_request", message)
    }
}

impl From<String> for HostError {
    fn from(message: String) -> Self {
        // The library reports an unknown id as a sentence; everything else is
        // an I/O problem. Keep this in one place so responses stay consistent.
        let code = if message.starts_with("No document with id") {
            "not_found"
        } else {
            "io"
        };
        Self::new(code, message)
    }
}

impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self::bad_request(format!("Invalid request: {error}"))
    }
}

/// Read one frame. `Ok(None)` means the browser closed the pipe.
pub fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];

    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }

    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Message of {length} bytes exceeds the {MAX_MESSAGE_BYTES}-byte limit."),
        ));
    }

    let mut payload = vec![0u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

/// Write one frame and flush it. The host answers one request at a time, so
/// the flush keeps the browser from waiting on a buffered response.
pub fn write_message<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "The response is too large."))?;

    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

/// Handle one raw request and return the raw response.
///
/// A malformed frame still gets a response, so the client sees an error instead
/// of a silent hang. The library is opened per request, which picks up edits
/// made by NookEdit while the host is running.
pub fn handle_message(root: &Path, payload: &[u8]) -> Vec<u8> {
    let value: Value = match serde_json::from_slice(payload) {
        Ok(value) => value,
        Err(error) => {
            return encode(&error_response(
                Value::Null,
                "bad_request",
                format!("Invalid JSON: {error}"),
            ))
        }
    };

    let request_id = value.get("requestId").cloned().unwrap_or(Value::Null);

    match dispatch(root, value) {
        Ok(fields) => {
            let mut object = match fields {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            object.insert("requestId".to_string(), request_id);
            object.insert("ok".to_string(), Value::Bool(true));
            encode(&Value::Object(object))
        }
        Err(error) => encode(&error_response(request_id, error.code, error.message)),
    }
}

fn error_response(request_id: Value, code: &str, message: String) -> Value {
    json!({
        "requestId": request_id,
        "ok": false,
        "error": { "code": code, "message": message },
    })
}

fn encode(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_else(|_| b"{\"ok\":false}".to_vec())
}

fn dispatch(root: &Path, value: Value) -> Result<Value, HostError> {
    let request: Request = serde_json::from_value(value)?;

    match request {
        Request::Ping => {
            let library = Library::open_or_create(root)?;
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "hostVersion": env!("CARGO_PKG_VERSION"),
                "library": {
                    "root": library.root().display().to_string(),
                    "libraryId": library.file().library_id,
                    "recordCount": library.file().records.len(),
                },
            }))
        }
        Request::List => {
            let library = Library::open_or_create(root)?;
            let snapshot = library.snapshot();
            Ok(json!({
                "root": snapshot.root,
                "libraryId": snapshot.library_id,
                "records": snapshot.records,
            }))
        }
        Request::Import {
            name,
            media_type,
            data,
        } => {
            let bytes = STANDARD.decode(data.as_bytes()).map_err(|error| {
                HostError::bad_request(format!("The file data is not valid base64: {error}"))
            })?;

            let mut library = Library::open_or_create(root)?;
            let record = library.import_bytes(&name, media_type.as_deref(), &bytes)?;
            Ok(json!({ "record": record }))
        }
        Request::Read { id, offset, length } => {
            let library = Library::open_or_create(root)?;
            let record = library.record(&id)?;
            let limit = length
                .unwrap_or(READ_CHUNK_BYTES as u64)
                .clamp(1, READ_CHUNK_BYTES as u64) as usize;
            let bytes = library.read_range(&id, offset, limit)?;
            let next_offset = offset.saturating_add(bytes.len() as u64);

            Ok(json!({
                "record": record,
                "data": STANDARD.encode(&bytes),
                "offset": offset,
                "nextOffset": next_offset,
                "eof": next_offset >= record.size,
            }))
        }
        Request::Rename { id, name } => {
            let mut library = Library::open_or_create(root)?;
            let record = library.rename(&id, &name)?;
            Ok(json!({ "record": record }))
        }
        Request::Remove { id } => {
            let mut library = Library::open_or_create(root)?;
            library.remove(&id)?;
            Ok(json!({}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nooksuite-host-{label}-{}-{serial}",
            std::process::id()
        ))
    }

    fn call(root: &Path, request: Value) -> Value {
        let payload = serde_json::to_vec(&request).unwrap();
        serde_json::from_slice(&handle_message(root, &payload)).unwrap()
    }

    #[test]
    fn frames_round_trip_and_end_cleanly() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, b"{\"op\":\"ping\"}").unwrap();
        assert_eq!(&buffer[..4], &13u32.to_le_bytes());

        let mut cursor = Cursor::new(buffer);
        assert_eq!(
            read_message(&mut cursor).unwrap().unwrap(),
            b"{\"op\":\"ping\"}"
        );
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn empty_input_is_a_clean_exit() {
        let mut empty: &[u8] = &[];
        assert!(read_message(&mut empty).unwrap().is_none());
    }

    #[test]
    fn oversized_frames_are_rejected() {
        let mut cursor = Cursor::new(((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes().to_vec());
        let error = read_message(&mut cursor).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn ping_reports_the_library_and_creates_it() {
        let root = temp_root("ping");

        let response = call(&root, json!({ "requestId": 7, "op": "ping" }));

        assert_eq!(response["requestId"], 7);
        assert_eq!(response["ok"], true);
        assert_eq!(response["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["library"]["recordCount"], 0);
        assert!(root.join(".nooksuite").join("library.json").is_file());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn imports_reads_in_chunks_renames_and_removes() {
        let root = temp_root("crud");
        let payload: Vec<u8> = (0..(READ_CHUNK_BYTES + 321))
            .map(|index| (index % 251) as u8)
            .collect();

        let imported = call(
            &root,
            json!({
                "requestId": 1,
                "op": "import",
                "name": "wire.bin",
                "mediaType": "application/octet-stream",
                "data": STANDARD.encode(&payload),
            }),
        );
        assert_eq!(imported["ok"], true, "{imported}");
        let id = imported["record"]["id"].as_str().unwrap().to_string();
        assert_eq!(imported["record"]["size"], payload.len() as u64);

        let listed = call(&root, json!({ "requestId": 2, "op": "list" }));
        assert_eq!(listed["records"].as_array().unwrap().len(), 1);
        assert_eq!(listed["records"][0]["name"], "wire.bin");

        let first = call(
            &root,
            json!({ "requestId": 3, "op": "read", "id": id, "offset": 0 }),
        );
        assert_eq!(first["ok"], true);
        assert_eq!(first["eof"], false);
        assert_eq!(
            STANDARD
                .decode(first["data"].as_str().unwrap())
                .unwrap()
                .len(),
            READ_CHUNK_BYTES
        );

        let mut bytes = STANDARD.decode(first["data"].as_str().unwrap()).unwrap();
        let mut offset = first["nextOffset"].as_u64().unwrap();

        while offset < payload.len() as u64 {
            let chunk = call(
                &root,
                json!({ "requestId": 4, "op": "read", "id": id, "offset": offset }),
            );
            assert_eq!(chunk["ok"], true, "{chunk}");
            bytes.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
            offset = chunk["nextOffset"].as_u64().unwrap();
            assert!(chunk["eof"].as_bool().unwrap() || offset < payload.len() as u64);
        }

        assert_eq!(bytes, payload);

        // At the end, a read is empty and finished.
        let end = call(
            &root,
            json!({ "requestId": 5, "op": "read", "id": id, "offset": payload.len() as u64 }),
        );
        assert_eq!(end["eof"], true);
        assert_eq!(end["data"], "");

        let renamed = call(
            &root,
            json!({ "requestId": 6, "op": "rename", "id": id, "name": "renamed.bin" }),
        );
        assert_eq!(renamed["record"]["name"], "renamed.bin");
        assert!(root
            .join("documents")
            .join(&id)
            .join("renamed.bin")
            .is_file());

        let removed = call(&root, json!({ "requestId": 7, "op": "remove", "id": id }));
        assert_eq!(removed["ok"], true);
        assert!(!root.join("documents").join(&id).exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reports_unknown_ids_and_bad_requests() {
        let root = temp_root("errors");

        let missing = call(
            &root,
            json!({ "requestId": "a", "op": "read", "id": "doc_missing000" }),
        );
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["error"]["code"], "not_found");

        let unknown_op = call(&root, json!({ "requestId": "b", "op": "nope" }));
        assert_eq!(unknown_op["ok"], false);
        assert_eq!(unknown_op["error"]["code"], "bad_request");

        let invalid: Value = serde_json::from_slice(&handle_message(&root, b"not json")).unwrap();
        assert_eq!(invalid["ok"], false);
        assert_eq!(invalid["error"]["code"], "bad_request");

        fs::remove_dir_all(&root).unwrap();
    }
}
