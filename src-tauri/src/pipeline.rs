//! Video → audio (FFmpeg) → transcription (Python sidecar) → SRT path.
//!
//! Sidecar `/transcribe` is a Server-Sent Events stream — we forward each
//! progress event into Tauri so the UI can show a real bar instead of just
//! a stage label. Cancel: POST /cancel on the sidecar AND set our local
//! abort flag, which causes us to break out of the SSE read loop.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::SettingsStore;
use crate::sidecar::SidecarState;

pub const PROGRESS_EVENT: &str = "pipeline://progress";

#[derive(Default)]
pub struct PipelineState {
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
}

pub fn manage<R: Runtime>(app: &mut tauri::App<R>) {
    app.manage(PipelineState::default());
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct SubtitleStyle {
    pub font_family: String,
    pub font_size: u32,
    pub primary_color: String,
    pub outline_color: String,
    pub back_color: String,
    pub back_alpha: u8,
    pub bold: bool,
    pub italic: bool,
    pub outline_width: f32,
    pub shadow_offset: f32,
    /// libass BorderStyle: 1 = outline + drop shadow, 3 = opaque box (uses
    /// `bg_padding` instead of `outline_width` for the box thickness).
    pub border_style: u8,
    pub alignment: u8,
    pub margin_v: u32,
    pub margin_l: u32,
    pub margin_r: u32,
    /// Padding (px) of the opaque box around the text when `border_style == 3`.
    /// Ignored in outline mode.
    pub bg_padding: f32,
}

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font_family: "Inter".to_string(),
            font_size: 38,
            primary_color: "#FFFFFF".to_string(),
            outline_color: "#000000".to_string(),
            back_color: "#000000".to_string(),
            back_alpha: 70,
            bold: true,
            italic: false,
            outline_width: 2.5,
            shadow_offset: 1.0,
            border_style: 1,
            alignment: 2,
            margin_v: 50,
            margin_l: 60,
            margin_r: 60,
            bg_padding: 8.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TranscribeOptions {
    pub language: Option<String>,
    pub translate: bool,
    pub vad: bool,
    pub beam_size: u32,
    pub max_chars: u32,
    pub min_duration: f32,
    pub max_duration: f32,
    pub target_cps: f32,
    pub burn_in: bool,
    pub style: SubtitleStyle,
}

impl Default for TranscribeOptions {
    fn default() -> Self {
        Self {
            language: None,
            translate: false,
            vad: true,
            beam_size: 1,
            max_chars: 42,
            min_duration: 0.6,
            max_duration: 6.0,
            target_cps: 17.0,
            burn_in: true,
            style: SubtitleStyle::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResult {
    pub cues_count: u32,
    pub duration: f32,
    pub detected_language: Option<String>,
    pub language_probability: Option<f32>,
    pub output_srt: PathBuf,
    pub output_ass: Option<PathBuf>,
    pub output_video: Option<PathBuf>,
}

#[derive(Serialize, Clone, Default)]
struct ProgressPayload {
    stage: String,
    detail: Option<String>,
    pos: f32,
    total: f32,
}

fn emit<R: Runtime>(app: &AppHandle<R>, payload: ProgressPayload) {
    if let Err(e) = app.emit(PROGRESS_EVENT, payload) {
        log::warn!("pipeline emit failed: {e}");
    }
}

fn emit_stage<R: Runtime>(app: &AppHandle<R>, stage: &str, detail: Option<&str>) {
    log::info!(
        "pipeline emit: stage={stage} detail={}",
        detail.unwrap_or("-")
    );
    emit(
        app,
        ProgressPayload {
            stage: stage.to_string(),
            detail: detail.map(str::to_string),
            ..Default::default()
        },
    );
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>) {
    let pipeline = app.state::<PipelineState>();
    if let Some(flag) = pipeline.cancel.lock().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(port) = app
        .state::<SidecarState>()
        .info
        .lock()
        .as_ref()
        .map(|i| i.port)
    {
        let url = format!("http://127.0.0.1:{port}/cancel");
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::new();
            if let Err(e) = client.post(&url).send().await {
                log::warn!("cancel POST failed: {e}");
            }
        });
    }
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    output_srt: PathBuf,
    opts: TranscribeOptions,
) -> Result<TranscribeResult> {
    if !video_path.exists() {
        bail!("Файл не найден: {}", video_path.display());
    }
    let settings = app.state::<SettingsStore>().snapshot();
    let ffmpeg = settings
        .ffmpeg_path
        .clone()
        .ok_or_else(|| anyhow!("FFmpeg не установлен — перейдите во вкладку Setup"))?;
    let model_dir = settings
        .whisper_model_dir
        .clone()
        .ok_or_else(|| anyhow!("Whisper модель не установлена — перейдите во вкладку Setup"))?;
    let port = app
        .state::<SidecarState>()
        .info
        .lock()
        .as_ref()
        .map(|i| i.port)
        .ok_or_else(|| anyhow!("Python sidecar ещё не готов — попробуйте через секунду"))?;

    if let Some(dir) = settings.output_dir.as_ref() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("Не удалось создать папку результатов: {}", dir.display()))?;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    *app.state::<PipelineState>().cancel.lock() = Some(cancel_flag.clone());

    let result = run_inner(
        app.clone(),
        video_path,
        output_srt,
        opts,
        ffmpeg,
        model_dir,
        port,
        cancel_flag,
        settings.output_dir.clone(),
    )
    .await;

    // Always clear cancel flag at the end so the next run starts fresh.
    *app.state::<PipelineState>().cancel.lock() = None;
    result
}

async fn run_inner<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    output_srt: PathBuf,
    opts: TranscribeOptions,
    ffmpeg: PathBuf,
    model_dir: PathBuf,
    port: u16,
    cancel_flag: Arc<AtomicBool>,
    output_dir: Option<PathBuf>,
) -> Result<TranscribeResult> {
    emit_stage(
        &app,
        "Извлечение аудио",
        video_path.file_name().and_then(|s| s.to_str()),
    );
    let wav = extract_audio_to_wav(&ffmpeg, &video_path)
        .await
        .context("FFmpeg не смог извлечь аудио из видео")?;

    if cancel_flag.load(Ordering::SeqCst) {
        let _ = tokio::fs::remove_file(&wav).await;
        bail!("Прервано");
    }

    let ass_path = if opts.burn_in {
        Some(output_srt.with_extension("ass"))
    } else {
        None
    };

    emit_stage(&app, "Транскрипция", None);
    let result = stream_transcribe(
        &app,
        port,
        &wav,
        &output_srt,
        ass_path.as_deref(),
        &model_dir,
        &opts,
        cancel_flag.clone(),
    )
    .await;
    let _ = tokio::fs::remove_file(&wav).await;
    let mut result = result?;

    if opts.burn_in {
        if cancel_flag.load(Ordering::SeqCst) {
            bail!("Прервано");
        }
        let burned = default_burned_path(&video_path, output_dir.as_deref());
        let ass = result
            .output_ass
            .clone()
            .ok_or_else(|| anyhow!("ASS не был создан, нечего вшивать"))?;
        burn_subtitles(
            &app,
            &ffmpeg,
            &video_path,
            &ass,
            &burned,
            result.duration,
            cancel_flag.clone(),
        )
        .await
        .context("FFmpeg не смог вшить субтитры")?;
        result.output_video = Some(burned);
    }

    emit_stage(&app, "Готово", None);
    Ok(result)
}

