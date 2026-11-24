//! The on-disk library, format v1.
//!
//! This is the native side of `docs/library-format.md` and must stay in sync
//! with `packages/core/src/library/`. The shared fixture
//! `packages/core/tests/fixtures/library-v1.json` is parsed by tests on both
//! sides so the two implementations cannot drift apart unnoticed.
//!
//! A library is `<root>/.nooksuite/library.json` plus one folder per document
//! under `<root>/documents/<id>/`. The index is written with a temp-then-rename
//! so a reader never sees a partial file.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SCHEMA_VERSION: u32 = 1;
pub const LIBRARY_DIR: &str = ".nooksuite";
pub const LIBRARY_FILE: &str = "library.json";
pub const DOCUMENTS_DIR: &str = "documents";
pub const MAX_NAME_LENGTH: usize = 120;
pub const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

/// One document's metadata. The bytes live at `documents/<id>/<name>`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub size: u64,
    pub path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// The parsed contents of `library.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub schema_version: u32,
    pub library_id: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub records: BTreeMap<String, Record>,
}

/// What the frontend needs to render a library. Records are sorted for display.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    pub root: String,
    pub library_id: String,
    pub records: Vec<Record>,
}

/// The result of one import batch. Per-file failures do not abort the batch.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub library: LibrarySnapshot,
    pub imported: Vec<Record>,
    pub errors: Vec<String>,
}

pub fn create_library_file(now: &str) -> LibraryFile {
    LibraryFile {
        schema_version: SCHEMA_VERSION,
        library_id: create_library_id(),
        created_at: now.to_string(),
        updated_at: now.to_string(),
        records: BTreeMap::new(),
    }
}

/// Parse and validate a library index. Mirrors `parseLibraryFile` in core.
pub fn parse_library(text: &str) -> Result<LibraryFile, String> {
    let file: LibraryFile = serde_json::from_str(text)
        .map_err(|error| format!("library.json is not valid: {error}"))?;

    if file.schema_version == 0 {
        return Err("Unsupported library schema version: 0.".to_string());
    }

    if file.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "library.json uses schema version {}, but this build supports up to {}.",
            file.schema_version, SCHEMA_VERSION
        ));
    }

    if !is_library_id(&file.library_id) {
        return Err(format!("Invalid library id: {:?}.", file.library_id));
    }

    for (id, record) in &file.records {
        validate_record(record)?;
        if &record.id != id {
            return Err(format!(
                "Record {id:?} has a mismatched id {:?}.",
                record.id
            ));
        }
    }

    Ok(file)
}

/// Serialize exactly as written to disk: pretty JSON with a trailing newline.
pub fn serialize_library(file: &LibraryFile) -> Result<String, String> {
    let mut text = serde_json::to_string_pretty(file)
        .map_err(|error| format!("Could not serialize library.json: {error}"))?;
    text.push('\n');
    Ok(text)
}

pub fn validate_record(record: &Record) -> Result<(), String> {
    if !is_document_id(&record.id) {
        return Err(format!("Invalid document id: {:?}.", record.id));
    }

    if normalize_name(&record.name) != record.name {
        return Err(format!(
            "Invalid document name for {}: {:?}.",
            record.id, record.name
        ));
    }

    if record.media_type.is_empty() {
        return Err(format!("Invalid media type for {}.", record.id));
    }

    if record.path != record_path(&record.id, &record.name) {
        return Err(format!(
            "Invalid path for {}: {:?}.",
            record.id, record.path
        ));
    }

    for (field, value) in [
        ("createdAt", &record.created_at),
        ("updatedAt", &record.updated_at),
    ] {
        if !is_iso8601_utc(value) {
            return Err(format!("Invalid {field} for {}.", record.id));
        }
    }

    Ok(())
}

