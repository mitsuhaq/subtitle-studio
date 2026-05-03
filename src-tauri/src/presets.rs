//! Subtitle style presets stored as one JSON file per preset under
//! `data/presets/<name>.json`. Names are sanitized to filesystem-safe slugs
//! when written; the human-readable name is preserved inside the JSON.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::pipeline::SubtitleStyle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub style: SubtitleStyle,
}

fn presets_dir() -> PathBuf {
    paths::data_dir().join("presets")
}

fn sanitize(name: &str) -> String {
    // Keep human-readable Unicode; just neutralise FS-hostile characters
    // and leading dots (which would hide the file on Unix). Trims surrounding
    // whitespace and collapses internal whitespace to single underscores.
    const BAD: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'];
    let mut out = String::with_capacity(name.len());
    let mut last_us = false;
    for c in name.trim().chars() {
        if BAD.contains(&c) {
            continue;
        }
        if c.is_whitespace() {
            if !last_us {
                out.push('_');
                last_us = true;
            }
        } else {
            out.push(c);
            last_us = false;
        }
    }
    out.trim_matches(|c: char| c == '.' || c == '_').to_string()
}

fn preset_path(name: &str) -> Result<PathBuf> {
    let slug = sanitize(name);
    if slug.is_empty() {
        return Err(anyhow!("Имя пресета не может быть пустым"));
    }
    Ok(presets_dir().join(format!("{slug}.json")))
}

pub fn list() -> Result<Vec<Preset>> {
    let dir = presets_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<Preset> = Vec::new();
    for entry in std::fs::read_dir(&dir).context("read presets dir")? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read(&path).and_then(|b| {
            serde_json::from_slice::<Preset>(&b)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        }) {
            Ok(p) => out.push(p),
            Err(e) => log::warn!("preset {} parse failed: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn save(name: String, style: SubtitleStyle) -> Result<Preset> {
    std::fs::create_dir_all(presets_dir()).ok();
    let path = preset_path(&name)?;
    let preset = Preset { name, style };
    let json = serde_json::to_vec_pretty(&preset)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(preset)
}

pub fn delete(name: &str) -> Result<()> {
    let path = preset_path(name)?;
    if path.exists() {
        std::fs::remove_file(&path).context("remove preset")?;
    }
    Ok(())
}

/// Seed bundled defaults the first time the app sees an empty presets dir.
/// Idempotent — never overwrites existing presets.
pub fn seed_defaults_if_empty() -> Result<()> {
    let dir = presets_dir();
    std::fs::create_dir_all(&dir).ok();
    let any = std::fs::read_dir(&dir)?
        .flatten()
        .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"));
    if any {
        return Ok(());
    }
    for p in builtin_defaults() {
        let _ = save(p.name, p.style);
    }
    Ok(())
}

fn builtin_defaults() -> Vec<Preset> {
    vec![
        Preset {
            name: "Стандарт".into(),
            style: SubtitleStyle::default(),
        },
        Preset {
            name: "Кино".into(),
            style: SubtitleStyle {
                font_family: "Inter".into(),
                font_size: 44,
                primary_color: "#F4F4F4".into(),
                outline_color: "#000000".into(),
                outline_width: 3.0,
                bold: true,
                italic: false,
                margin_v: 80,
                ..SubtitleStyle::default()
            },
        },
        Preset {
            name: "TikTok".into(),
            style: SubtitleStyle {
                font_family: "Inter".into(),
                font_size: 56,
                primary_color: "#FFFFFF".into(),
                outline_color: "#000000".into(),
                outline_width: 4.0,
                bold: true,
                italic: false,
                alignment: 5, // ASS: middle-center
                margin_v: 0,
                ..SubtitleStyle::default()
            },
        },
    ]
}