/// `video.mp4` → `video_subtitled.mp4`. Goes into `output_dir` if set,
/// otherwise next to the source video.
pub fn default_burned_path(video: &Path, output_dir: Option<&Path>) -> PathBuf {
    let stem = video
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = video
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let new_name = format!("{stem}_subtitled.{ext}");
    if let Some(dir) = output_dir {
        return dir.join(&new_name);
    }
    video
        .parent()
        .map(|p| p.join(&new_name))
        .unwrap_or_else(|| PathBuf::from(new_name))
}

async fn burn_subtitles<R: Runtime>(
    app: &AppHandle<R>,
    ffmpeg: &Path,
    video: &Path,
    ass: &Path,
    output: &Path,
    duration: f32,
    cancel_flag: Arc<AtomicBool>,
) -> Result<()> {
    // FFmpeg's subtitles= filter parses the ASS path itself, so spaces and
    // colons in the path break it. Copy the ASS to a sibling-of-video temp
    // location with a safe filename and feed FFmpeg that.
    let safe_dir = std::env::temp_dir().join("subtitle-studio");
    tokio::fs::create_dir_all(&safe_dir).await?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe_ass = safe_dir.join(format!("subs-{nonce}.ass"));
    tokio::fs::copy(ass, &safe_ass).await?;

    emit_stage(
        app,
        "Вшивание субтитров",
        output.file_name().and_then(|s| s.to_str()),
    );

    let safe_ass_str = safe_ass
        .to_str()
        .ok_or_else(|| anyhow!("non-utf8 temp ass path"))?
        .to_string();
    let filter = format!("subtitles={safe_ass_str}");

    let mut child = tokio::process::Command::new(ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-i")
        .arg(video)
        .args([
            "-vf",
            &filter,
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "medium",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-progress",
            "pipe:2",
            "-loglevel",
            "error",
        ])
        .arg(output)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("ffmpeg burn-in spawn failed")?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("ffmpeg has no stderr"))?;
    let app_clone = app.clone();
    let progress_task = tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("out_time_ms=") {
                if let Ok(us) = rest.trim().parse::<i64>() {
                    if us >= 0 {
                        let pos = (us as f32) / 1_000_000.0;
                        emit(
                            &app_clone,
                            ProgressPayload {
                                stage: "Вшивание субтитров".into(),
                                detail: None,
                                pos,
                                total: duration,
                            },
                        );
                    }
                }
            } else if line.starts_with("progress=end") {
                break;
            } else if !line.is_empty() {
                log::info!("[ffmpeg] {line}");
            }
        }
    });

    let cancel_watch = tokio::spawn({
        let pid = child.id();
        async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if cancel_flag.load(Ordering::SeqCst) {
                    if let Some(pid) = pid {
                        // Best-effort cancel; spawn a kill via std::process.
                        log::info!("ffmpeg burn-in cancel requested, killing pid {pid}");
                        let _ = std::process::Command::new("kill")
                            .arg(pid.to_string())
                            .status();
                    }
                    break;
                }
            }
        }
    });

    let status = child.wait().await?;
    cancel_watch.abort();
    let _ = progress_task.await;
    let _ = tokio::fs::remove_file(&safe_ass).await;

    if !status.success() {
        bail!("ffmpeg burn-in exit {}", status);
    }
    Ok(())
}

