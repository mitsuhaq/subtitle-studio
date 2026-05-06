use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::AsyncWriteExt;

use crate::paths;
use crate::settings::SettingsStore;

pub const PROGRESS_EVENT: &str = "setup://progress";
pub const STATUS_EVENT: &str = "setup://status";

const WHISPER_MODEL_ID: &str = "whisper-large-v3";
const HF_REPO: &str = "Systran/faster-whisper-large-v3";
const HF_FILES: &[&str] = &[
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.json",
    "model.bin",
];

#[cfg(target_os = "macos")]
const FFMPEG_INFO_URL: &str = "https://evermeet.cx/ffmpeg/info/ffmpeg/release";
#[cfg(target_os = "windows")]
const FFMPEG_DIRECT_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

const USER_AGENT: &str = "SubtitleStudio/0.1 (+https://github.com/local)";

/// Per-component cancellation flags shared between the spawning command and
/// the long-running download task.
#[derive(Default)]
pub struct DownloadFlags {
    pub whisper: Arc<AtomicBool>,
    pub ffmpeg: Arc<AtomicBool>,
    /// Cancellation flags for `EXTRAS` keyed by their `id`. Lazily populated
    /// the first time each extra is downloaded.
    pub extras: parking_lot::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadFlags {
    pub fn extra(&self, id: &str) -> Arc<AtomicBool> {
        let mut guard = self.extras.lock();
        guard
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }
}

// ---------------------------------------------------------------------------
// Generic "extra" components — neural-net models for the non-Subtitles modules.
// Each one is a single file downloaded from a stable URL into `data/models/<id>/`.
// Adding a new module is a one-line addition here.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ExtraComponentDef {
    pub id: &'static str,
    pub name: &'static str,
    /// Frontend module ids this component unlocks. One model can unlock
    /// several modules (e.g. RVM serves both CorridorKey and Rotobrush).
    pub module_ids: &'static [&'static str],
    /// Direct download URL. Empty string ≡ "not yet available, show as locked".
    pub url: &'static str,
    /// Approximate size in bytes for the UI before the HTTP HEAD lands.
    pub size_bytes_hint: u64,
    pub filename: &'static str,
    /// One-line user-facing description shown next to the install button.
    pub hint: &'static str,
}

pub const EXTRAS: &[ExtraComponentDef] = &[
    ExtraComponentDef {
        id: "rvm",
        name: "RVM (быстрая)",
        module_ids: &["corridor_key", "rotobrush"],
        url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx",
        size_bytes_hint: 50 * 1024 * 1024,
        filename: "rvm_mobilenetv3_fp32.onnx",
        hint: "MobileNetV3 ~50 МБ — быстро, средние края.",
    },
    ExtraComponentDef {
        id: "rvm_hd",
        name: "RVM HD (качественнее)",
        module_ids: &["corridor_key", "rotobrush"],
        url: "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx",
        size_bytes_hint: 150 * 1024 * 1024,
        filename: "rvm_resnet50_fp32.onnx",
        hint: "ResNet50 ~150 МБ — медленнее, заметно чище края.",
    },
    ExtraComponentDef {
        id: "rnnoise_model",
        name: "RNNoise (модель шумодава)",
        module_ids: &["audio_fix"],
        url: "https://github.com/GregorR/rnnoise-models/raw/master/beguiling-drafter-2018-08-30/bd.rnnn",
        size_bytes_hint: 90 * 1024,
        filename: "bd.rnnn",
        hint: "Модель ~90 КБ для FFmpeg arnndn-фильтра.",
    },
    // Eye Contact deliberately omitted from EXTRAS — no production-quality
    // open-source model exists. The module page itself explains the
    // situation rather than dangling a "coming soon" download here.
];

pub fn extra_def(id: &str) -> Option<&'static ExtraComponentDef> {
    EXTRAS.iter().find(|e| e.id == id)
}

pub fn extra_dest(id: &str) -> Option<PathBuf> {
    extra_def(id).map(|e| paths::data_dir().join("models").join(id).join(e.filename))
}