/// Write bytes through a temp file, then rename over the destination.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let temp = path.with_file_name(format!("{file_name}.tmp"));

    {
        let mut handle = fs::File::create(&temp).map_err(|error| error.to_string())?;
        handle
            .write_all(bytes)
            .and_then(|()| handle.sync_all())
            .map_err(|error| {
                let _ = fs::remove_file(&temp);
                error.to_string()
            })?;
    }

    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        // Some filesystems refuse to replace an existing file. Fall back to a
        // remove-then-rename, which is still safer than writing in place.
        Err(_) if path.exists() => {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            fs::rename(&temp, path).map_err(|error| {
                let _ = fs::remove_file(&temp);
                error.to_string()
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error.to_string())
        }
    }
}

/// An open library. Mutations update the index and write it immediately.
pub struct Library {
    root: PathBuf,
    file: LibraryFile,
}

impl Library {
    /// Open an existing library, or create one at `root` if it is empty.
    pub fn open_or_create(root: &Path) -> Result<Self, String> {
        if root.exists() && !root.is_dir() {
            return Err(format!("Not a directory: {}", root.display()));
        }

        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        fs::create_dir_all(root.join(LIBRARY_DIR)).map_err(|error| error.to_string())?;
        fs::create_dir_all(root.join(DOCUMENTS_DIR)).map_err(|error| error.to_string())?;

        let path = library_path(root);
        let file = if path.is_file() {
            let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            parse_library(&text)?
        } else {
            let file = create_library_file(&now_iso8601());
            atomic_write(&path, serialize_library(&file)?.as_bytes())?;
            file
        };

        Ok(Self {
            root: root.to_path_buf(),
            file,
        })
    }

    pub fn file(&self) -> &LibraryFile {
        &self.file
    }

