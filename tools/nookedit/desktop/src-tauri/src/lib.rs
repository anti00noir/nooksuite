use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsSpikeReport {
    root: String,
    library_json: String,
    document_path: String,
    document_text: String,
    atomic_write: bool,
    hidden_dir: bool,
    nested_dirs: bool,
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid file name: {}", path.display()))?;

    let temp = path.with_file_name(format!("{file_name}.tmp"));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;

    // Windows rename() does not replace an existing file, so remove first.
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }

    fs::rename(&temp, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn run_fs_spike(root: String) -> Result<FsSpikeReport, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }

    let nook_dir = root.join(".nooksuite");
    let documents_dir = root.join("documents");
    let id = format!("spike-{}", std::process::id());
    let id_dir = documents_dir.join(&id);

    fs::create_dir_all(&nook_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&id_dir).map_err(|error| error.to_string())?;

    let library = serde_json::json!({
        "schemaVersion": 1,
        "records": {},
        "spike": true,
    });
    let library_path = nook_dir.join("library.json");
    let library_bytes = serde_json::to_vec_pretty(&library).map_err(|error| error.to_string())?;
    atomic_write(&library_path, &library_bytes)?;

    let document_path = id_dir.join("hello.txt");
    fs::write(&document_path, "hello from the Tauri fs spike\n")
        .map_err(|error| error.to_string())?;
    let document_text = fs::read_to_string(&document_path).map_err(|error| error.to_string())?;

    let atomic_write_ok = library_path.is_file()
        && fs::read(&library_path).map_err(|error| error.to_string())? == library_bytes;

    Ok(FsSpikeReport {
        root: root.display().to_string(),
        library_json: library_path.display().to_string(),
        document_path: document_path.display().to_string(),
        document_text,
        atomic_write: atomic_write_ok,
        hidden_dir: nook_dir.is_dir(),
        nested_dirs: id_dir.is_dir(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_fs_spike])
        .run(tauri::generate_context!())
        .expect("error while running the NookEdit spike app");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nookedit-spike-{label}-{}", std::process::id()))
    }

    #[test]
    fn fs_spike_creates_library_and_document() {
        let root = temp_root("creates");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let report = run_fs_spike(root.display().to_string()).unwrap();

        assert!(report.hidden_dir);
        assert!(report.nested_dirs);
        assert!(report.atomic_write);
        assert_eq!(report.document_text, "hello from the Tauri fs spike\n");

        let library: serde_json::Value =
            serde_json::from_slice(&fs::read(&report.library_json).unwrap()).unwrap();
        assert_eq!(library["schemaVersion"], 1);
        assert_eq!(library["spike"], true);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fs_spike_rejects_a_missing_directory() {
        let missing = temp_root("missing");
        let _ = fs::remove_dir_all(&missing);
        assert!(run_fs_spike(missing.display().to_string()).is_err());
    }
}