/// Wipe a downloaded extra. Removes both the model file and its parent
/// directory; idempotent if nothing's there. Used by the Setup UI's
/// "Удалить" button so users can free disk space without uninstalling
/// the whole app.
///
/// Emits a `setup://progress` event with stage="Удалено" once done, so
/// modules listening to that channel can flip their availability state
/// without polling.
pub async fn uninstall_extra<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<()> {
    let dir = paths::data_dir().join("models").join(id);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await?;
    }
    let component_key: &'static str = leak_str(&format!("extra:{id}"));
    emit_stage(app, component_key, "Удалено", 0, 0);
    Ok(())
}

pub fn extra_status(id: &str) -> ComponentStatus {
    let Some(path) = extra_dest(id) else {
        return ComponentStatus {
            installed: false,
            path: None,
            size_bytes: 0,
            version: None,
            message: Some(format!("неизвестный компонент: {id}")),
        };
    };
    if path.exists() {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        ComponentStatus {
            installed: true,
            path: Some(path),
            size_bytes: size,
            version: None,
            message: None,
        }
    } else {
        ComponentStatus {
            installed: false,
            path: Some(path),
            size_bytes: 0,
            version: None,
            message: None,
        }
    }
}

pub async fn download_extra<R: Runtime>(
    app: AppHandle<R>,
    cancel: Arc<AtomicBool>,
    id: String,
) -> Result<ComponentStatus> {
    let def = extra_def(&id)
        .ok_or_else(|| anyhow!("неизвестный компонент: {id}"))?;
    if def.url.is_empty() {
        bail!("Для «{}» ещё не выбрана модель — скоро будет.", def.name);
    }
    let dest = extra_dest(&id)
        .ok_or_else(|| anyhow!("не удалось определить путь для {id}"))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).context("create extras dir")?;
    }
    cancel.store(false, Ordering::SeqCst);

    // Routing key for setup://progress events — the frontend maps the
    // "extra:<id>" prefix back to the corresponding card. Leak is bounded:
    // one allocation per known extra id over the process lifetime.
    let component_key: &'static str = leak_str(&format!("extra:{}", def.id));
    let total_hint = def.size_bytes_hint;

    emit_stage(&app, component_key, "Загрузка", 0, total_hint);

    let client = http_client()?;
    let app_for_progress = app.clone();
    let filename = def.filename;
    stream_to_file(
        &client,
        def.url,
        &dest,
        &cancel,
        move |downloaded| {
            let total = if total_hint > 0 { total_hint } else { downloaded };
            emit_progress(
                &app_for_progress,
                component_key,
                "Загрузка",
                Some(filename),
                downloaded,
                total,
                downloaded,
                total,
            );
        },
    )
    .await?;

    emit_stage(&app, component_key, "Готово", total_hint, total_hint);
    Ok(extra_status(&id))
}

/// Leak a String so we can keep the `&'static str` invariant on
/// `ProgressPayload::component`. We only call this with a small fixed set of
/// extra ids, so the leak is bounded and intentional.
fn leak_str(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub component: &'static str,
    pub stage: String,
    pub file: Option<String>,
    pub file_downloaded: u64,
    pub file_total: u64,
    pub grand_downloaded: u64,
    pub grand_total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComponentStatus {
    pub installed: bool,
    pub path: Option<PathBuf>,
    pub size_bytes: u64,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub whisper: ComponentStatus,
    pub ffmpeg: ComponentStatus,
    pub data_dir: PathBuf,
}

fn http_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60 * 60))
        .connect_timeout(Duration::from_secs(20))
        .build()?)
}

fn ffmpeg_binary_name() -> &'static str {
    if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" }
}

pub fn ffmpeg_target_path() -> PathBuf {
    paths::data_dir().join("ffmpeg").join(ffmpeg_binary_name())
}

