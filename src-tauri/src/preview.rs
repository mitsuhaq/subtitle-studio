//! On-demand preview frame extraction.
//!
//! Pulls a single still image from the *middle* of the source video using the
//! configured FFmpeg, scales it down to ~960 px wide (preview is shown at
//! ~600 px in the UI), and caches the result in `data/cache/`. Cache key is a
//! hash of the absolute path + mtime, so re-encoding the same file produces a
//! fresh frame but unchanged files reuse the cache instantly.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use sha2::{Digest, Sha256};

use crate::paths;
use crate::pipeline::SubtitleStyle;
use crate::settings::SettingsStore;

const CACHE_SUBDIR: &str = "cache";
const PREVIEW_PREFIX: &str = "preview-";
const TARGET_WIDTH: u32 = 960;

fn cache_dir() -> PathBuf {
    paths::data_dir().join(CACHE_SUBDIR)
}

fn cache_key(video: &Path) -> Result<String> {
    let meta = std::fs::metadata(video).context("stat video")?;
    let mtime = meta
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    let mut hash = Sha256::new();
    hash.update(video.as_os_str().to_string_lossy().as_bytes());
    hash.update(mtime.to_le_bytes());
    Ok(hex::encode(hash.finalize())[..16].to_string())
}

/// Returns the absolute path of the cached PNG, generating it if missing.
pub async fn extract(video_path: PathBuf, settings: &SettingsStore) -> Result<PathBuf> {
    if !video_path.exists() {
        bail!("Файл не найден: {}", video_path.display());
    }
    let ffmpeg = settings
        .snapshot()
        .ffmpeg_path
        .ok_or_else(|| anyhow!("FFmpeg не установлен — перейдите во вкладку Setup"))?;

    std::fs::create_dir_all(cache_dir()).ok();
    let key = cache_key(&video_path)?;
    let out = cache_dir().join(format!("{PREVIEW_PREFIX}{key}.png"));
    if out.exists() {
        return Ok(out);
    }

    // Probe duration with a quick `-i` parse (FFmpeg writes "Duration: HH:MM:SS.cc"
    // to stderr). Falls back to `-ss 5` if we can't parse.
    let duration = probe_duration(&ffmpeg, &video_path).await.unwrap_or(0.0);
    let seek = if duration > 1.0 {
        format!("{:.2}", duration / 2.0)
    } else {
        "0".into()
    };

    // FFmpeg sniffs the format from the extension — `.png.tmp` confuses it.
    // Use a sibling name with no double-extension and force the muxer/codec
    // explicitly so the suffix becomes irrelevant.
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = cache_dir().join(format!("{PREVIEW_PREFIX}{key}-{nonce}.png"));
    let status = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        // -ss BEFORE -i is fast (keyframe seek) — good enough for a preview.
        .arg("-ss")
        .arg(&seek)
        .arg("-i")
        .arg(&video_path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={TARGET_WIDTH}:-2:flags=fast_bilinear"),
            "-f",
            "image2",
            "-c:v",
            "png",
        ])
        .arg(&tmp)
        .status()
        .await
        .context("ffmpeg preview spawn failed")?;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        bail!("ffmpeg preview exit {status}");
    }
    std::fs::rename(&tmp, &out).context("rename preview")?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Styled preview — burns a tiny ASS onto the extracted still so the rendered
// text is *exactly* what the final video will look like (libass-rendered, not
// a CSS approximation). Cached by (video, style, text).
// ---------------------------------------------------------------------------

const STYLED_PREFIX: &str = "styled-";

