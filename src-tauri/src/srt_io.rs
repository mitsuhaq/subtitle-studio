//! Read/write SubRip (`.srt`) files used by the transcript editor.
//!
//! We only need the basics: numbered cues with `HH:MM:SS,mmm` start/end and
//! free-form text (which may span several lines). We do NOT touch styling
//! tags — the editor edits text only, timestamps round-trip verbatim.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SrtCue {
    pub index: u32,
    /// Start time in milliseconds.
    pub start_ms: u64,
    /// End time in milliseconds.
    pub end_ms: u64,
    pub text: String,
}

pub fn read(path: &PathBuf) -> Result<Vec<SrtCue>> {
    let raw = std::fs::read_to_string(path).context("read srt")?;
    parse(&raw)
}

pub fn write(path: &PathBuf, cues: &[SrtCue]) -> Result<()> {
    let mut out = String::new();
    for (i, c) in cues.iter().enumerate() {
        let n = i + 1;
        out.push_str(&format!("{n}\n"));
        out.push_str(&format!(
            "{} --> {}\n",
            ms_to_stamp(c.start_ms),
            ms_to_stamp(c.end_ms)
        ));
        out.push_str(c.text.trim_end_matches('\n'));
        out.push_str("\n\n");
    }
    let tmp = path.with_extension("srt.tmp");
    std::fs::write(&tmp, out.as_bytes()).context("write srt.tmp")?;
    std::fs::rename(&tmp, path).context("rename srt.tmp")?;
    Ok(())
}

fn parse(raw: &str) -> Result<Vec<SrtCue>> {
    let mut cues: Vec<SrtCue> = Vec::new();
    // Normalise CRLF and split on blank lines.
    let normalised = raw.replace("\r\n", "\n").replace('\r', "\n");
    for block in normalised.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let mut lines = block.lines();
        let idx_line = lines
            .next()
            .ok_or_else(|| anyhow!("missing index line"))?
            .trim();
        let index: u32 = idx_line
            .parse()
            .with_context(|| format!("bad cue index: {idx_line:?}"))?;
        let timing = lines
            .next()
            .ok_or_else(|| anyhow!("missing timing line"))?
            .trim();
        let (start, end) = parse_timing(timing)?;
        let text = lines.collect::<Vec<_>>().join("\n");
        cues.push(SrtCue {
            index,
            start_ms: start,
            end_ms: end,
            text,
        });
    }
    Ok(cues)
}

fn parse_timing(line: &str) -> Result<(u64, u64)> {
    let parts: Vec<&str> = line.split("-->").map(str::trim).collect();
    if parts.len() != 2 {
        bail!("invalid timing line: {line:?}");
    }
    Ok((stamp_to_ms(parts[0])?, stamp_to_ms(parts[1])?))
}

fn stamp_to_ms(s: &str) -> Result<u64> {
    // HH:MM:SS,mmm
    let (hms, ms) = s
        .split_once(',')
        .or_else(|| s.split_once('.'))
        .ok_or_else(|| anyhow!("missing milliseconds: {s:?}"))?;
    let mut parts = hms.splitn(3, ':');
    let h: u64 = parts.next().unwrap_or("0").parse().context("hours")?;
    let m: u64 = parts.next().unwrap_or("0").parse().context("minutes")?;
    let sec: u64 = parts.next().unwrap_or("0").parse().context("seconds")?;
    let millis: u64 = ms.parse().context("ms")?;
    Ok(h * 3_600_000 + m * 60_000 + sec * 1_000 + millis)
}

fn ms_to_stamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let millis = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02},{millis:03}")
}
