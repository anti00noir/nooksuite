//! The NookSuite on-disk library, shared by every native tool.
//!
//! `library` implements format v1 (see `docs/library-format.md`) and is the
//! single Rust implementation used by the NookEdit desktop app and by the
//! native messaging host NookBin talks to.
//!
//! `settings` persists the chosen library folder in the same `settings.json`
//! the desktop app writes, so the host opens the library the user picked.

pub mod library;
pub mod settings;