pub fn whisper_target_dir() -> PathBuf {
    paths::data_dir().join("models").join(WHISPER_MODEL_ID)
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

pub fn current_status(settings: &SettingsStore) -> SetupStatus {
    SetupStatus {
        whisper: whisper_status(settings),
        ffmpeg: ffmpeg_status(settings),
        data_dir: paths::data_dir(),
    }
}

fn whisper_status(settings: &SettingsStore) -> ComponentStatus {
    let dir = settings.snapshot().whisper_model_dir.unwrap_or_else(whisper_target_dir);
    let model_bin = dir.join("model.bin");
    if !model_bin.exists() {
        return ComponentStatus {
            installed: false,
            path: None,
            size_bytes: 0,
            version: None,
            message: Some("Не загружено".into()),
        };
    }
    let size = dir_size(&dir).unwrap_or(0);
    ComponentStatus {
        installed: true,
        path: Some(dir),
        size_bytes: size,
        version: Some("large-v3".into()),
        message: None,
    }
}

fn ffmpeg_status(settings: &SettingsStore) -> ComponentStatus {
    let path = settings.snapshot().ffmpeg_path.unwrap_or_else(ffmpeg_target_path);
    if !path.exists() {
        return ComponentStatus {
            installed: false,
            path: None,
            size_bytes: 0,
            version: None,
            message: Some("Не загружено".into()),
        };
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let version = quick_ffmpeg_version(&path);
    ComponentStatus {
        installed: true,
        path: Some(path),
        size_bytes: size,
        version,
        message: None,
    }
}

fn quick_ffmpeg_version(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("-version").output().ok()?;
    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    Some(first)
}

fn dir_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let m = entry.metadata()?;
        if m.is_file() {
            total += m.len();
        } else if m.is_dir() {
            total += dir_size(&entry.path()).unwrap_or(0);
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

pub async fn download_whisper<R: Runtime>(
    app: AppHandle<R>,
    flags: Arc<AtomicBool>,
    settings: SettingsStore,
) -> Result<SetupStatus> {
    flags.store(false, Ordering::SeqCst);
    let client = http_client()?;
    let target_dir = whisper_target_dir();
    tokio::fs::create_dir_all(&target_dir).await?;

    emit_stage(&app, "whisper", "Получение списка файлов", 0, 0);

    // HF Tree API gives us file sizes deterministically, without relying on
    // HEAD requests against the CDN (which strips Content-Length on redirect).
    let sizes = fetch_hf_sizes(&client, HF_REPO).await
        .context("Не удалось получить метаданные репозитория Whisper")?;

    let mut files = Vec::with_capacity(HF_FILES.len());
    let mut grand_total: u64 = 0;
    for name in HF_FILES {
        let size = match sizes.get(*name) {
            Some(s) => *s,
            None => {
                log::warn!("HF tree missing entry {name}; skipping");
                continue;
            }
        };
        let url = format!("https://huggingface.co/{HF_REPO}/resolve/main/{name}");
        grand_total += size;
        files.push((name.to_string(), url, size));
    }
    if files.is_empty() {
        bail!("Не удалось получить список файлов модели Whisper с Hugging Face — проверьте подключение");
    }

    let mut grand_downloaded = 0u64;
    for (name, url, total) in files {
        check_cancel(&flags)?;
        emit_progress(&app, "whisper", "Загрузка", Some(&name), 0, total, grand_downloaded, grand_total);

        let dest = target_dir.join(&name);
        let downloaded = stream_to_file(
            &client,
            &url,
            &dest,
            &flags,
            |file_dl| {
                let cur = grand_downloaded + file_dl;
                emit_progress(
                    &app,
                    "whisper",
                    "Загрузка",
                    Some(&name),
                    file_dl,
                    total,
                    cur,
                    grand_total,
                );
            },
        )
        .await?;
        grand_downloaded += downloaded;
    }

    settings.update(|s| {
        s.whisper_model_dir = Some(target_dir.clone());
    })?;

    emit_stage(&app, "whisper", "Готово", grand_total, grand_total);
    let status = current_status(&settings);
    let _ = app.emit(STATUS_EVENT, &status);
    Ok(status)
}

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

pub async fn download_ffmpeg<R: Runtime>(
    app: AppHandle<R>,
    flags: Arc<AtomicBool>,
    settings: SettingsStore,
) -> Result<SetupStatus> {
    flags.store(false, Ordering::SeqCst);
    let client = http_client()?;
    let target_dir = paths::data_dir().join("ffmpeg");
    tokio::fs::create_dir_all(&target_dir).await?;

    emit_stage(&app, "ffmpeg", "Определение источника", 0, 0);
    let (archive_url, hint_size) = resolve_ffmpeg_source(&client, &settings).await?;

    let cache_zip = target_dir.join(".ffmpeg.partial.zip");
    let total = match hint_size {
        Some(s) => s,
        None => head_size(&client, &archive_url).await.unwrap_or(0),
    };

    emit_progress(&app, "ffmpeg", "Загрузка", Some("ffmpeg.zip"), 0, total, 0, total);
    let downloaded = stream_to_file(&client, &archive_url, &cache_zip, &flags, |dl| {
        emit_progress(&app, "ffmpeg", "Загрузка", Some("ffmpeg.zip"), dl, total, dl, total);
    })
    .await?;

    emit_stage(&app, "ffmpeg", "Распаковка", downloaded, downloaded);
    let extracted_bin = extract_ffmpeg_binary(&cache_zip, &target_dir).await?;
    let _ = tokio::fs::remove_file(&cache_zip).await;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&extracted_bin).await?.permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&extracted_bin, perms).await?;
    }

    emit_stage(&app, "ffmpeg", "Проверка", downloaded, downloaded);
    let version = run_ffmpeg_version(&extracted_bin).await?;
    log::info!("ffmpeg installed: {version}");

    settings.update(|s| {
        s.ffmpeg_path = Some(extracted_bin.clone());
    })?;

    emit_stage(&app, "ffmpeg", "Готово", downloaded, downloaded);
    let status = current_status(&settings);
    let _ = app.emit(STATUS_EVENT, &status);
    Ok(status)
}

