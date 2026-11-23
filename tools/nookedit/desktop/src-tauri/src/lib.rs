mod library;
mod settings;

use library::{ImportOutcome, Library, LibrarySnapshot};
use serde::Serialize;
use settings::Settings;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessConfig {
    report_path: String,
    library_root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeadlessLibraryReport {
    root: String,
    library_id: String,
    imported_id: String,
    imported_name: String,
    renamed_name: String,
    record_count: usize,
    reopened_count: usize,
    persisted: bool,
}

#[tauri::command]
fn default_library_path(app: tauri::AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    Ok(documents.join("NookSuite").display().to_string())
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Settings {
    settings::settings_path(&app)
        .map(|path| settings::read_settings(&path))
        .unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings::settings_path(&app)?;
    settings::write_settings(&path, &settings)
}

#[tauri::command]
fn open_library(path: String) -> Result<LibrarySnapshot, String> {
    Ok(Library::open_or_create(Path::new(&path))?.snapshot())
}

#[tauri::command]
fn import_documents(root: String, paths: Vec<String>) -> Result<ImportOutcome, String> {
    let mut library = Library::open_or_create(Path::new(&root))?;
    let mut imported = Vec::new();
    let mut errors = Vec::new();

    for path in paths {
        match library.import_path(Path::new(&path)) {
            Ok(record) => imported.push(record),
            Err(error) => errors.push(error),
        }
    }

    Ok(ImportOutcome {
        library: library.snapshot(),
        imported,
        errors,
    })
}

#[tauri::command]
fn rename_document(root: String, id: String, name: String) -> Result<LibrarySnapshot, String> {
    let mut library = Library::open_or_create(Path::new(&root))?;
    library.rename(&id, &name)?;
    Ok(library.snapshot())
}

#[tauri::command]
fn remove_document(root: String, id: String) -> Result<LibrarySnapshot, String> {
    let mut library = Library::open_or_create(Path::new(&root))?;
    library.remove(&id)?;
    Ok(library.snapshot())
}

/// Set NOOKEDIT_HEADLESS_REPORT to run the checks on launch, write the results
/// to that path, and exit. Used by scripts/run-headless.mjs so the library and
/// PDF benchmark can run in WebView2 without a human clicking.
#[tauri::command]
fn headless_config() -> Option<HeadlessConfig> {
    let report_path = std::env::var("NOOKEDIT_HEADLESS_REPORT").ok()?;
    Some(HeadlessConfig {
        report_path,
        library_root: std::env::var("NOOKEDIT_HEADLESS_LIBRARY_ROOT").ok(),
    })
}

/// Create a library in `root`, import a file, rename it, reopen, and report
/// what survived. This exercises the same code paths as the UI, through IPC.
#[tauri::command]
fn headless_library_check(root: String) -> Result<HeadlessLibraryReport, String> {
    let root_path = PathBuf::from(&root);
    fs::create_dir_all(&root_path).map_err(|error| error.to_string())?;

    let sample = root_path.join("headless sample.txt");
    fs::write(&sample, b"headless library check\n").map_err(|error| error.to_string())?;

    let mut library = Library::open_or_create(&root_path)?;
    let imported = library.import_path(&sample)?;
    let renamed = library.rename(&imported.id, "renamed.txt")?;
    let library_id = library.file().library_id.clone();
    let record_count = library.file().records.len();
    drop(library);

    let reopened = Library::open_or_create(&root_path)?;
    let reopened_count = reopened.file().records.len();
    let persisted = reopened
        .file()
        .records
        .get(&imported.id)
        .map(|record| record.name == "renamed.txt")
        .unwrap_or(false);

    Ok(HeadlessLibraryReport {
        root,
        library_id,
        imported_id: imported.id,
        imported_name: imported.name,
        renamed_name: renamed.name,
        record_count,
        reopened_count,
        persisted,
    })
}

#[tauri::command]
fn save_report(path: String, body: String) -> Result<(), String> {
    fs::write(&path, body).map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_library_path,
            load_settings,
            save_settings,
            open_library,
            import_documents,
            rename_document,
            remove_document,
            headless_config,
            headless_library_check,
            save_report,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running NookEdit");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nookedit-headless-{label}-{}-{serial}",
            std::process::id()
        ))
    }

    #[test]
    fn headless_check_imports_renames_and_reopens() {
        let root = temp_root("library");
        let _ = fs::remove_dir_all(&root);

        let report = headless_library_check(root.display().to_string()).unwrap();

        assert_eq!(report.imported_name, "headless sample.txt");
        assert_eq!(report.renamed_name, "renamed.txt");
        assert_eq!(report.record_count, 1);
        assert_eq!(report.reopened_count, 1);
        assert!(report.persisted);
        assert!(library::is_library_id(&report.library_id));

        fs::remove_dir_all(&root).unwrap();
    }
}
