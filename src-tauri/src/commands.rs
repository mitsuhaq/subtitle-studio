use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::paths;
use crate::pipeline::{self, SubtitleStyle, TranscribeOptions, TranscribeResult};
use crate::presets::{self, Preset};
use crate::settings::{Settings, SettingsStore};
use crate::setup::{self, DownloadFlags, SetupStatus};
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
