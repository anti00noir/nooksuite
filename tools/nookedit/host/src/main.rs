//! Native messaging host for the NookSuite library.
//!
//! Chrome starts this process when NookBin calls
//! `chrome.runtime.connectNative("dev.nooksuite.host")`. Requests arrive as
//! length-prefixed JSON on stdin and responses leave the same way on stdout.
//! Nothing else may be written to stdout.
//!
//! The library folder comes from `NOOKSUITE_LIBRARY_ROOT`, then the folder the
//! desktop app saved, then `Documents\NookSuite`.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod protocol;

use std::io::{self, BufReader, BufWriter};

fn main() {
    let root = match config::library_root() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("nooksuite-host: {error}");
            std::process::exit(1);
        }
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    // One request at a time keeps the library single-writer for this process;
    // the desktop app is the only other writer, and every request reopens the
    // index so its changes are picked up.
    loop {
        match protocol::read_message(&mut reader) {
            Ok(Some(payload)) => {
                let response = protocol::handle_message(&root, &payload);
                if let Err(error) = protocol::write_message(&mut writer, &response) {
                    eprintln!("nooksuite-host: could not write a response: {error}");
                    break;
                }
            }
            Ok(None) => break,
            Err(error) => {
                eprintln!("nooksuite-host: {error}");
                break;
            }
        }
    }
}
