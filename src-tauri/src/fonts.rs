//! System font enumeration with one-shot caching.
//!
//! `fontdb::Database::load_system_fonts()` walks the OS font directories and
//! parses the actual TTF/OTF files, so the human-readable family names match
//! exactly what CSS `font-family` expects (file stems often differ from real
//! font names — e.g. `SFNS.ttf` actually identifies as "SF Pro").
//!
//! The first call is the expensive one (~0.5–2 s on a typical Mac); we cache
//! the result for the lifetime of the process.

use std::collections::BTreeSet;
use std::sync::OnceLock;

static CACHE: OnceLock<Vec<String>> = OnceLock::new();

fn load() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: BTreeSet<String> = BTreeSet::new();
    for face in db.faces() {
        // `families` is a Vec<(name, language)> — the English entry is the
        // most useful for cross-platform CSS matching.
        let preferred = face
            .families
            .iter()
            .find(|(_, lang)| lang.primary_language() == "English")
            .map(|(n, _)| n.clone())
            .or_else(|| face.families.first().map(|(n, _)| n.clone()));
        if let Some(name) = preferred {
            // Drop hidden system faces that aren't useful as user-facing
            // choices (those starting with `.`, e.g. `.SF NS`).
            if !name.starts_with('.') {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

/// Returns a sorted list of family names. Cheap after the first call.
pub fn list() -> Vec<String> {
    CACHE.get_or_init(load).clone()
}

/// Kick off the load on a background thread so the cache is warm by the time
/// the user opens the Style tab. Safe to call multiple times.
pub fn warm_cache() {
    std::thread::Builder::new()
        .name("fontdb-warmup".into())
        .spawn(|| {
            let _ = list();
        })
        .ok();
}