async fn extract_audio_to_wav(ffmpeg: &Path, video: &Path) -> Result<PathBuf> {
    let temp_dir = std::env::temp_dir().join("subtitle-studio");
    tokio::fs::create_dir_all(&temp_dir).await?;
    let stem = video
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let pid = std::process::id();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let wav_path = temp_dir.join(format!("{stem}-{pid}-{nonce}.wav"));

    let output = tokio::process::Command::new(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(video)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            "-loglevel",
            "error",
        ])
        .arg(&wav_path)
        .output()
        .await
        .context("ffmpeg spawn failed")?;
    if !output.status.success() {
        bail!(
            "ffmpeg exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(wav_path)
}

#[derive(Serialize)]
struct SidecarTranscribeRequest<'a> {
    audio_path: &'a str,
    output_srt: &'a str,
    output_ass: Option<&'a str>,
    model_dir: &'a str,
    style: SubtitleStyle,
    language: Option<String>,
    translate: bool,
    vad: bool,
    beam_size: u32,
    max_chars: u32,
    min_duration: f32,
    max_duration: f32,
    target_cps: f32,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum SseEvent {
    #[serde(rename = "meta")]
    Meta {
        language: Option<String>,
        language_probability: Option<f32>,
        duration: f32,
    },
    #[serde(rename = "progress")]
    Progress {
        pos: f32,
        total: f32,
        #[serde(default)]
        text: String,
    },
    #[serde(rename = "done")]
    Done {
        cues_count: u32,
        duration: f32,
        detected_language: Option<String>,
        language_probability: Option<f32>,
        output_srt: PathBuf,
        #[serde(default)]
        output_ass: Option<PathBuf>,
    },
    #[serde(rename = "cancelled")]
    Cancelled {},
    #[serde(rename = "error")]
    Error { message: String },
}

async fn stream_transcribe<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
    audio: &Path,
    output_srt: &Path,
    output_ass: Option<&Path>,
    model_dir: &Path,
    opts: &TranscribeOptions,
    cancel_flag: Arc<AtomicBool>,
) -> Result<TranscribeResult> {
    let url = format!("http://127.0.0.1:{port}/transcribe");
    let ass_str = match output_ass {
        Some(p) => Some(p.to_str().ok_or_else(|| anyhow!("non-utf8 ass path"))?),
        None => None,
    };
    let body = SidecarTranscribeRequest {
        audio_path: audio.to_str().ok_or_else(|| anyhow!("non-utf8 audio path"))?,
        output_srt: output_srt
            .to_str()
            .ok_or_else(|| anyhow!("non-utf8 srt path"))?,
        output_ass: ass_str,
        model_dir: model_dir
            .to_str()
            .ok_or_else(|| anyhow!("non-utf8 model dir"))?,
        style: opts.style.clone(),
        language: opts.language.clone(),
        translate: opts.translate,
        vad: opts.vad,
        beam_size: opts.beam_size,
        max_chars: opts.max_chars,
        min_duration: opts.min_duration,
        max_duration: opts.max_duration,
        target_cps: opts.target_cps,
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60 * 60))
        .build()?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .context("Не удалось обратиться к sidecar /transcribe")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        bail!("sidecar /transcribe → {status}: {text}");
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut detected_language: Option<String> = None;
    let mut language_probability: Option<f32> = None;
    let mut total_duration: f32 = 0.0;

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            // We've already POST'd /cancel from the cancel command — tell
            // the sidecar one more time in case the message raced.
            let _ = client
                .post(format!("http://127.0.0.1:{port}/cancel"))
                .send()
                .await;
            bail!("Прервано");
        }

        let chunk = match stream.next().await {
            Some(c) => c.context("SSE chunk read failed")?,
            None => bail!("SSE поток закрылся неожиданно"),
        };
        buf.extend_from_slice(&chunk);

        // Parse out as many complete events ("data: ...\n\n") as we have.
        while let Some(pos) = find_double_newline(&buf) {
            let event_bytes = buf.drain(..pos + 2).collect::<Vec<_>>();
            let line = std::str::from_utf8(&event_bytes)
                .context("non-utf8 SSE event")?
                .trim_end();
            let payload = match line.strip_prefix("data: ") {
                Some(p) => p,
                None => continue,
            };
            let event: SseEvent = serde_json::from_str(payload)
                .context("malformed SSE JSON")?;
            match event {
                SseEvent::Meta {
                    language,
                    language_probability: prob,
                    duration,
                } => {
                    detected_language = language.clone();
                    language_probability = prob;
                    total_duration = duration;
                    let detail = language
                        .as_deref()
                        .map(|l| format!("Язык: {l}"))
                        .unwrap_or_default();
                    emit(
                        app,
                        ProgressPayload {
                            stage: "Транскрипция".into(),
                            detail: if detail.is_empty() { None } else { Some(detail) },
                            pos: 0.0,
                            total: duration,
                        },
                    );
                }
                SseEvent::Progress { pos, total, text } => {
                    let total = if total > 0.0 { total } else { total_duration };
                    emit(
                        app,
                        ProgressPayload {
                            stage: "Транскрипция".into(),
                            detail: trim_text(&text),
                            pos,
                            total,
                        },
                    );
                }
                SseEvent::Done {
                    cues_count,
                    duration,
                    detected_language: dl,
                    language_probability: lp,
                    output_srt,
                    output_ass,
                } => {
                    return Ok(TranscribeResult {
                        cues_count,
                        duration,
                        detected_language: dl.or(detected_language),
                        language_probability: lp.or(language_probability),
                        output_srt,
                        output_ass,
                        output_video: None,
                    });
                }
                SseEvent::Cancelled {} => bail!("Прервано"),
                SseEvent::Error { message } => bail!(message),
            }
        }
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn trim_text(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        None
    } else if s.chars().count() > 80 {
        Some(format!("{}…", s.chars().take(80).collect::<String>()))
    } else {
        Some(s.to_string())
    }
}