fn styled_cache_key(video_key: &str, style: &SubtitleStyle, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(video_key.as_bytes());
    let style_blob = serde_json::to_vec(style).unwrap_or_default();
    h.update(&style_blob);
    h.update(text.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

pub async fn render_styled(
    video_path: PathBuf,
    style: SubtitleStyle,
    text: String,
    settings: &SettingsStore,
) -> Result<PathBuf> {
    let ffmpeg = settings
        .snapshot()
        .ffmpeg_path
        .ok_or_else(|| anyhow!("FFmpeg не установлен — перейдите во вкладку Setup"))?;

    // 1) Plain frame (cached).
    let frame = extract(video_path.clone(), settings).await?;

    // 1b) Source dimensions — used as PlayResX/Y so the preview burns the
    //     subtitles at the exact same scale as the real burn-in pipeline
    //     does (libass uses these for font/margin sizing). Without this
    //     the preview was at 1920x1080 and a 9:16 source ended up showing
    //     text 1.5–1.8× larger than what the actual .mp4 contained.
    let play_res = probe_video_dimensions(&ffmpeg, &video_path)
        .await
        .unwrap_or((1920, 1080));

    // 2) Cache key includes style + text so any tweak misses the cache and
    //    re-renders, but identical lookups are instant.
    let video_key = cache_key(&video_path)?;
    let key = styled_cache_key(&video_key, &style, &text);
    let out = cache_dir().join(format!("{STYLED_PREFIX}{key}.png"));
    if out.exists() {
        return Ok(out);
    }

    // 3) Write the test ASS into a temp file with an FFmpeg-safe path.
    //    The `subtitles=` filter parses the path itself, so spaces/colons
    //    would otherwise break it.
    let safe_dir = std::env::temp_dir().join("subtitle-studio-preview");
    tokio::fs::create_dir_all(&safe_dir).await.ok();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ass_path = safe_dir.join(format!("preview-{nonce}.ass"));
    let ass = build_test_ass(&style, &text, play_res.0, play_res.1);
    tokio::fs::write(&ass_path, ass.as_bytes())
        .await
        .context("write test ass")?;

    // 4) Apply ASS to the frame.
    let tmp = cache_dir().join(format!("{STYLED_PREFIX}{key}-{nonce}.png"));
    let ass_str = ass_path
        .to_str()
        .ok_or_else(|| anyhow!("non-utf8 ass path"))?
        .to_string();
    let filter = format!("subtitles={ass_str}");
    let status = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&frame)
        .args(["-vf", &filter, "-frames:v", "1", "-f", "image2", "-c:v", "png"])
        .arg(&tmp)
        .status()
        .await
        .context("ffmpeg styled-preview spawn failed")?;

    let _ = tokio::fs::remove_file(&ass_path).await;

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        bail!("ffmpeg styled-preview exit {status}");
    }
    std::fs::rename(&tmp, &out).context("rename styled preview")?;
    Ok(out)
}

/// Mini ASS file with a single `Dialogue` line for the test text. Mirrors
/// `python-sidecar/worker/ass_writer.py` — keep both in sync when changing
/// style fields. Returns raw ASS contents.
fn build_test_ass(s: &SubtitleStyle, text: &str, play_w: u32, play_h: u32) -> String {
    let primary = hex_to_ass_color(&s.primary_color, 100);
    let bold = if s.bold { -1 } else { 0 };
    let italic = if s.italic { -1 } else { 0 };
    let border_outline = if s.border_style == 3 {
        s.bg_padding
    } else {
        s.outline_width
    };
    // Force MarginL/R = 0 for horizontally-centered alignments — libass
    // sometimes off-centers when those equal values are non-zero.
    let is_h_center = matches!(s.alignment, 2 | 5 | 8);
    let eff_ml = if is_h_center { 0 } else { s.margin_l };
    let eff_mr = if is_h_center { 0 } else { s.margin_r };
    // libass opaque-box (BorderStyle=3) renders the background using
    // OutlineColour. Alpha on the box is unreliable across libass builds —
    // we tested and it didn't work, so the box is always 100% opaque and
    // `back_alpha` is ignored in this mode.
    let (outline, back) = if s.border_style == 3 {
        (
            hex_to_ass_color(&s.back_color, 100),
            hex_to_ass_color(&s.back_color, 100),
        )
    } else {
        (
            hex_to_ass_color(&s.outline_color, 100),
            hex_to_ass_color(&s.back_color, s.back_alpha as u32),
        )
    };
    // Escape any literal `{`/`}` in the user text so libass doesn't treat it
    // as an override block.
    let safe_text = text.replace('\n', " ").replace('{', "(").replace('}', ")");

    format!(
        "[Script Info]\n\
ScriptType: v4.00+\n\
PlayResX: {play_w}\n\
PlayResY: {play_h}\n\
WrapStyle: 2\n\
ScaledBorderAndShadow: yes\n\
YCbCr Matrix: TV.709\n\n\
[V4+ Styles]\n\
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
Style: Default,{font},{size},{primary},&H00000000,{outline},{back},{bold},{italic},0,0,100,100,0,0,{border},{outline_w},{shadow},{align},{ml},{mr},{mv},1\n\n\
[Events]\n\
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{{\\an{align}}}{text}\n",
        font = s.font_family,
        size = s.font_size,
        primary = primary,
        outline = outline,
        back = back,
        bold = bold,
        italic = italic,
        border = s.border_style,
        outline_w = border_outline,
        shadow = s.shadow_offset,
        align = s.alignment,
        ml = eff_ml,
        mr = eff_mr,
        mv = s.margin_v,
        text = safe_text,
        play_w = play_w,
        play_h = play_h,
    )
}