#[cfg(target_os = "macos")]
async fn resolve_ffmpeg_source(
    client: &reqwest::Client,
    settings: &SettingsStore,
) -> Result<(String, Option<u64>)> {
    if let Some(url) = settings.snapshot().ffmpeg_url_override {
        return Ok((url, None));
    }
    #[derive(Deserialize)]
    struct DownloadEntry { url: String, size: u64 }
    #[derive(Deserialize)]
    struct Download { zip: DownloadEntry }
    #[derive(Deserialize)]
    struct Info { download: Download }
    let info: Info = client
        .get(FFMPEG_INFO_URL)
        .send()
        .await
        .context("evermeet.cx info request failed")?
        .error_for_status()?
        .json()
        .await
        .context("evermeet.cx info JSON parse failed")?;
    Ok((info.download.zip.url, Some(info.download.zip.size)))
}

#[cfg(target_os = "windows")]
async fn resolve_ffmpeg_source(
    _client: &reqwest::Client,
    settings: &SettingsStore,
) -> Result<(String, Option<u64>)> {
    let url = settings
        .snapshot()
        .ffmpeg_url_override
        .unwrap_or_else(|| FFMPEG_DIRECT_URL.to_string());
    Ok((url, None))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn resolve_ffmpeg_source(
    _client: &reqwest::Client,
    settings: &SettingsStore,
) -> Result<(String, Option<u64>)> {
    let url = settings
        .snapshot()
        .ffmpeg_url_override
        .ok_or_else(|| anyhow!("Не задан URL FFmpeg для этой платформы — укажите ffmpeg_url_override"))?;
    Ok((url, None))
}

async fn extract_ffmpeg_binary(zip_path: &Path, target_dir: &Path) -> Result<PathBuf> {
    let zip_path = zip_path.to_path_buf();
    let target_dir = target_dir.to_path_buf();
    let bin_name = ffmpeg_binary_name().to_string();
    tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        let file = std::fs::File::open(&zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let entry_path = match entry.enclosed_name() {
                Some(p) => p.to_path_buf(),
                None => continue,
            };
            let file_name = match entry_path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if file_name.eq_ignore_ascii_case(&bin_name) && !entry.is_dir() {
                let dest = target_dir.join(&bin_name);
                let mut out = std::fs::File::create(&dest)?;
                std::io::copy(&mut entry, &mut out)?;
                return Ok(dest);
            }
        }
        Err(anyhow!("В архиве FFmpeg не найден бинарь {bin_name}"))
    })
    .await?
}