    /// The library root on disk.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot(&self) -> LibrarySnapshot {
        let mut records: Vec<Record> = self.file.records.values().cloned().collect();
        records.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });

        LibrarySnapshot {
            root: self.root.display().to_string(),
            library_id: self.file.library_id.clone(),
            records,
        }
    }

    /// Copy `source` into the library and return its new record.
    pub fn import_path(&mut self, source: &Path) -> Result<Record, String> {
        let metadata =
            fs::metadata(source).map_err(|error| format!("{}: {error}", source.display()))?;

        if !metadata.is_file() {
            return Err(format!("Not a file: {}", source.display()));
        }

        let requested = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("untitled");

        let name = self.unique_document_name(requested)?;
        let id = self.new_document_id();
        let directory = self.root.join(DOCUMENTS_DIR).join(&id);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

        let destination = directory.join(&name);
        if let Err(error) = fs::copy(source, &destination) {
            let _ = fs::remove_dir_all(&directory);
            return Err(format!("Could not copy {}: {error}", source.display()));
        }

        self.finish_import(
            id,
            name,
            guess_media_type(requested).to_string(),
            metadata.len(),
        )
    }

    /// Store bytes that came from somewhere other than a file on disk.
    ///
    /// The native messaging host uses this for files NookBin sends over the
    /// wire. The caller's media type wins when it is non-empty; otherwise the
    /// name decides, exactly like `import_path`.
    pub fn import_bytes(
        &mut self,
        requested: &str,
        media_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<Record, String> {
        let name = self.unique_document_name(requested)?;
        let id = self.new_document_id();
        let directory = self.root.join(DOCUMENTS_DIR).join(&id);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

        let destination = directory.join(&name);
        if let Err(error) = fs::write(&destination, bytes) {
            let _ = fs::remove_dir_all(&directory);
            return Err(format!(
                "Could not write {}: {error}",
                destination.display()
            ));
        }

        let media_type = media_type
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| guess_media_type(requested).to_string());

        self.finish_import(id, name, media_type, bytes.len() as u64)
    }

    fn unique_document_name(&self, requested: &str) -> Result<String, String> {
        let existing: Vec<String> = self
            .file
            .records
            .values()
            .map(|record| record.name.clone())
            .collect();
        unique_name(&existing, requested)
    }

    fn finish_import(
        &mut self,
        id: String,
        name: String,
        media_type: String,
        size: u64,
    ) -> Result<Record, String> {
        let now = now_iso8601();
        let record = Record {
            id: id.clone(),
            name: name.clone(),
            media_type,
            size,
            path: record_path(&id, &name),
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        self.file.records.insert(id.clone(), record.clone());
        self.file.updated_at = now;

        if let Err(error) = self.save() {
            self.file.records.remove(&id);
            let _ = fs::remove_dir_all(self.root.join(DOCUMENTS_DIR).join(&id));
            return Err(error);
        }

        Ok(record)
    }

    /// Rename a record and its file, keeping the id.
    pub fn rename(&mut self, id: &str, name: &str) -> Result<Record, String> {
        let current = self
            .file
            .records
            .get(id)
            .cloned()
            .ok_or_else(|| format!("No document with id \"{id}\"."))?;

        let existing: Vec<String> = self
            .file
            .records
            .values()
            .filter(|record| record.id != id)
            .map(|record| record.name.clone())
            .collect();
        let next_name = unique_name(&existing, name)?;

        let old_path = self.root.join(&current.path);
        let next_path = record_path(id, &next_name);
        let next_absolute = self.root.join(&next_path);

        if old_path != next_absolute && old_path.exists() {
            if let Some(parent) = next_absolute.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::rename(&old_path, &next_absolute)
                .map_err(|error| format!("Could not rename {}: {error}", old_path.display()))?;
        }

        let now = now_iso8601();
        let record = Record {
            name: next_name,
            path: next_path,
            updated_at: now.clone(),
            ..current.clone()
        };

        self.file.records.insert(id.to_string(), record.clone());
        self.file.updated_at = now;

        if let Err(error) = self.save() {
            self.file.records.insert(id.to_string(), current);
            if old_path != next_absolute && next_absolute.exists() {
                let _ = fs::rename(&next_absolute, &old_path);
            }
            return Err(error);
        }

        Ok(record)
    }

    /// Remove a record and its folder. Unknown ids are an error.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let record = self
            .file
            .records
            .get(id)
            .cloned()
            .ok_or_else(|| format!("No document with id \"{id}\"."))?;

        let directory = self.root.join(DOCUMENTS_DIR).join(&record.id);
        match fs::remove_dir_all(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not delete {}: {error}", directory.display())),
        }

        self.file.records.remove(id);
        self.file.updated_at = now_iso8601();

        if let Err(error) = self.save() {
            self.file.records.insert(id.to_string(), record);
            return Err(error);
        }

        Ok(())
    }

    /// A copy of one record, or an error for an unknown id.
    pub fn record(&self, id: &str) -> Result<Record, String> {
        self.file
            .records
            .get(id)
            .cloned()
            .ok_or_else(|| format!("No document with id \"{id}\"."))
    }

    /// The bytes of a record's file.
    pub fn read_bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let record = self.record(id)?;
        let path = self.root.join(&record.path);
        fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))
    }

    /// A slice of a record's file, read without loading the rest.
    ///
    /// The native messaging host uses this to stream a document to the
    /// extension in chunks small enough for Chrome's 1 MB host-to-browser cap.
    pub fn read_range(&self, id: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        let record = self.record(id)?;
        let path = self.root.join(&record.path);

        let mut file = fs::File::open(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;

        let mut buffer = vec![0u8; length];
        let mut filled = 0;

        while filled < length {
            match file.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
            }
        }

        buffer.truncate(filled);
        Ok(buffer)
    }

    /// A record's file as UTF-8 text.
    pub fn read_text(&self, id: &str) -> Result<String, String> {
        let record = self.record(id)?;
        let bytes = self.read_bytes(id)?;
        String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text.", record.name))
    }

    /// Replace a text document's contents and update its size and timestamp.
    /// If the index cannot be written, the old bytes are restored.
    pub fn save_text(&mut self, id: &str, text: &str) -> Result<Record, String> {
        let current = self.record(id)?;
        let path = self.root.join(&current.path);
        let previous = fs::read(&path).ok();

        atomic_write(&path, text.as_bytes())?;

        let now = now_iso8601();
        let record = Record {
            size: text.len() as u64,
            updated_at: now.clone(),
            ..current.clone()
        };

        self.file.records.insert(id.to_string(), record.clone());
        self.file.updated_at = now;

        if let Err(error) = self.save() {
            self.file.records.insert(id.to_string(), current);
            match previous {
                Some(bytes) => {
                    let _ = atomic_write(&path, &bytes);
                }
                None => {
                    let _ = fs::remove_file(&path);
                }
            }
            return Err(error);
        }

        Ok(record)
    }

    /// Write a record to `destination`. Text documents pass the current editor
    /// contents so an export never depends on a prior save; everything else is
    /// copied from disk.
    pub fn export(&self, id: &str, destination: &Path, text: Option<&str>) -> Result<(), String> {
        let record = self.record(id)?;
        let bytes = match text {
            Some(text) => text.as_bytes().to_vec(),
            None => fs::read(self.root.join(&record.path))
                .map_err(|error| format!("Could not read {}: {error}", record.name))?,
        };

        atomic_write(destination, &bytes)
            .map_err(|error| format!("Could not write {}: {error}", destination.display()))
    }

    fn new_document_id(&self) -> String {
        loop {
            let id = create_document_id();
            if !self.file.records.contains_key(&id) {
                return id;
            }
        }
    }

    fn save(&self) -> Result<(), String> {
        let text = serialize_library(&self.file)?;
        atomic_write(&library_path(&self.root), text.as_bytes())
    }
}

