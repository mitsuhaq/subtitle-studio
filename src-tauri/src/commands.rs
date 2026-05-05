use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::paths;
use crate::pipeline::{self, SubtitleStyle, TranscribeOptions, TranscribeResult};
use crate::presets::{self, Preset};
use crate::settings::{Settings, SettingsStore};
use crate::setup::{self, ComponentStatus, DownloadFlags, ExtraComponentDef, SetupStatus};
use crate::sidecar::SidecarState;
use crate::srt_io::{self, SrtCue};

// ---------------------------------------------------------------------------
// Tiny diagnostics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn data_dir() -> String {
    paths::data_dir().display().to_string()
}

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

/// Probe a video/audio file's duration in seconds via ffmpeg. Used by the
/// Utils trim slider and the Audio Fix module — front-end's `<video src=
/// "asset://...">` approach proved fragile (pathnames with spaces, audio-
/// only files), and routing through the same ffmpeg the rest of the app
/// already uses is platform-neutral and consistent.
#[tauri::command]
pub async fn probe_video_duration(
    video_path: PathBuf,
    settings: State<'_, SettingsStore>,
) -> Result<f32, String> {
    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap
        .ffmpeg_path
        .clone()
        .ok_or_else(|| "FFmpeg не установлен — Setup".to_string())?;
    crate::preview::probe_duration_public(&ffmpeg, &video_path)
        .await
        .ok_or_else(|| "Не удалось прочитать длительность".to_string())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(settings: State<'_, SettingsStore>) -> Settings {
    settings.snapshot()
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn setup_status(settings: State<'_, SettingsStore>) -> SetupStatus {
    setup::current_status(&settings)
}

#[tauri::command]
pub async fn download_whisper<R: Runtime>(
    app: AppHandle<R>,
    flags: State<'_, DownloadFlags>,
    settings: State<'_, SettingsStore>,
) -> Result<SetupStatus, String> {
    let cancel = flags.whisper.clone();
    let settings = settings.inner().clone();
    setup::download_whisper(app, cancel, settings)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn download_ffmpeg<R: Runtime>(
    app: AppHandle<R>,
    flags: State<'_, DownloadFlags>,
    settings: State<'_, SettingsStore>,
) -> Result<SetupStatus, String> {
    let cancel = flags.ffmpeg.clone();
    let settings = settings.inner().clone();
    setup::download_ffmpeg(app, cancel, settings)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn cancel_download(component: String, flags: State<'_, DownloadFlags>) -> Result<(), String> {
    match setup::select_flag(&flags, &component) {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            Ok(())
        }
        None => Err(format!("Неизвестный компонент: {component}")),
    }
}

#[tauri::command]
pub fn list_extras() -> Vec<ExtraComponentDef> {
    setup::EXTRAS.to_vec()
}

#[tauri::command]
pub fn extra_status(id: String) -> ComponentStatus {
    setup::extra_status(&id)
}

#[tauri::command]
pub async fn download_extra<R: Runtime>(
    app: AppHandle<R>,
    flags: State<'_, DownloadFlags>,
    id: String,
) -> Result<ComponentStatus, String> {
    let cancel = flags.extra(&id);
    setup::download_extra(app, cancel, id)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn cancel_extra(id: String, flags: State<'_, DownloadFlags>) -> Result<(), String> {
    flags.extra(&id).store(true, Ordering::SeqCst);
    Ok(())
}

// ---------------------------------------------------------------------------
// CorridorKey (chroma key) — placeholder pipeline. Real RVM-powered run
// will replace the body once the Python sidecar grows an /chroma-key
// endpoint. Right now this just sleeps + emits fake progress so the UI
// can be wired end-to-end.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ChromaOptions {
    /// "transparent" | "color" | "image" | "video"
    pub background_kind: String,
    /// hex `#RRGGBB` when background_kind == "color".
    pub background_color: Option<String>,
    /// path to bg image/video when applicable.
    pub background_path: Option<PathBuf>,
    /// `"chroma_key"` (default — green-screen footage, runs aggressive
    /// chromakey preprocess + green-spill removal) or `"rotobrush"`
    /// (arbitrary background — pure RVM matting, no colour clamping).
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ChromaResult {
    pub output_video: PathBuf,
}

// ---------------------------------------------------------------------------
// Utils module — pure-FFmpeg trim / convert / overlay. Each command spawns a
// single FFmpeg process and streams `out_time_us` progress over a unique
// event channel so the UI can render its own bar.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct TrimOptions {
    /// In seconds. `null` = from the start.
    pub start: Option<f32>,
    /// In seconds. `null` = to the end.
    pub end: Option<f32>,
}

#[derive(serde::Serialize)]
pub struct UtilResult {
    pub output_path: PathBuf,
}

static UTILS_CANCEL: once_cell::sync::Lazy<std::sync::Mutex<Option<u32>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[tauri::command]
pub fn utils_cancel() {
    if let Ok(g) = UTILS_CANCEL.lock() {
        if let Some(pid) = *g {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

async fn run_ffmpeg<R: Runtime>(
    app: &AppHandle<R>,
    ffmpeg: &std::path::Path,
    args: &[&std::ffi::OsStr],
    total_seconds: f32,
    event_channel: &str,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    let mut child = tokio::process::Command::new(ffmpeg)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    if let Some(pid) = child.id() {
        if let Ok(mut g) = UTILS_CANCEL.lock() {
            *g = Some(pid);
        }
    }

    let stderr = child.stderr.take().ok_or("no stderr".to_string())?;
    let app_progress = app.clone();
    let channel_owned = event_channel.to_string();
    let progress_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = rest.trim().parse::<i64>() {
                    let pos = (us as f32) / 1_000_000.0;
                    let _ = app_progress.emit(
                        &channel_owned,
                        serde_json::json!({
                            "stage": "Кодирование",
                            "pos": pos,
                            "total": total_seconds,
                        }),
                    );
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = progress_task.await;
    if let Ok(mut g) = UTILS_CANCEL.lock() {
        *g = None;
    }

    if !status.success() {
        if status.code() == Some(255) || status.code().is_none() {
            return Err("Прервано".to_string());
        }
        return Err(format!("ffmpeg exit {status}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn util_trim<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    options: TrimOptions,
    settings: State<'_, SettingsStore>,
) -> Result<UtilResult, String> {
    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap.ffmpeg_path.clone().ok_or_else(|| "FFmpeg не установлен".to_string())?;

    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = video_path.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
    let out_dir = settings
        .module_output_dir("utils")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out = out_dir.join(format!("{stem}_trim.{ext}"));

    // Compute duration for progress total.
    let full_duration = crate::preview::probe_duration_public(&ffmpeg, &video_path).await.unwrap_or(0.0);
    let start = options.start.unwrap_or(0.0).max(0.0);
    let end = options.end.unwrap_or(full_duration);
    let total = (end - start).max(0.1);

    // -ss before -i = fast keyframe seek; -to is absolute end timestamp.
    let start_str = format!("{start:.3}");
    let end_str = format!("{end:.3}");
    let args: Vec<&std::ffi::OsStr> = vec![
        "-y".as_ref(),
        "-hide_banner".as_ref(),
        "-loglevel".as_ref(),
        "error".as_ref(),
        "-ss".as_ref(),
        start_str.as_ref(),
        "-to".as_ref(),
        end_str.as_ref(),
        "-i".as_ref(),
        video_path.as_os_str(),
        "-c".as_ref(),
        "copy".as_ref(),
        "-progress".as_ref(),
        "pipe:2".as_ref(),
        out.as_os_str(),
    ];

    run_ffmpeg(&app, &ffmpeg, &args, total, "utils://progress").await?;
    Ok(UtilResult { output_path: out })
}

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ConvertOptions {
    /// Target extension WITHOUT dot: "mp4" | "mov" | "webm" | "mkv" | "gif" | "mp3" | "wav" | "aac" | "m4a"
    pub target: String,
}

#[tauri::command]
pub async fn util_convert<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    options: ConvertOptions,
    settings: State<'_, SettingsStore>,
) -> Result<UtilResult, String> {
    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap.ffmpeg_path.clone().ok_or_else(|| "FFmpeg не установлен".to_string())?;

    let target = options.target.to_lowercase();
    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let out_dir = settings
        .module_output_dir("utils")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out = out_dir.join(format!("{stem}_converted.{target}"));

    let full_duration = crate::preview::probe_duration_public(&ffmpeg, &video_path).await.unwrap_or(0.0);

    // Codec choice per target. Audio-only formats strip the video stream.
    let codec_args: Vec<&'static str> = match target.as_str() {
        "mp4" => vec!["-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p"],
        "mov" => vec!["-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p"],
        "webm" => vec!["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus", "-b:a", "128k"],
        "mkv" => vec!["-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "192k"],
        "gif" => vec!["-vf", "fps=12,scale=720:-2:flags=lanczos", "-loop", "0", "-an"],
        "mp3" => vec!["-vn", "-c:a", "libmp3lame", "-b:a", "192k"],
        "wav" => vec!["-vn", "-c:a", "pcm_s16le"],
        "aac" => vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        "m4a" => vec!["-vn", "-c:a", "aac", "-b:a", "192k"],
        other => return Err(format!("Неизвестный формат: {other}")),
    };

    let mut args: Vec<&std::ffi::OsStr> = vec![
        "-y".as_ref(),
        "-hide_banner".as_ref(),
        "-loglevel".as_ref(),
        "error".as_ref(),
        "-i".as_ref(),
        video_path.as_os_str(),
    ];
    for a in &codec_args {
        args.push((*a).as_ref());
    }
    args.push("-progress".as_ref());
    args.push("pipe:2".as_ref());
    args.push(out.as_os_str());

    run_ffmpeg(&app, &ffmpeg, &args, full_duration, "utils://progress").await?;
    Ok(UtilResult { output_path: out })
}

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct OverlayOptions {
    pub overlay_path: PathBuf,
}

#[tauri::command]
pub async fn util_overlay<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    options: OverlayOptions,
    settings: State<'_, SettingsStore>,
) -> Result<UtilResult, String> {
    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    if !options.overlay_path.exists() {
        return Err(format!("Картинка не найдена: {}", options.overlay_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap.ffmpeg_path.clone().ok_or_else(|| "FFmpeg не установлен".to_string())?;

    let stem = video_path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = video_path.extension().and_then(|s| s.to_str()).unwrap_or("mp4");
    let out_dir = settings
        .module_output_dir("utils")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out = out_dir.join(format!("{stem}_overlay.{ext}"));

    let full_duration = crate::preview::probe_duration_public(&ffmpeg, &video_path).await.unwrap_or(0.0);

    // Scale the overlay to match the video's resolution, then overlay at 0,0.
    // `[1:v]scale2ref[ovr][base];[base][ovr]overlay=0:0` uses the video as
    // the reference for the overlay's target size — same dimensions every
    // time regardless of the source PNG's intrinsic size.
    let filter = "[1:v][0:v]scale2ref=w=iw:h=ih[ovr][base];[base][ovr]overlay=0:0";
    let args: Vec<&std::ffi::OsStr> = vec![
        "-y".as_ref(),
        "-hide_banner".as_ref(),
        "-loglevel".as_ref(),
        "error".as_ref(),
        "-i".as_ref(),
        video_path.as_os_str(),
        "-i".as_ref(),
        options.overlay_path.as_os_str(),
        "-filter_complex".as_ref(),
        filter.as_ref(),
        "-c:v".as_ref(),
        "libx264".as_ref(),
        "-crf".as_ref(),
        "18".as_ref(),
        "-preset".as_ref(),
        "medium".as_ref(),
        "-pix_fmt".as_ref(),
        "yuv420p".as_ref(),
        "-c:a".as_ref(),
        "copy".as_ref(),
        "-progress".as_ref(),
        "pipe:2".as_ref(),
        out.as_os_str(),
    ];

    run_ffmpeg(&app, &ffmpeg, &args, full_duration, "utils://progress").await?;
    Ok(UtilResult { output_path: out })
}

// ---------------------------------------------------------------------------
// Audio Fix module — pure FFmpeg pipeline. RNNoise via the `arnndn` filter
// for noise suppression + 2-pass peak normalization (astats → volume) for
// level normalization. We chose peak dBFS (not loudnorm/LUFS) so the dial
// matches what After Effects, Premiere, and Audition show — same -6 dB in
// our app == -6 dB peak in those tools, no mental conversion needed.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct AudioFixOptions {
    pub denoise: bool,
    /// Whether to renormalize peak level to `target_db_peak`.
    pub loudnorm: bool,
    /// Target peak in dBFS (-30..0). Common values: -3 (online), -1 (broadcast safety).
    /// Field stays named `target_lufs` for backwards-compat in saved settings,
    /// even though the unit is now peak dBFS.
    pub target_lufs: f32,

    /// Bundled ambient preset id ("room_tone" / "pink_room" / "white_air" /
    /// "ac_hum" / "distant_rumble") to mix under the dialogue. Mutually
    /// exclusive with `ambient_custom_path` — UI sends one or neither.
    #[serde(default)]
    pub ambient_preset: Option<String>,
    /// User-supplied ambient track (any audio/video file ffmpeg can read).
    #[serde(default)]
    pub ambient_custom_path: Option<PathBuf>,
    /// Ambient gain in dB (typical -30..-10). Ignored if no ambient source.
    #[serde(default = "default_ambient_db")]
    pub ambient_level_db: f32,

    /// Bundled IR preset id for room reverb ("studio" / "stage" / "hall" /
    /// "cathedral"). `None` = no reverb.
    #[serde(default)]
    pub room_preset: Option<String>,
    /// Wet/dry mix in percent (0 = bypass, 100 = full reverb). 25-40 is
    /// usually pleasant for speech.
    #[serde(default = "default_room_wet")]
    pub room_wet_pct: f32,

    /// Vocal isolation via mid/side processing. None = passthrough,
    /// "extract" = collapse to the center channel (vocal + anything panned
    /// dead-center), "remove" = subtract the center for a karaoke mix.
    /// Works on radio-style stereo mixes; songs with hard-panned vocals or
    /// stereo doubling won't separate cleanly — that's the trade-off of
    /// skipping a neural-network demixer.
    #[serde(default)]
    pub vocal_mode: Option<String>,
}

fn default_ambient_db() -> f32 {
    -20.0
}
fn default_room_wet() -> f32 {
    30.0
}

#[derive(serde::Serialize)]
pub struct AudioFixResult {
    pub output_video: PathBuf,
}

/// Single shared cancellation flag for the audio-fix FFmpeg child. We don't
/// need per-job because the UI only allows one job at a time.
static AUDIO_FIX_CANCEL: once_cell::sync::Lazy<
    std::sync::Mutex<Option<u32>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[tauri::command]
pub fn audio_fix_cancel() {
    if let Ok(guard) = AUDIO_FIX_CANCEL.lock() {
        if let Some(pid) = *guard {
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .status();
        }
    }
}

#[tauri::command]
pub async fn audio_fix_run<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    options: AudioFixOptions,
    settings: State<'_, SettingsStore>,
) -> Result<AudioFixResult, String> {
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncBufReadExt;

    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap
        .ffmpeg_path
        .clone()
        .ok_or_else(|| "FFmpeg не установлен — Setup".to_string())?;

    // ---- Resolve optional auxiliary inputs (ambient, IR) -----------------
    // Each tuple is (label, path) — ffmpeg gets these as additional `-i`s
    // and we wire them into the filter graph by index.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    let mut extra_inputs: Vec<PathBuf> = Vec::new();

    let ambient_path = if let Some(custom) = options.ambient_custom_path.clone() {
        if !custom.exists() {
            return Err(format!("Ambient-файл не найден: {}", custom.display()));
        }
        Some(custom)
    } else if let Some(preset) = options.ambient_preset.as_deref() {
        let p = resource_dir
            .join("assets")
            .join("ambient")
            .join(format!("{preset}.opus"));
        if !p.exists() {
            return Err(format!("Ambient-пресет '{preset}' не найден в бандле"));
        }
        Some(p)
    } else {
        None
    };
    let ambient_input_idx = ambient_path.as_ref().map(|p| {
        extra_inputs.push(p.clone());
        // First aux input is index 1 (main video is 0), so 1 + (extra_inputs.len() - 1).
        extra_inputs.len()
    });

    let room_path = if let Some(preset) = options.room_preset.as_deref() {
        let p = resource_dir
            .join("assets")
            .join("ir")
            .join(format!("{preset}.wav"));
        if !p.exists() {
            return Err(format!("Room-пресет '{preset}' не найден в бандле"));
        }
        Some(p)
    } else {
        None
    };
    let room_input_idx = room_path.as_ref().map(|p| {
        extra_inputs.push(p.clone());
        extra_inputs.len()
    });

    // ---- Build the filter graph -----------------------------------------
    // The cheap path (no ambient, no room) stays on the simple `-af` chain;
    // anything with extra inputs goes through `-filter_complex`.
    let mut chain: Vec<String> = Vec::new();

    // Vocal-isolation goes *first*. After mid/side the channel layout is
    // mono (extract) or stays stereo (remove); subsequent filters all
    // accept either, so order doesn't matter beyond that — but doing this
    // up front keeps the karaoke output clean of denoiser artefacts that
    // would otherwise be amplified when we cancel the center channel.
    match options.vocal_mode.as_deref() {
        Some("extract") => {
            // Sum L+R into a mono center, then high-pass at 80 Hz to drop
            // the bass rumble that was usually mixed mono *anyway* and
            // would otherwise dominate the isolated vocal.
            chain.push("pan=mono|c0=0.5*c0+0.5*c1,highpass=f=80".into());
        }
        Some("remove") => {
            // Classic karaoke trick: invert one side of the stereo image
            // against the other so anything dead-center cancels out.
            chain.push("pan=stereo|c0=c0-c1|c1=c1-c0".into());
        }
        _ => {}
    }

    if options.denoise {
        let model = setup::extra_dest("rnnoise_model").ok_or_else(|| {
            "Не нашёл путь к модели RNNoise".to_string()
        })?;
        if !model.exists() {
            return Err(
                "Модель RNNoise не установлена — поставьте её в Setup.".to_string(),
            );
        }
        let path_safe = model.to_string_lossy().replace('\'', "\\'");
        chain.push(format!("arnndn=m='{path_safe}'"));
    }
    if options.loudnorm {
        let target = options.target_lufs.clamp(-30.0, 0.0);
        let measured = measure_peak_dbfs(&ffmpeg, &video_path)
            .await
            .map_err(|e| format!("не удалось измерить пик: {e}"))?;
        let gain = target - measured;
        log::info!(
            "audio_fix peak normalize: measured={measured:.2} dBFS, target={target:.2} dBFS, gain={gain:+.2} dB"
        );
        chain.push(format!("volume={gain:.2}dB"));
    }

    let vocal_active = matches!(
        options.vocal_mode.as_deref(),
        Some("extract") | Some("remove")
    );
    let any_op = options.denoise
        || options.loudnorm
        || ambient_input_idx.is_some()
        || room_input_idx.is_some()
        || vocal_active;
    if !any_op {
        return Err("Включите хотя бы одну операцию.".to_string());
    }

    // Output: per-module override → otherwise next to source.
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let in_ext = video_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4")
        .to_ascii_lowercase();
    // Audio-only inputs (mp3, wav, m4a, etc.) need different output codecs
    // than video — `-c:v copy` is harmless when there's no video stream, but
    // pairing `-c:a aac` with an `.mp3` extension produces a broken file
    // because the MP3 container can't carry AAC. Pick the right codec/ext
    // based on what we got in.
    let is_audio_only = matches!(
        in_ext.as_str(),
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "opus" | "flac" | "wma"
    );
    let out_ext = if is_audio_only {
        match in_ext.as_str() {
            "wav" => "wav",
            "flac" => "flac",
            "ogg" | "opus" => "opus",
            // mp3/aac/m4a/wma all happily live in an .m4a container with AAC.
            _ => "m4a",
        }
    } else {
        in_ext.as_str()
    };
    let out_dir = settings
        .module_output_dir("audio_fix")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out_path = out_dir.join(format!("{stem}_audio.{out_ext}"));

    // FFmpeg duration for progress total (ms).
    let total_ms = crate::preview::probe_duration_public(&ffmpeg, &video_path)
        .await
        .map(|s| (s * 1000.0) as i64)
        .unwrap_or(0);

    let _ = app.emit(
        "audio_fix://progress",
        serde_json::json!({ "stage": "Кодирование", "pos": 0.0, "total": total_ms as f64 / 1000.0 }),
    );

    // ---- Compose ffmpeg invocation --------------------------------------
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&video_path);
    for p in &extra_inputs {
        cmd.arg("-i").arg(p);
    }

    if extra_inputs.is_empty() {
        // Simple path: single audio chain via -af.
        cmd.args(["-af", &chain.join(",")]);
    } else {
        // Complex path: build a filter_complex that:
        //   a) runs the dialogue chain on [0:a]               → [a0]
        //   b) loops the ambient and trims to total length    → [amb]
        //   c) amix's [a0] + [amb] (if ambient is present)    → [mix]
        //   d) feeds [mix] (or [a0]) + [ir:a] into afir       → [out]
        let dur_s = (total_ms as f32 / 1000.0).max(0.1);
        let mut graph: Vec<String> = Vec::new();

        // Stage A — dialogue chain. If empty, just relabel.
        let dialogue_chain = if chain.is_empty() {
            "anull".to_string()
        } else {
            chain.join(",")
        };
        graph.push(format!("[0:a]{dialogue_chain}[a0]"));

        // Stage B+C — ambient mix. amix=duration=first keeps the dialogue
        // length authoritative even though the ambient is looped longer.
        let mut last_label = "a0".to_string();
        if let Some(idx) = ambient_input_idx {
            let amb_db = options.ambient_level_db.clamp(-50.0, 6.0);
            // aloop with size in samples — pick a value larger than any
            // sane video (1e9 samples ≈ 6 hours at 48 kHz).
            graph.push(format!(
                "[{idx}:a]aloop=loop=-1:size=999999999,atrim=0:{dur_s},asetpts=N/SR/TB,volume={amb_db:.2}dB[amb]"
            ));
            graph.push(format!(
                "[{last_label}][amb]amix=inputs=2:duration=first:dropout_transition=0,volume=2.0[mix]"
            ));
            last_label = "mix".to_string();
        }

        // Stage D — convolution reverb via afir. `dry` and `wet` are the
        // linear gains for the dry vs convolved signal (default 1.0 each).
        // We model the wet/dry slider as a true crossfade — 0% = pure dry,
        // 100% = pure wet — so the sum stays close to unity gain. The
        // earlier formula (/10) was attenuating the dry signal so much that
        // even a 30 % mix sounded like the voice had been muted.
        if let Some(idx) = room_input_idx {
            let wet_norm = options.room_wet_pct.clamp(0.0, 100.0) / 100.0;
            let dry_norm = (1.0 - wet_norm).max(0.0);
            graph.push(format!(
                "[{last_label}][{idx}:a]afir=dry={dry_norm:.3}:wet={wet_norm:.3}:length=1:irnorm=-1[out]"
            ));
            last_label = "out".to_string();
        }

        let filter_complex = graph.join(";");
        log::info!("audio_fix filter_complex: {filter_complex}");
        cmd.args(["-filter_complex", &filter_complex, "-map", "0:v?", "-map", &format!("[{last_label}]")]);
    }

    if is_audio_only {
        // Audio-only path — no video stream to copy, just transcode audio
        // into whatever the chosen `out_ext` container natively prefers.
        let codec_args: &[&str] = match out_ext {
            "wav" => &["-vn", "-c:a", "pcm_s16le"],
            "flac" => &["-vn", "-c:a", "flac"],
            "opus" => &["-vn", "-c:a", "libopus", "-b:a", "192k"],
            // m4a / aac default
            _ => &["-vn", "-c:a", "aac", "-b:a", "192k"],
        };
        cmd.args(codec_args);
    } else {
        cmd.args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"]);
    }
    cmd.args(["-progress", "pipe:2"])
        .arg(&out_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    if let Some(pid) = child.id() {
        if let Ok(mut g) = AUDIO_FIX_CANCEL.lock() {
            *g = Some(pid);
        }
    }

    // Drain stderr for `out_time_us=...` progress markers.
    let stderr = child.stderr.take().ok_or("no stderr".to_string())?;
    let app_progress = app.clone();
    let progress_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = rest.trim().parse::<i64>() {
                    let pos = (us as f32) / 1_000_000.0;
                    let total = total_ms as f32 / 1000.0;
                    let _ = app_progress.emit(
                        "audio_fix://progress",
                        serde_json::json!({
                            "stage": "Обработка аудио",
                            "pos": pos,
                            "total": total,
                        }),
                    );
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = progress_task.await;
    if let Ok(mut g) = AUDIO_FIX_CANCEL.lock() {
        *g = None;
    }

    if !status.success() {
        // Code 137/SIGTERM means we killed it — surface as cancel.
        if status.code() == Some(255) || status.code().is_none() {
            return Err("Прервано".to_string());
        }
        return Err(format!("ffmpeg exit {status}"));
    }

    let _ = app.emit(
        "audio_fix://progress",
        serde_json::json!({ "stage": "Готово", "pos": 1.0, "total": 1.0 }),
    );
    Ok(AudioFixResult { output_video: out_path })
}

#[tauri::command]
pub async fn chroma_key_cancel<R: Runtime>(app: AppHandle<R>) {
    use tauri::Manager;
    let port = app
        .state::<SidecarState>()
        .info
        .lock()
        .as_ref()
        .map(|i| i.port);
    if let Some(port) = port {
        let url = format!("http://127.0.0.1:{port}/cancel");
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::new();
            let _ = client.post(&url).send().await;
        });
    }
}

#[tauri::command]
pub async fn chroma_key_run<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    options: ChromaOptions,
) -> Result<ChromaResult, String> {
    use futures_util::StreamExt;
    use tauri::{Emitter, Manager};

    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }

    // Prefer the higher-quality ResNet50 weights when both are installed.
    let model_path = ["rvm_hd", "rvm"]
        .iter()
        .filter_map(|id| setup::extra_dest(id))
        .find(|p| p.exists())
        .ok_or_else(|| {
            "Модель RVM не установлена — поставьте её в Setup.".to_string()
        })?;

    let port = app
        .state::<SidecarState>()
        .info
        .lock()
        .as_ref()
        .map(|i| i.port)
        .ok_or_else(|| "Python sidecar ещё не готов — попробуйте через секунду".to_string())?;

    // Output: per-module override → otherwise next to source. ".mov" for
    // transparent (ProRes 4444 with alpha), ".mp4" for everything else.
    let module_id = if options
        .mode
        .as_deref()
        .map(|m| m == "rotobrush")
        .unwrap_or(false)
    {
        "rotobrush"
    } else {
        "corridor_key"
    };
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let out_dir = app
        .state::<SettingsStore>()
        .module_output_dir(module_id)
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    if let Err(e) = std::fs::create_dir_all(&out_dir) {
        return Err(format!("Не удалось создать папку: {e}"));
    }
    let out_ext = if options.background_kind == "transparent" {
        "mov"
    } else {
        "mp4"
    };
    let out_path = out_dir.join(format!("{stem}_chroma.{out_ext}"));

    let body = serde_json::json!({
        "model_path": model_path.to_string_lossy(),
        "input_video": video_path.to_string_lossy(),
        "output_video": out_path.to_string_lossy(),
        "background_kind": options.background_kind,
        "background_color": options.background_color,
        "background_path": options.background_path,
        "mode": options.mode.clone().unwrap_or_else(|| "chroma_key".into()),
    });

    let url = format!("http://127.0.0.1:{port}/chroma-key");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 60 * 4))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Sidecar /chroma-key недоступен: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("sidecar /chroma-key → {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut final_output: Option<PathBuf> = None;
    let mut error_msg: Option<String> = None;
    let mut cancelled = false;

    let _ = app.emit(
        "chroma://progress",
        serde_json::json!({ "stage": "Подготовка", "pos": 0.0, "total": 0.0 }),
    );

    loop {
        let chunk = match stream.next().await {
            Some(c) => c.map_err(|e| format!("SSE chunk read failed: {e}"))?,
            None => break,
        };
        buf.extend_from_slice(&chunk);

        while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
            let event_bytes = buf.drain(..pos + 2).collect::<Vec<_>>();
            let line = match std::str::from_utf8(&event_bytes) {
                Ok(s) => s.trim_end(),
                Err(_) => continue,
            };
            let payload = match line.strip_prefix("data: ") {
                Some(p) => p,
                None => continue,
            };
            let event: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let kind = event["type"].as_str().unwrap_or("");
            match kind {
                "progress" => {
                    let p = event["pos"].as_f64().unwrap_or(0.0);
                    let t = event["total"].as_f64().unwrap_or(0.0);
                    let _ = app.emit(
                        "chroma://progress",
                        serde_json::json!({
                            "stage": "Сегментация и композитинг",
                            "pos": p,
                            "total": t,
                        }),
                    );
                }
                "done" => {
                    if let Some(s) = event["output_video"].as_str() {
                        final_output = Some(PathBuf::from(s));
                    }
                }
                "cancelled" => {
                    cancelled = true;
                }
                "error" => {
                    error_msg = Some(
                        event["message"].as_str().unwrap_or("неизвестная ошибка").to_string(),
                    );
                }
                _ => {}
            }
        }
    }

    if let Some(msg) = error_msg {
        return Err(msg);
    }
    if cancelled {
        return Err("Прервано".to_string());
    }
    let output_video = final_output.unwrap_or(out_path);
    let _ = app.emit(
        "chroma://progress",
        serde_json::json!({ "stage": "Готово", "pos": 1.0, "total": 1.0 }),
    );
    Ok(ChromaResult { output_video })
}

#[tauri::command]
pub fn pick_ffmpeg(
    path: PathBuf,
    settings: State<'_, SettingsStore>,
) -> Result<SetupStatus, String> {
    if !path.exists() {
        return Err(format!("Файл не найден: {}", path.display()));
    }
    settings
        .update(|s| s.ffmpeg_path = Some(path.clone()))
        .map_err(|e| format!("Не удалось сохранить настройки: {e}"))?;
    Ok(setup::current_status(&settings))
}

#[derive(Serialize)]
pub struct OpenResult { pub ok: bool }

#[tauri::command]
pub fn open_data_dir<R: Runtime>(app: AppHandle<R>) -> Result<OpenResult, String> {
    let path = paths::data_dir();
    let _ = app; // reserved for future use
    open_in_file_manager(&path).map_err(|e| e.to_string())?;
    Ok(OpenResult { ok: true })
}

/// Show the file in the OS file manager (Finder/Explorer), highlighting it.
/// Different from `open_in_file_manager` which opens a directory directly —
/// this one selects the file inside its parent.
#[tauri::command]
pub fn reveal_in_shell(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Файл не найден: {}", path.display()));
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&path).status();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = {
        // Most Linux file managers don't have a portable "reveal" — fall
        // back to opening the parent directory.
        let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
        std::process::Command::new("xdg-open").arg(parent).status()
    };
    r.map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SidecarStatusInfo {
    pub running: bool,
    pub port: Option<u16>,
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, SidecarState>) -> SidecarStatusInfo {
    match state.info.lock().as_ref() {
        Some(info) => SidecarStatusInfo {
            running: true,
            port: Some(info.port),
        },
        None => SidecarStatusInfo {
            running: false,
            port: None,
        },
    }
}

#[tauri::command]
pub fn default_srt_path(
    video_path: PathBuf,
    settings: State<'_, SettingsStore>,
) -> String {
    let snap = settings.snapshot();
    pipeline::default_srt_path(&video_path, snap.output_dir.as_deref())
        .display()
        .to_string()
}

#[tauri::command]
pub async fn transcribe_video<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    output_srt: PathBuf,
    options: Option<TranscribeOptions>,
) -> Result<TranscribeResult, String> {
    let opts = options.unwrap_or_default();
    pipeline::run(app, video_path, output_srt, opts)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn cancel_transcription<R: Runtime>(app: AppHandle<R>) {
    pipeline::cancel(&app);
}

#[tauri::command]
pub async fn reburn_video<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    srt_path: PathBuf,
    style: SubtitleStyle,
) -> Result<String, String> {
    pipeline::reburn(app, video_path, srt_path, style)
        .await
        .map(|p| p.display().to_string())
        .map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Style presets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_presets() -> Result<Vec<Preset>, String> {
    presets::list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_preset(name: String, style: SubtitleStyle) -> Result<Preset, String> {
    presets::save(name, style).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn delete_preset(name: String) -> Result<(), String> {
    presets::delete(&name).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_last_style(
    style: SubtitleStyle,
    settings: State<'_, SettingsStore>,
) -> Result<(), String> {
    settings
        .update(|s| s.last_style = Some(style))
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
pub fn set_module_output_dir(
    module_id: String,
    path: Option<PathBuf>,
    settings: State<'_, SettingsStore>,
) -> Result<Settings, String> {
    if let Some(p) = path.as_ref() {
        if !p.exists() {
            return Err(format!("Папка не существует: {}", p.display()));
        }
        if !p.is_dir() {
            return Err(format!("Это не папка: {}", p.display()));
        }
    }
    settings
        .update(|s| {
            if let Some(p) = path {
                s.module_output_dirs.insert(module_id, p);
            } else {
                s.module_output_dirs.remove(&module_id);
            }
        })
        .map_err(|e| format!("{e}"))?;
    Ok(settings.snapshot())
}

#[tauri::command]
pub fn set_output_dir(
    path: Option<PathBuf>,
    settings: State<'_, SettingsStore>,
) -> Result<Settings, String> {
    if let Some(p) = path.as_ref() {
        if !p.exists() {
            return Err(format!("Папка не существует: {}", p.display()));
        }
        if !p.is_dir() {
            return Err(format!("Это не папка: {}", p.display()));
        }
    }
    settings
        .update(|s| s.output_dir = path)
        .map_err(|e| format!("{e}"))?;
    Ok(settings.snapshot())
}

// ---------------------------------------------------------------------------
// System fonts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_fonts() -> Vec<String> {
    crate::fonts::list()
}

// ---------------------------------------------------------------------------
// SRT editor
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_srt(path: PathBuf) -> Result<Vec<SrtCue>, String> {
    srt_io::read(&path).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn write_srt(path: PathBuf, cues: Vec<SrtCue>) -> Result<(), String> {
    srt_io::write(&path, &cues).map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Persistent queue
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn load_queue() -> Vec<String> {
    crate::queue::load()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}

#[tauri::command]
pub fn save_queue(paths: Vec<PathBuf>) -> Result<(), String> {
    crate::queue::save(paths).map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn extract_preview_frame(
    video_path: PathBuf,
    settings: State<'_, SettingsStore>,
) -> Result<String, String> {
    let store = settings.inner().clone();
    crate::preview::extract(video_path, &store)
        .await
        .map(|p| p.display().to_string())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn render_styled_preview(
    video_path: PathBuf,
    style: SubtitleStyle,
    text: String,
    settings: State<'_, SettingsStore>,
) -> Result<String, String> {
    let store = settings.inner().clone();
    crate::preview::render_styled(video_path, style, text, &store)
        .await
        .map(|p| p.display().to_string())
        .map_err(|e| format!("{e:#}"))
}

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "avi", "webm", "flv", "m4v"];

#[tauri::command]
pub fn list_videos_in_folder(folder: PathBuf, recursive: bool) -> Result<Vec<PathBuf>, String> {
    if !folder.exists() {
        return Err(format!("Папка не найдена: {}", folder.display()));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    walk(&folder, recursive, &mut out).map_err(|e| e.to_string())?;
    out.sort();
    Ok(out)
}

fn walk(dir: &std::path::Path, recursive: bool, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        // Skip dot-files (macOS .DS_Store, ._sidecar, hidden anything).
        let is_hidden = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(true);
        if is_hidden {
            continue;
        }
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if VIDEO_EXTS.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                    out.push(path);
                }
            }
        } else if path.is_dir() && recursive {
            walk(&path, true, out)?;
        }
    }
    Ok(())
}

fn open_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(path).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).status();
    result.map(|_| ())
}

/// Run ffmpeg with `astats` over the file's audio stream and parse the
/// overall peak level out of stderr. Returns peak in dBFS (always ≤ 0).
///
/// We pipe to a null muxer so the run is decode-only — fast even for
/// hour-long files (no encoding, no disk write). The interesting line
/// looks like `[Parsed_astats_0 @ ...] Peak level dB: -1.205432`.
/// `astats` emits Peak level for each channel and once more in the
/// "Overall" trailer; we keep the *last* match so we get the overall
/// peak across all channels rather than just channel 0.
async fn measure_peak_dbfs(
    ffmpeg: &std::path::Path,
    video: &std::path::Path,
) -> anyhow::Result<f32> {
    use anyhow::{anyhow, Context};
    let out = tokio::process::Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-nostats")
        .arg("-i")
        .arg(video)
        .args([
            "-map", "0:a:0",
            "-af", "astats=measure_overall=Peak_level:measure_perchannel=0",
            "-f", "null",
            "-",
        ])
        .output()
        .await
        .context("spawn ffmpeg astats")?;
    let stderr = String::from_utf8_lossy(&out.stderr);

    let mut last_peak: Option<f32> = None;
    for line in stderr.lines() {
        if let Some(idx) = line.find("Peak level dB:") {
            let rest = line[idx + "Peak level dB:".len()..].trim();
            if let Some(tok) = rest.split_whitespace().next() {
                // ffmpeg writes "-inf" for total silence; treat it as a
                // very low peak so the gain math still produces a sane
                // (though large) volume bump rather than NaN.
                if tok.eq_ignore_ascii_case("-inf") {
                    last_peak = Some(-120.0);
                } else if let Ok(v) = tok.parse::<f32>() {
                    last_peak = Some(v);
                }
            }
        }
    }
    last_peak.ok_or_else(|| {
        anyhow!(
            "не нашёл Peak level в выводе ffmpeg (есть ли вообще аудиодорожка?)\n--- stderr ---\n{}",
            stderr.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
        )
    })
}

// ---------------------------------------------------------------------------
// Logo Remover module — pure FFmpeg `delogo` filter pipeline. The user
// drags a rectangle (or several) on a preview frame; we feed each one as a
// `delogo=x=N:y=N:w=N:h=N` clause into a chained -vf graph. FFmpeg fills
// the rectangle with interpolation from neighbouring pixels — works well
// for static logos / watermarks parked in a corner, much less so for
// moving text in the middle of the frame (that needs ProPainter, which
// we haven't shipped yet).
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
pub struct LogoRegion {
    /// Top-left coordinate in *source video* pixels (not preview pixels).
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(serde::Serialize)]
pub struct LogoResult {
    pub output_video: PathBuf,
}

static LOGO_REMOVER_CANCEL: once_cell::sync::Lazy<
    std::sync::Mutex<Option<u32>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[tauri::command]
pub fn logo_remover_cancel() {
    if let Ok(g) = LOGO_REMOVER_CANCEL.lock() {
        if let Some(pid) = *g {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

#[tauri::command]
pub async fn logo_remover_run<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    regions: Vec<LogoRegion>,
    settings: State<'_, SettingsStore>,
) -> Result<LogoResult, String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    if regions.is_empty() {
        return Err("Не выделено ни одной области для удаления.".to_string());
    }
    let snap = settings.snapshot();
    let ffmpeg = snap
        .ffmpeg_path
        .clone()
        .ok_or_else(|| "FFmpeg не установлен — Setup".to_string())?;

    // Sanity-check region geometry. delogo wants 1×1 minimum and refuses
    // rectangles touching the edge of the frame, so clamp to ≥1px size and
    // skip zero-area boxes the UI may have produced.
    let regions: Vec<LogoRegion> = regions
        .into_iter()
        .filter(|r| r.w >= 1 && r.h >= 1)
        .collect();
    if regions.is_empty() {
        return Err("Все выделенные области пустые — нечего удалять.".to_string());
    }

    let filter = regions
        .iter()
        .map(|r| format!("delogo=x={}:y={}:w={}:h={}", r.x, r.y, r.w, r.h))
        .collect::<Vec<_>>()
        .join(",");
    log::info!("logo_remover vf: {filter}");

    // Output: per-module override → next to source.
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = video_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let out_dir = settings
        .module_output_dir("logo_remover")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out_path = out_dir.join(format!("{stem}_clean.{ext}"));

    let total_ms = crate::preview::probe_duration_public(&ffmpeg, &video_path)
        .await
        .map(|s| (s * 1000.0) as i64)
        .unwrap_or(0);
    let total = total_ms as f32 / 1000.0;

    let _ = app.emit(
        "logo_remover://progress",
        serde_json::json!({ "stage": "Кодирование", "pos": 0.0, "total": total }),
    );

    let mut child = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&video_path)
        .args(["-vf", &filter])
        // Audio passes through untouched — delogo only touches video.
        .args(["-c:a", "copy"])
        .args(["-progress", "pipe:2"])
        .arg(&out_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    if let Some(pid) = child.id() {
        if let Ok(mut g) = LOGO_REMOVER_CANCEL.lock() {
            *g = Some(pid);
        }
    }

    let stderr = child.stderr.take().ok_or("no stderr".to_string())?;
    let app_progress = app.clone();
    let progress_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = rest.trim().parse::<i64>() {
                    let pos = (us as f32) / 1_000_000.0;
                    let _ = app_progress.emit(
                        "logo_remover://progress",
                        serde_json::json!({
                            "stage": "Удаление логотипа",
                            "pos": pos,
                            "total": total,
                        }),
                    );
                }
            } else if line.to_lowercase().contains("error") || line.contains("Invalid") {
                log::warn!("[ffmpeg logo_remover] {line}");
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = progress_task.await;
    if let Ok(mut g) = LOGO_REMOVER_CANCEL.lock() {
        *g = None;
    }

    if !status.success() {
        if status.code() == Some(255) || status.code().is_none() {
            return Err("Прервано".to_string());
        }
        return Err(format!("ffmpeg exit {status}"));
    }

    let _ = app.emit(
        "logo_remover://progress",
        serde_json::json!({ "stage": "Готово", "pos": 1.0, "total": 1.0 }),
    );
    Ok(LogoResult { output_video: out_path })
}

/// Probe video display dimensions (post-rotation). Used by Logo Remover so
/// the canvas overlay can map preview-pixel → source-pixel coordinates
/// without guessing dimensions on the JS side.
#[tauri::command]
pub async fn probe_video_dimensions(
    video_path: PathBuf,
    settings: State<'_, SettingsStore>,
) -> Result<(u32, u32), String> {
    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap
        .ffmpeg_path
        .clone()
        .ok_or_else(|| "FFmpeg не установлен — Setup".to_string())?;
    crate::preview::probe_video_dimensions(&ffmpeg, &video_path)
        .await
        .ok_or_else(|| "Не удалось прочитать размер видео".to_string())
}
