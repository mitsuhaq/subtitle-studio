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
// for noise suppression + EBU R128 `loudnorm` for level normalization. No
// Python sidecar involvement at all.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct AudioFixOptions {
    pub denoise: bool,
    pub loudnorm: bool,
    pub target_lufs: f32, // typical: -16 (streaming), -23 (broadcast)
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
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    if !video_path.exists() {
        return Err(format!("Файл не найден: {}", video_path.display()));
    }
    let snap = settings.snapshot();
    let ffmpeg = snap
        .ffmpeg_path
        .clone()
        .ok_or_else(|| "FFmpeg не установлен — Setup".to_string())?;

    // Build the audio filter chain. Empty = passthrough.
    let mut filters: Vec<String> = Vec::new();
    if options.denoise {
        let model = setup::extra_dest("rnnoise_model").ok_or_else(|| {
            "Не нашёл путь к модели RNNoise".to_string()
        })?;
        if !model.exists() {
            return Err(
                "Модель RNNoise не установлена — поставьте её в Setup.".to_string(),
            );
        }
        // FFmpeg's filter parser also strips backslashes — wrap the path
        // in single quotes after escaping any embedded `'`.
        let path_safe = model.to_string_lossy().replace('\'', "\\'");
        filters.push(format!("arnndn=m='{path_safe}'"));
    }
    if options.loudnorm {
        let lufs = options.target_lufs.clamp(-50.0, -5.0);
        filters.push(format!("loudnorm=I={lufs}:TP=-1.5:LRA=11"));
    }
    if filters.is_empty() {
        return Err("Включите хотя бы одну операцию.".to_string());
    }
    let af = filters.join(",");

    // Output: per-module override → otherwise next to source.
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = video_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let out_dir = settings
        .module_output_dir("audio_fix")
        .or_else(|| video_path.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&out_dir);
    let out_path = out_dir.join(format!("{stem}_audio.{ext}"));

    // FFmpeg duration for progress total (ms).
    let total_ms = crate::preview::probe_duration_public(&ffmpeg, &video_path)
        .await
        .map(|s| (s * 1000.0) as i64)
        .unwrap_or(0);

    let _ = app.emit(
        "audio_fix://progress",
        serde_json::json!({ "stage": "Кодирование", "pos": 0.0, "total": total_ms as f64 / 1000.0 }),
    );

    let mut child = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&video_path)
        .args(["-af", &af])
        .args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"])
        .args(["-progress", "pipe:2"])
        .arg(&out_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
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
