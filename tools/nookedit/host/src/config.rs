//! Resolves the library folder the host should open.
//!
//! Order: an explicit environment override (used by the check script and by
//! tests), then the `libraryPath` the desktop app saved, then the default
//! `Documents\NookSuite` folder. The host never writes settings; the app owns
//! the picker.

use nooksuite_library::settings::{self, APP_IDENTIFIER, SETTINGS_FILE};
use std::path::PathBuf;

/// Overrides everything. Handy for a throwaway library in a script.
pub const LIBRARY_ROOT_ENV: &str = "NOOKSUITE_LIBRARY_ROOT";
pub const LIBRARY_FOLDER: &str = "NookSuite";

pub fn library_root() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(LIBRARY_ROOT_ENV) {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    if let Some(configured) = configured_library_root()? {
        return Ok(configured);
    }

    let documents =
        dirs::document_dir().ok_or_else(|| "Could not find the Documents folder.".to_string())?;
    Ok(documents.join(LIBRARY_FOLDER))
}

fn configured_library_root() -> Result<Option<PathBuf>, String> {
    let config =
        dirs::config_dir().ok_or_else(|| "Could not find the app config folder.".to_string())?;
    let path = config.join(APP_IDENTIFIER).join(SETTINGS_FILE);

    // A missing or corrupt file reads as defaults, which means "no choice yet".
    let settings = settings::read_settings(&path);
    Ok(settings
        .library_path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from))
}