fn library_path(root: &Path) -> PathBuf {
    root.join(LIBRARY_DIR).join(LIBRARY_FILE)
}

/// Relative path of a record's bytes inside the library.
pub fn record_path(id: &str, name: &str) -> String {
    format!("{DOCUMENTS_DIR}/{id}/{name}")
}

/// Turn any input into a safe file name. Mirrors `normalizeName` in core.
pub fn normalize_name(name: &str) -> String {
    let mut replaced = String::with_capacity(name.len());
    for character in name.chars() {
        if is_illegal_name_char(character) {
            replaced.push('-');
        } else {
            replaced.push(character);
        }
    }

    let collapsed = collapse_whitespace(&replaced);
    let trimmed = collapsed.trim();
    let without_leading = trimmed.trim_start_matches('.');
    let without_trailing = without_leading.trim_end_matches(|c| c == '.' || c == ' ');
    let truncated = truncate_utf16(without_trailing, MAX_NAME_LENGTH);
    let cleaned = truncated.trim_end_matches(|c| c == '.' || c == ' ');

    if cleaned.is_empty() {
        "untitled".to_string()
    } else {
        cleaned.to_string()
    }
}

fn is_illegal_name_char(character: char) -> bool {
    matches!(
        character,
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
    ) || (character as u32) < 0x20
}

fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;

    for character in value.chars() {
        if character.is_whitespace() {
            if !in_space {
                out.push(' ');
                in_space = true;
            }
        } else {
            out.push(character);
            in_space = false;
        }
    }

    out
}

/// Truncate by UTF-16 units, like `String.prototype.slice` in JavaScript.
fn truncate_utf16(value: &str, max: usize) -> &str {
    let mut units = 0;

    for (index, character) in value.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &value[..index];
        }
    }

    value
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 && index + 1 < name.len() => (&name[..index], &name[index..]),
        _ => (name, ""),
    }
}

