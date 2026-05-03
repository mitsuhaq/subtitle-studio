//! Persisted pending-queue: list of file paths the user lined up but didn't
//! finish. Survives restarts, so closing the app mid-batch (or right after
//! adding files) doesn't lose the work. Only paths that still exist on disk
//! are returned on load — stale entries are silently dropped.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths;

const FILE: &str = "queue.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Stored {
    /// Pending file paths in display order.
    paths: Vec<PathBuf>,
}

fn path() -> PathBuf {
    paths::data_dir().join(FILE)
}

pub fn load() -> Vec<PathBuf> {
    let p = path();
    if !p.exists() {
        return Vec::new();
    }
    let bytes = match std::fs::read(&p) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("queue.json read failed: {e}");
            return Vec::new();
        }
    };
    let parsed: Stored = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("queue.json parse failed: {e}");
            return Vec::new();
        }
    };
    parsed.paths.into_iter().filter(|p| p.exists()).collect()
}

pub fn save(paths: Vec<PathBuf>) -> Result<()> {
    let target = path();
    if paths.is_empty() {
        // Nothing pending → remove the file so we don't ressurect deleted
        // entries on next launch.
        let _ = std::fs::remove_file(&target);
        return Ok(());
    }
    let stored = Stored { paths };
    let json = serde_json::to_vec_pretty(&stored).context("encode queue.json")?;
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, &json).context("write queue.tmp")?;
    std::fs::rename(&tmp, &target).context("rename queue.tmp")?;
    Ok(())
}
