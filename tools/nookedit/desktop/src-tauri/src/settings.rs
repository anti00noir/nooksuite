//! App-level settings, stored in the Tauri config directory.
//!
//! Only the library location is persisted for now. A missing or corrupt file
//! falls back to defaults so a bad write can never keep the app from starting.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub library_path: Option<String>,
}

pub fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
}

pub fn read_settings(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_path(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "nookedit-settings-{label}-{}-{serial}",
            std::process::id()
        ))
    }

    #[test]
    fn missing_settings_fall_back_to_defaults() {
        let path = temp_path("missing").join(SETTINGS_FILE);
        assert_eq!(read_settings(&path).library_path, None);
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let path = temp_path("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not json").unwrap();

        assert_eq!(read_settings(&path).library_path, None);

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn settings_round_trip() {
        let path = temp_path("roundtrip").join(SETTINGS_FILE);
        let settings = Settings {
            library_path: Some("C:\\Users\\Example\\Documents\\NookSuite".to_string()),
        };

        write_settings(&path, &settings).unwrap();
        assert_eq!(read_settings(&path).library_path, settings.library_path);

        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