fn hex_to_ass_color(hex: &str, alpha_pct: u32) -> String {
    let h = hex.trim_start_matches('#');
    let bytes: [u8; 3] = if h.len() == 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(255);
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(255);
        [r, g, b]
    } else {
        [255, 255, 255]
    };
    let alpha_pct = alpha_pct.min(100);
    let a = ((100 - alpha_pct) as f32 * 2.55).round() as u32;
    format!("&H{:02X}{:02X}{:02X}{:02X}", a, bytes[2], bytes[1], bytes[0])
}

/// Public re-export so other modules (re-burn flow) can probe durations
/// without dragging in ffprobe.
pub async fn probe_duration_public(ffmpeg: &Path, video: &Path) -> Option<f32> {
    probe_duration(ffmpeg, video).await
}

/// Probe display `WIDTH × HEIGHT` of the first video stream by parsing
/// FFmpeg's stderr. Storage dimensions come straight from the
/// `Stream #0:0 ... NNNxMMM` line; we then look for a `displaymatrix:
/// rotation of X degrees` block (iPhone et al. encode portrait shots as
/// landscape + 90° rotation tag) and swap if rotation is ±90°/±270° so
/// the caller gets *display* dimensions, which is what libass expects
/// for PlayResX/Y.
pub async fn probe_video_dimensions(ffmpeg: &Path, video: &Path) -> Option<(u32, u32)> {
    let out = tokio::process::Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(video)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    let txt = String::from_utf8_lossy(&out.stderr);

    let mut storage: Option<(u32, u32)> = None;
    let mut rotation_deg: Option<i32> = None;

    for line in txt.lines() {
        let lower = line.to_ascii_lowercase();
        if storage.is_none() && lower.contains("video:") {
            for tok in line.split_whitespace() {
                let t = tok.trim_end_matches(',').trim_end_matches(';');
                if let Some((w, h)) = t.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        // Avoid false positives like "yuv420p" — both sides
                        // should be sane video dimensions.
                        if w >= 64 && h >= 64 && w <= 16384 && h <= 16384 {
                            storage = Some((w, h));
                            break;
                        }
                    }
                }
            }
        }
        // FFmpeg prints e.g. "      displaymatrix: rotation of -90.00 degrees"
        if rotation_deg.is_none() && lower.contains("rotation of") {
            // Take the number right after "of"
            if let Some(after) = lower.split("rotation of").nth(1) {
                let raw = after.trim().split_whitespace().next().unwrap_or("0");
                if let Ok(deg) = raw.parse::<f32>() {
                    rotation_deg = Some(deg.round() as i32);
                }
            }
        }
    }

    let (w, h) = storage?;
    let rot = rotation_deg.unwrap_or(0).rem_euclid(360);
    if rot == 90 || rot == 270 {
        Some((h, w))
    } else {
        Some((w, h))
    }
}

async fn probe_duration(ffmpeg: &Path, video: &Path) -> Option<f32> {
    let out = tokio::process::Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(video)
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    let txt = String::from_utf8_lossy(&out.stderr);
    // "  Duration: 00:01:23.45, start: ..."
    let idx = txt.find("Duration:")?;
    let rest = &txt[idx + "Duration:".len()..];
    let comma = rest.find(',')?;
    let stamp = rest[..comma].trim();
    let mut parts = stamp.splitn(3, ':');
    let h: f32 = parts.next()?.trim().parse().ok()?;
    let m: f32 = parts.next()?.trim().parse().ok()?;
    let s: f32 = parts.next()?.trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}