/// Pick a name that does not collide with `existing`, case-insensitively.
pub fn unique_name(existing: &[String], name: &str) -> Result<String, String> {
    let taken: HashSet<String> = existing
        .iter()
        .map(|value| normalize_name(value).to_lowercase())
        .collect();

    let candidate = normalize_name(name);
    if !taken.contains(&candidate.to_lowercase()) {
        return Ok(candidate);
    }

    let (base, extension) = split_extension(&candidate);

    for suffix in 2..10_000 {
        let next = format!("{base} ({suffix}){extension}");
        if !taken.contains(&next.to_lowercase()) {
            return Ok(next);
        }
    }

    Err(format!("Could not find a free name for {candidate:?}."))
}

/// Infer a media type from a file name. Mirrors `guessMediaType` in core.
pub fn guess_media_type(name: &str) -> &'static str {
    let normalized = normalize_name(name);
    let (_, extension) = split_extension(&normalized);

    match extension.trim_start_matches('.').to_lowercase().as_str() {
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => DEFAULT_MEDIA_TYPE,
    }
}

const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH: usize = 10;

fn random_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let mut out = String::with_capacity(ID_LENGTH);

    while out.len() < ID_LENGTH {
        // RandomState is seeded from OS entropy and differs per instance.
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0),
        );

        let mut value = hasher.finish();
        for _ in 0..8 {
            if out.len() == ID_LENGTH {
                break;
            }
            out.push(ALPHABET[(value % ALPHABET.len() as u64) as usize] as char);
            value /= ALPHABET.len() as u64;
        }
    }

    out
}

pub fn create_document_id() -> String {
    format!("doc_{}", random_suffix())
}

pub fn create_library_id() -> String {
    format!("lib_{}", random_suffix())
}

pub fn is_document_id(value: &str) -> bool {
    has_prefixed_base36(value, "doc_")
}

pub fn is_library_id(value: &str) -> bool {
    has_prefixed_base36(value, "lib_")
}

fn has_prefixed_base36(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else {
        return false;
    };

    (6..=32).contains(&rest.len())
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// UTC timestamp with millisecond precision, the same shape as `toISOString()`.
pub fn now_iso8601() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let millis = duration.subsec_millis();

    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's civil-from-days algorithm (days since 1970-01-01).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;

    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Accept the canonical UTC form this module writes.
pub fn is_iso8601_utc(value: &str) -> bool {
    if value.len() < 20 || value.len() > 30 {
        return false;
    }

    let bytes = value.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }

    let Some(year) = parse_digits(value, 0, 4) else {
        return false;
    };
    let Some(month) = parse_digits(value, 5, 2) else {
        return false;
    };
    let Some(day) = parse_digits(value, 8, 2) else {
        return false;
    };
    let Some(hour) = parse_digits(value, 11, 2) else {
        return false;
    };
    let Some(minute) = parse_digits(value, 14, 2) else {
        return false;
    };
    let Some(second) = parse_digits(value, 17, 2) else {
        return false;
    };

    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return false;
    }

    let rest = &value[19..];

    if let Some(fraction) = rest.strip_prefix('.') {
        let Some(fraction) = fraction.strip_suffix('Z') else {
            return false;
        };
        if fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return false;
        }
    } else if rest != "Z" {
        return false;
    }

    true
}