async fn run_ffmpeg_version(path: &Path) -> Result<String> {
    let out = tokio::process::Command::new(path)
        .arg("-version")
        .output()
        .await
        .context("Не удалось запустить ffmpeg -version")?;
    if !out.status.success() {
        bail!(
            "ffmpeg -version exit {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string())
}

// ---------------------------------------------------------------------------
// Generic streaming download
// ---------------------------------------------------------------------------

async fn head_size(client: &reqwest::Client, url: &str) -> Result<u64> {
    let resp = client.head(url).send().await?;
    if !resp.status().is_success() {
        bail!("HEAD {url} → {}", resp.status());
    }
    let len = resp.content_length().unwrap_or(0);
    Ok(len)
}

#[derive(Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
}

async fn fetch_hf_sizes(
    client: &reqwest::Client,
    repo: &str,
) -> Result<std::collections::HashMap<String, u64>> {
    let url = format!("https://huggingface.co/api/models/{repo}/tree/main");
    let entries: Vec<HfTreeEntry> = client
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(entries
        .into_iter()
        .filter(|e| e.kind == "file")
        .map(|e| (e.path, e.size))
        .collect())
}

async fn stream_to_file<F: FnMut(u64)>(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancel: &Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<u64> {
    let partial = dest.with_extension("partial");
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut file = tokio::fs::File::create(&partial).await?;
    let resp = client.get(url).send().await?.error_for_status()?;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.shutdown().await;
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("Загрузка отменена");
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() > Duration::from_millis(120) {
            on_progress(downloaded);
            last_emit = Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&partial, dest).await?;
    on_progress(downloaded);
    Ok(downloaded)
}

fn check_cancel(flags: &Arc<AtomicBool>) -> Result<()> {
    if flags.load(Ordering::SeqCst) {
        bail!("Загрузка отменена");
    }
    Ok(())
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    component: &'static str,
    stage: &str,
    file: Option<&str>,
    file_downloaded: u64,
    file_total: u64,
    grand_downloaded: u64,
    grand_total: u64,
) {
    let payload = ProgressPayload {
        component,
        stage: stage.to_string(),
        file: file.map(|f| f.to_string()),
        file_downloaded,
        file_total,
        grand_downloaded,
        grand_total,
    };
    let _ = app.emit(PROGRESS_EVENT, payload);
}

fn emit_stage<R: Runtime>(
    app: &AppHandle<R>,
    component: &'static str,
    stage: &str,
    grand_downloaded: u64,
    grand_total: u64,
) {
    emit_progress(app, component, stage, None, 0, 0, grand_downloaded, grand_total);
}

// ---------------------------------------------------------------------------
// SHA256 (used by callers that know the expected digest; kept for later)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = tokio::io::AsyncReadExt::read(&mut f, &mut buf).await?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Helpers exposed to commands
// ---------------------------------------------------------------------------

pub fn select_flag(flags: &DownloadFlags, component: &str) -> Option<Arc<AtomicBool>> {
    match component {
        "whisper" => Some(flags.whisper.clone()),
        "ffmpeg" => Some(flags.ffmpeg.clone()),
        _ => None,
    }
}

pub fn manage_flags<R: Runtime>(app: &mut tauri::App<R>) {
    app.manage(DownloadFlags::default());
}