/// Build a complete ASS file from already-cut SRT cues using the given
/// style. Mirrors what `python-sidecar/worker/ass_writer.py` produces — both
/// must stay in sync. Used by the re-burn flow (no transcription, just
/// re-render from edited cues).
pub fn build_ass_from_srt(
    cues: &[crate::srt_io::SrtCue],
    style: &SubtitleStyle,
) -> String {
    let primary = hex_to_ass_color(&style.primary_color, 100);
    let bold = if style.bold { -1 } else { 0 };
    let italic = if style.italic { -1 } else { 0 };
    let border_outline = if style.border_style == 3 {
        style.bg_padding
    } else {
        style.outline_width
    };
    let (outline, back) = if style.border_style == 3 {
        (
            hex_to_ass_color(&style.back_color, 100),
            hex_to_ass_color(&style.back_color, 100),
        )
    } else {
        (
            hex_to_ass_color(&style.outline_color, 100),
            hex_to_ass_color(&style.back_color, style.back_alpha as u32),
        )
    };

    let mut out = String::new();
    out.push_str(&format!(
"[Script Info]\n\
ScriptType: v4.00+\n\
PlayResX: 1920\n\
PlayResY: 1080\n\
WrapStyle: 2\n\
ScaledBorderAndShadow: yes\n\
YCbCr Matrix: TV.709\n\n\
[V4+ Styles]\n\
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
Style: Default,{font},{size},{primary},&H00000000,{outline},{back},{bold},{italic},0,0,100,100,0,0,{border},{outline_w},{shadow},{align},{ml},{mr},{mv},1\n\n\
[Events]\n\
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        font = style.font_family,
        size = style.font_size,
        primary = primary,
        outline = outline,
        back = back,
        bold = bold,
        italic = italic,
        border = style.border_style,
        outline_w = border_outline,
        shadow = style.shadow_offset,
        align = style.alignment,
        ml = style.margin_l,
        mr = style.margin_r,
        mv = style.margin_v,
    ));
    for c in cues {
        let safe = c.text.replace('\n', " ").replace('{', "(").replace('}', ")");
        out.push_str(&format!(
            "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
            ms_to_ass(c.start_ms),
            ms_to_ass(c.end_ms),
            safe
        ));
    }
    out
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

fn ms_to_ass(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let cs = (ms % 1_000) / 10;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

/// Re-burn a previously-transcribed video using edited SRT cues. Re-uses
/// `burn_subtitles` (same FFmpeg pipeline as the main flow); skips audio
/// extraction and Whisper. Emits the same `pipeline://progress` events so
/// the existing UI updates without changes.
pub async fn reburn<R: Runtime>(
    app: AppHandle<R>,
    video_path: PathBuf,
    srt_path: PathBuf,
    style: SubtitleStyle,
) -> Result<PathBuf> {
    if !video_path.exists() {
        bail!("Видео не найдено: {}", video_path.display());
    }
    if !srt_path.exists() {
        bail!("SRT не найден: {}", srt_path.display());
    }
    let settings = app.state::<SettingsStore>().snapshot();
    let ffmpeg = settings
        .ffmpeg_path
        .clone()
        .ok_or_else(|| anyhow!("FFmpeg не установлен — перейдите во вкладку Setup"))?;
    if let Some(dir) = settings.output_dir.as_ref() {
        std::fs::create_dir_all(dir).with_context(|| {
            format!("Не удалось создать папку результатов: {}", dir.display())
        })?;
    }

    let cues = crate::srt_io::read(&srt_path).context("read srt")?;
    if cues.is_empty() {
        bail!("В SRT нет реплик");
    }

    // Probe duration so the burn-in progress bar has a real `total`.
    // We piggy-back on FFmpeg's stderr parser instead of pulling in ffprobe.
    let duration = crate::preview::probe_duration_public(&ffmpeg, &video_path)
        .await
        .unwrap_or_else(|| {
            cues.iter().map(|c| c.end_ms).max().unwrap_or(0) as f32 / 1000.0
        });

    let cancel_flag = Arc::new(AtomicBool::new(false));
    *app.state::<PipelineState>().cancel.lock() = Some(cancel_flag.clone());

    // Write ASS into a temp file with FFmpeg-safe filename.
    let safe_dir = std::env::temp_dir().join("subtitle-studio");
    tokio::fs::create_dir_all(&safe_dir).await?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ass_path = safe_dir.join(format!("reburn-{nonce}.ass"));
    let ass = build_ass_from_srt(&cues, &style);
    tokio::fs::write(&ass_path, ass.as_bytes()).await?;

    let burned = default_burned_path(&video_path, settings.output_dir.as_deref());
    let result = burn_subtitles(
        &app,
        &ffmpeg,
        &video_path,
        &ass_path,
        &burned,
        duration,
        cancel_flag.clone(),
    )
    .await;

    let _ = tokio::fs::remove_file(&ass_path).await;
    *app.state::<PipelineState>().cancel.lock() = None;

    result?;
    emit_stage(&app, "Готово", None);
    Ok(burned)
}

/// Default `.srt` path. `output_dir = Some(_)` redirects into a single
/// shared folder; `None` keeps the legacy behaviour (next to source).
pub fn default_srt_path(video: &Path, output_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = output_dir {
        let stem = video
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        return dir.join(format!("{stem}.srt"));
    }
    video.with_extension("srt")
}