fn parse_digits(value: &str, start: usize, length: usize) -> Option<u32> {
    let slice = value.get(start..start + length)?;
    if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    slice.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nookedit-library-{label}-{}-{serial}",
            std::process::id()
        ))
    }

    fn sample_record(name: &str) -> Record {
        let id = create_document_id();
        let now = now_iso8601();

        Record {
            id: id.clone(),
            name: name.to_string(),
            media_type: guess_media_type(name).to_string(),
            size: 3,
            path: record_path(&id, name),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn ids_have_the_expected_shape_and_do_not_repeat() {
        let mut ids = HashSet::new();

        for _ in 0..2_000 {
            let id = create_document_id();
            assert!(is_document_id(&id), "{id}");
            ids.insert(id);
        }

        assert_eq!(ids.len(), 2_000);
        assert!(is_library_id(&create_library_id()));
        assert!(!is_document_id("lib_abcdefghij"));
        assert!(!is_document_id("doc_"));
        assert!(!is_document_id("doc_ABCDEFGHIJ"));
    }

    #[test]
    fn normalize_name_matches_the_core_rules() {
        assert_eq!(normalize_name("  my   report.pdf  "), "my report.pdf");
        assert_eq!(normalize_name("a/b\\c.txt"), "a-b-c.txt");
        assert_eq!(normalize_name("what?.pdf"), "what-.pdf");
        assert_eq!(normalize_name("a:b*c\"d<e>f|g.txt"), "a-b-c-d-e-f-g.txt");
        assert_eq!(normalize_name("a\u{1}b\u{1f}c.txt"), "a-b-c.txt");
        assert_eq!(normalize_name("..hidden"), "hidden");
        assert_eq!(normalize_name("report.pdf..."), "report.pdf");
        assert_eq!(normalize_name("report.pdf   "), "report.pdf");
        assert_eq!(normalize_name(""), "untitled");
        assert_eq!(normalize_name("   "), "untitled");
        assert_eq!(normalize_name("..."), "untitled");
    }

    #[test]
    fn normalize_name_caps_length_without_leaving_trailing_dots() {
        let name = normalize_name(&format!("{}.pdf", "a".repeat(300)));
        assert!(name.chars().count() <= MAX_NAME_LENGTH);
        assert!(!name.ends_with('.'));
    }

    #[test]
    fn unique_name_adds_a_suffix_before_the_extension() {
        assert_eq!(unique_name(&[], "report.pdf").unwrap(), "report.pdf");
        assert_eq!(
            unique_name(&["report.pdf".into()], "report.pdf").unwrap(),
            "report (2).pdf"
        );
        assert_eq!(
            unique_name(
                &["report.pdf".into(), "report (2).pdf".into()],
                "report.pdf"
            )
            .unwrap(),
            "report (3).pdf"
        );
        assert_eq!(
            unique_name(&["REPORT.PDF".into()], "report.pdf").unwrap(),
            "report (2).pdf"
        );
        assert_eq!(
            unique_name(&["notes".into()], "notes").unwrap(),
            "notes (2)"
        );
    }

    #[test]
    fn media_types_are_inferred_case_insensitively() {
        assert_eq!(guess_media_type("Report.PDF"), "application/pdf");
        assert_eq!(guess_media_type("notes.md"), "text/markdown");
        assert_eq!(guess_media_type("data.json"), "application/json");
        assert_eq!(guess_media_type("archive.unknown"), DEFAULT_MEDIA_TYPE);
        assert_eq!(guess_media_type("no-extension"), DEFAULT_MEDIA_TYPE);
    }

    #[test]
    fn timestamps_use_the_canonical_utc_shape() {
        let now = now_iso8601();
        assert!(is_iso8601_utc(&now), "{now}");
        assert_eq!(now.len(), 24);

        assert!(is_iso8601_utc("2026-01-01T00:00:00.000Z"));
        assert!(is_iso8601_utc("2024-02-29T23:59:59.999Z"));
        assert!(!is_iso8601_utc("2026-02-29T00:00:00.000Z"));
        assert!(!is_iso8601_utc("2026-13-01T00:00:00.000Z"));
        assert!(!is_iso8601_utc("2026-01-01T24:00:00.000Z"));
        assert!(!is_iso8601_utc("2026-01-01T00:00:00+01:00"));
        assert!(!is_iso8601_utc("yesterday"));
    }

    #[test]
    fn serialize_and_parse_round_trip() {
        let mut file = create_library_file("2026-01-01T00:00:00.000Z");
        let record = sample_record("a.txt");
        file.records.insert(record.id.clone(), record);
        file.updated_at = "2026-01-02T00:00:00.000Z".to_string();

        let text = serialize_library(&file).unwrap();
        assert!(text.ends_with("}\n"));

        let parsed = parse_library(&text).unwrap();
        assert_eq!(parsed.library_id, file.library_id);
        assert_eq!(parsed.records.len(), 1);
    }

    #[test]
    fn parse_rejects_invalid_indexes() {
        let base = create_library_file("2026-01-01T00:00:00.000Z");

        let newer = serde_json::json!({ "schemaVersion": 2, "libraryId": "lib_abcdefghij" });
        assert!(parse_library(&newer.to_string())
            .unwrap_err()
            .contains("supports up to 1"));

        let bad_id = serde_json::json!({ "schemaVersion": 1, "libraryId": "nope" });
        assert!(parse_library(&bad_id.to_string())
            .unwrap_err()
            .contains("Invalid library id"));

        let mut mismatched = base.clone();
        let record = sample_record("a.txt");
        mismatched.records.insert("doc_other0000".into(), record);
        assert!(parse_library(&serialize_library(&mismatched).unwrap())
            .unwrap_err()
            .contains("mismatched id"));

        let mut bad_name = base;
        let mut record = sample_record("a.txt");
        record.name = "a/b.txt".into();
        bad_name.records.insert(record.id.clone(), record);
        assert!(parse_library(&serialize_library(&bad_name).unwrap())
            .unwrap_err()
            .contains("Invalid document name"));
    }

    #[test]
    fn parses_the_shared_fixture() {
        let text = include_str!("../../../packages/core/tests/fixtures/library-v1.json");
        let library = parse_library(text).unwrap();

        assert_eq!(library.library_id, "lib_fixture001");
        assert_eq!(library.records.len(), 2);
        assert_eq!(
            library.records["doc_fixture001"].name,
            "Quarterly report.pdf"
        );
        assert_eq!(
            library.records["doc_fixture002"].path,
            "documents/doc_fixture002/notes (2).md"
        );
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let root = temp_root("atomic");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("library.json");

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!root.join("library.json.tmp").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn imports_lists_renames_and_removes() {
        let root = temp_root("crud");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let source = root.join("report.pdf");
        fs::write(&source, b"PDF").unwrap();

        let mut library = Library::open_or_create(&root).unwrap();
        assert!(library.file().records.is_empty());

        let record = library.import_path(&source).unwrap();
        assert_eq!(record.name, "report.pdf");
        assert_eq!(record.size, 3);
        assert_eq!(record.media_type, "application/pdf");
        assert!(root.join(&record.path).is_file());

        let duplicate = library.import_path(&source).unwrap();
        assert_eq!(duplicate.name, "report (2).pdf");
        assert_eq!(library.snapshot().records.len(), 2);

        let renamed = library.rename(&record.id, "renamed.pdf").unwrap();
        assert_eq!(renamed.name, "renamed.pdf");
        assert!(!root.join(&record.path).exists());
        assert!(root.join(&renamed.path).is_file());

        library.remove(&record.id).unwrap();
        assert_eq!(library.snapshot().records.len(), 1);
        assert!(!root.join("documents").join(&record.id).exists());

        // Reopening reads the persisted index.
        let reopened = Library::open_or_create(&root).unwrap();
        assert_eq!(reopened.snapshot().records.len(), 1);
        assert_eq!(reopened.snapshot().records[0].name, "report (2).pdf");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_saves_and_exports_documents() {
        let root = temp_root("io");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let source = root.join("notes.md");
        fs::write(&source, "# first\n").unwrap();

        let mut library = Library::open_or_create(&root).unwrap();
        let record = library.import_path(&source).unwrap();

        assert_eq!(library.read_text(&record.id).unwrap(), "# first\n");
        assert_eq!(library.read_bytes(&record.id).unwrap(), b"# first\n");

        let edited = "# second\n\nbody ✓\n";
        let saved = library.save_text(&record.id, edited).unwrap();
        assert_eq!(saved.size, edited.len() as u64);
        assert_eq!(library.read_text(&record.id).unwrap(), edited);
        assert!(saved.updated_at >= record.updated_at);

        // A text export writes the supplied contents, not the saved file.
        let export = root.join("out").join("export.md");
        library
            .export(&record.id, &export, Some("exported text\n"))
            .unwrap();
        assert_eq!(fs::read_to_string(&export).unwrap(), "exported text\n");

        // Without text, the export copies the document's bytes.
        let copy = root.join("copy.md");
        library.export(&record.id, &copy, None).unwrap();
        assert_eq!(fs::read_to_string(&copy).unwrap(), edited);

        // The edit survives a reopen, including the index's size field.
        drop(library);
        let reopened = Library::open_or_create(&root).unwrap();
        assert_eq!(reopened.read_text(&record.id).unwrap(), edited);
        assert_eq!(
            reopened.file().records[&record.id].size,
            edited.len() as u64
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn imports_bytes_with_a_caller_media_type() {
        let root = temp_root("bytes");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let mut library = Library::open_or_create(&root).unwrap();
        let payload = b"# from the wire\n";

        let record = library
            .import_bytes("wire.md", Some("text/markdown"), payload)
            .unwrap();

        assert_eq!(record.name, "wire.md");
        assert_eq!(record.media_type, "text/markdown");
        assert_eq!(record.size, payload.len() as u64);
        assert_eq!(fs::read(root.join(&record.path)).unwrap(), payload);
        assert_eq!(library.read_text(&record.id).unwrap(), "# from the wire\n");

        // An empty media type falls back to the extension.
        let guessed = library
            .import_bytes("second.md", Some(""), b"# two\n")
            .unwrap();
        assert_eq!(guessed.media_type, "text/markdown");

        // Duplicate names are still made unique.
        let duplicate = library.import_bytes("wire.md", None, b"again").unwrap();
        assert_eq!(duplicate.name, "wire (2).md");

        // The index on disk is valid after a reopen.
        drop(library);
        let reopened = Library::open_or_create(&root).unwrap();
        assert_eq!(reopened.file().records.len(), 3);
        assert_eq!(reopened.read_bytes(&record.id).unwrap(), payload);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_text_rejects_binary_files() {
        let root = temp_root("binary");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let source = root.join("data.bin");
        fs::write(&source, [0xff, 0xfe, 0x00]).unwrap();

        let mut library = Library::open_or_create(&root).unwrap();
        let record = library.import_path(&source).unwrap();

        let error = library.read_text(&record.id).err().unwrap();
        assert!(error.contains("not UTF-8 text"), "{error}");
        assert_eq!(library.read_bytes(&record.id).unwrap(), [0xff, 0xfe, 0x00]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_save_and_export_reject_unknown_ids() {
        let root = temp_root("unknown");
        let _ = fs::remove_dir_all(&root);

        let library = Library::open_or_create(&root).unwrap();
        let missing = "doc_missing000";

        assert!(library.read_text(missing).is_err());
        assert!(library.read_bytes(missing).is_err());
        assert!(library.export(missing, &root.join("x.txt"), None).is_err());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn open_or_create_initializes_an_empty_folder() {
        let root = temp_root("create");
        let _ = fs::remove_dir_all(&root);

        let library = Library::open_or_create(&root).unwrap();

        assert!(root.join(".nooksuite").join("library.json").is_file());
        assert!(root.join("documents").is_dir());
        assert!(is_library_id(&library.file().library_id));
        assert!(library.file().records.is_empty());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn open_or_create_rejects_a_file_path() {
        let root = temp_root("not-a-dir");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&root, b"file").unwrap();

        let error = Library::open_or_create(&root).err().unwrap();
        assert!(error.contains("Not a directory"));

        fs::remove_file(&root).unwrap();
    }
}
