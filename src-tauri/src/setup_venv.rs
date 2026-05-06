//! Heavy ML extras that ship as a Python virtualenv rather than a single
//! file. Demucs and similar live here.
//!
//! Why a separate module: the existing `setup::download_extra` flow assumes
//! one URL → one file → done. Demucs needs a Python interpreter, ~1 GB of
//! torch wheels, and a model auto-fetched on first run. That sequence
//! doesn't compress nicely into a download function, so we keep the two
//! flavours visually similar (events on the same channel, identical
//! cancellation semantics) but mechanically separate.
//!
//! `uv` is bundled inside the .app — we never ask the user to install it
//! via the terminal. The binary lives in `Contents/Resources/assets/uv/uv`
//! and `bundled_uv()` resolves it at runtime.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::paths;
use crate::setup::{ProgressPayload, PROGRESS_EVENT};

#[derive(Debug, Clone, Serialize)]
pub struct PythonExtraDef {
    pub id: &'static str,
    pub name: &'static str,
    pub module_ids: &'static [&'static str],
    /// Python version pinned via `uv`. Demucs needs ≥3.10; we standardise
    /// on 3.11 so the wheel index hits the modern manylinux/macOS slots.
    pub python_version: &'static str,
    /// Pip packages installed into the venv. Order matters for resolution
    /// stability — pin the heavy ones first.
    pub packages: &'static [&'static str],
    /// Optional command run inside the venv after install. Lets us pre-touch
    /// the model entry point so the first real run isn't blocked on it.
    pub model_init: Option<&'static [&'static str]>,
    pub hint: &'static str,
    /// Approximate post-install footprint, for the UI before the directory
    /// is fully populated.
    pub size_bytes_hint: u64,
    /// `true` if `module_ids` *require* this extra to function at all
    /// (voice clone). `false` if the extra merely enhances modes inside
    /// an otherwise-working module (Demucs → Vocal Split). The frontend
    /// uses this to decide whether to flip the module's availability flag.
    pub gates_modules: bool,
}

pub const PYTHON_EXTRAS: &[PythonExtraDef] = &[
    PythonExtraDef {
        id: "demucs",
        name: "Demucs (вокал/инструменты)",
        module_ids: &["vocal_split"],
        python_version: "3.11",
        // Demucs pulls torch transitively; listing it explicitly first
        // keeps resolution stable when demucs's pin moves. `torchcodec`
        // is needed because torchaudio>=2.4 dispatches `save()` through
        // torchcodec instead of its old soundfile/sox backends — without
        // it the run crashes at the very last step (right after
        // separation completes) with "ModuleNotFoundError: torchcodec".
        packages: &["torch", "torchcodec", "demucs"],
        // Calling `--help` runs through demucs's import path, which is
        // enough to make sure pip resolved a working torch + demucs
        // combo. The model weights themselves only download on the
        // first real separation.
        model_init: Some(&["python", "-m", "demucs", "--help"]),
        hint: "Нейросетевое разделение вокала и музыки. ~1 ГБ после установки.",
        size_bytes_hint: 1024 * 1024 * 1024,
        gates_modules: false,
    },
];

pub fn python_extra_def(id: &str) -> Option<&'static PythonExtraDef> {
    PYTHON_EXTRAS.iter().find(|e| e.id == id)
}

/// `data/extras/<id>/.venv/`
pub fn venv_dir(id: &str) -> PathBuf {
    paths::data_dir().join("extras").join(id).join(".venv")
}

/// Path to the venv's python interpreter.
pub fn venv_python(id: &str) -> PathBuf {
    let venv = venv_dir(id);
    if cfg!(target_os = "windows") {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Resolve a `runner.py` shipped alongside a python-extra. Each extra
/// can ship one wrapper script in `assets/<id>/runner.py`; this lets us
/// keep CLI surface area tiny on the Rust side and write the
/// model-specific glue in Python where we already have torch.
pub fn bundled_runner<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf> {
    let resource_dir = app.path().resource_dir().context("resource_dir")?;
    let candidate = resource_dir
        .join("assets")
        .join(id)
        .join("runner.py");
    if candidate.exists() {
        return Ok(candidate);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            let dev = dir
                .join("src-tauri")
                .join("assets")
                .join(id)
                .join("runner.py");
            if dev.exists() {
                return Ok(dev);
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    Err(anyhow!("Не нашёл runner.py для {id} ни в Resources, ни в репозитории"))
}

/// Translate a wrapper script's `OMNI {...}\n` status line into a
/// human-readable stage. Lines that don't match the prefix are dropped
/// — they're typically Python tracebacks we already capture elsewhere.
pub fn digest_runner_line(raw: &str) -> Option<String> {
    let line = raw.trim();
    let body = line.strip_prefix("OMNI ")?;
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    parsed.get("stage")?.as_str().map(|s| s.to_string())
}

/// Resolve the bundled `uv` binary. Lives in
/// `<App>.app/Contents/Resources/assets/uv/uv` in production and inside the
/// repo at `src-tauri/assets/uv/uv` in dev.
pub fn bundled_uv<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let resource_dir = app.path().resource_dir().context("resource_dir")?;
    let candidate = resource_dir.join("assets").join("uv").join("uv");
    if candidate.exists() {
        return Ok(candidate);
    }
    // Dev fallback: walk up from the executable until we find a directory
    // containing src-tauri/assets/uv/uv (i.e. the repo root). This makes
    // `cargo tauri dev` Just Work without needing the resource staged.
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            let dev = dir.join("src-tauri").join("assets").join("uv").join("uv");
            if dev.exists() {
                return Ok(dev);
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    Err(anyhow!(
        "Не нашёл встроенный `uv` ни в Resources, ни в репозитории — пересоберите .app"
    ))
}

fn install_marker(id: &str) -> PathBuf {
    paths::data_dir().join("extras").join(id).join(".installed")
}

#[derive(Debug, Clone, Serialize)]
pub struct PythonExtraStatus {
    pub installed: bool,
    pub size_bytes: u64,
    pub message: Option<String>,
}

pub async fn python_extra_status(id: &str) -> PythonExtraStatus {
    let installed = install_marker(id).exists() && venv_python(id).exists();
    let size = if installed {
        dir_size(&paths::data_dir().join("extras").join(id)).unwrap_or(0)
    } else {
        0
    };
    PythonExtraStatus {
        installed,
        size_bytes: size,
        message: None,
    }
}

fn dir_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    if !path.exists() {
        return Ok(0);
    }
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

/// Install (or re-install) a Python-venv extra. Steps:
///   1. `uv venv --python <ver>` → creates `data/extras/<id>/.venv/`
///   2. `uv pip install --python <venv-py> <packages...>`
///   3. Optional `model_init` command
///   4. Touch the `.installed` marker
pub async fn install_python_extra<R: Runtime>(
    app: AppHandle<R>,
    cancel: Arc<AtomicBool>,
    id: String,
) -> Result<PythonExtraStatus> {
    let def = python_extra_def(&id)
        .ok_or_else(|| anyhow!("неизвестный python-extra: {id}"))?;

    let uv = bundled_uv(&app)?;
    log::info!("install_python_extra({id}): uv at {}", uv.display());

    let component_key = leak_str(&format!("py:{}", def.id));
    let extra_dir = paths::data_dir().join("extras").join(&id);
    tokio::fs::create_dir_all(&extra_dir)
        .await
        .context("create extras dir")?;
    let venv = venv_dir(&id);
    let py = venv_python(&id);
    let marker = install_marker(&id);

    // Wipe any stale install marker — nothing's installed until we say so.
    let _ = tokio::fs::remove_file(&marker).await;

    cancel.store(false, Ordering::SeqCst);
    check_cancel(&cancel)?;

    // ---- Phase 1: create venv ------------------------------------------
    emit_stage(&app, component_key, "Создание venv", 0, def.size_bytes_hint);
    let status = Command::new(&uv)
        .args(["venv", "--python", def.python_version])
        .arg(&venv)
        .status()
        .await
        .context("uv venv spawn failed")?;
    if !status.success() {
        bail!("uv venv exit {status}");
    }
    check_cancel(&cancel)?;

    // ---- Phase 2: install packages -------------------------------------
    // Pipe everything through `--verbose`. Without it uv's progress bars
    // detect that stderr isn't a tty and turn into nothing — the pipe
    // sits silent for minutes and the UI shows a frozen 0%. With -v we
    // get one human-readable line per resolved/downloaded/installed
    // wheel that we can surface as the "stage" text.
    //
    // We also disable uv's interactive progress bars explicitly via
    // `UV_NO_PROGRESS=1` so verbose output isn't interleaved with
    // half-rendered ANSI control codes that we'd have to strip.
    emit_stage(
        &app,
        component_key,
        "Установка пакетов (несколько минут)",
        0,
        def.size_bytes_hint,
    );
    let mut args: Vec<String> = vec![
        "pip".into(),
        "install".into(),
        "-v".into(),
        "--python".into(),
        py.to_string_lossy().into_owned(),
    ];
    args.extend(def.packages.iter().map(|p| p.to_string()));
    let mut child = Command::new(&uv)
        .env("UV_NO_PROGRESS", "1")
        .env("PYTHONUNBUFFERED", "1")
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("uv pip install spawn failed")?;
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let app_for_stdout = app.clone();
    let app_for_stderr = app.clone();
    let key = component_key;
    let pump_stdout = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(stage) = digest_uv_line(&line) {
                emit_stage(&app_for_stdout, key, &stage, 0, 0);
            }
        }
    });
    let pump_stderr = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(stage) = digest_uv_line(&line) {
                emit_stage(&app_for_stderr, key, &stage, 0, 0);
            }
        }
    });
    let result = tokio::select! {
        s = child.wait() => s.context("uv pip install wait failed")?,
        _ = wait_for_cancel(&cancel) => {
            let _ = pump_stdout.await;
            let _ = pump_stderr.await;
            bail!("Установка отменена");
        }
    };
    let _ = pump_stdout.await;
    let _ = pump_stderr.await;
    if !result.success() {
        bail!("uv pip install exit {result}");
    }

    // ---- Phase 3: optional model warmup --------------------------------
    if let Some(cmd) = def.model_init {
        emit_stage(&app, component_key, "Подготовка модели", 0, 0);
        let (head, tail) = cmd.split_first().expect("non-empty");
        if head != &"python" {
            bail!("model_init must start with 'python', got {head:?}");
        }
        // Translate the magic "RUNNER" token into the actual path of the
        // wrapper script we ship in Resources. Lets the catalog stay
        // declarative even though the path is build-dependent.
        let runner = bundled_runner(&app, &id).ok();
        let resolved: Vec<String> = tail
            .iter()
            .map(|a| {
                if *a == "RUNNER" {
                    runner
                        .as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "RUNNER".to_string())
                } else {
                    (*a).to_string()
                }
            })
            .collect();
        let mut warmup_child = Command::new(&py)
            .args(&resolved)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("model_init spawn failed")?;
        // Wrapper scripts emit `OMNI {"stage": "..."}\n` on stderr —
        // surface those lines as install progress so the UI doesn't go
        // silent for the multi-minute model download.
        let warm_stderr = warmup_child.stderr.take().expect("piped");
        let app_warm = app.clone();
        let key_warm = component_key;
        let warm_pump = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(warm_stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(stage) = digest_runner_line(&line) {
                    emit_stage(&app_warm, key_warm, &stage, 0, 0);
                }
            }
        });
        let warm_status = warmup_child
            .wait()
            .await
            .context("model_init wait failed")?;
        let _ = warm_pump.await;
        if !warm_status.success() {
            log::warn!(
                "model_init for {id} exited {warm_status}; weights will fetch on first real run"
            );
        }
    }

    // ---- Phase 4: mark installed ---------------------------------------
    tokio::fs::write(&marker, b"ok").await?;

    emit_stage(
        &app,
        component_key,
        "Готово",
        def.size_bytes_hint,
        def.size_bytes_hint,
    );
    Ok(python_extra_status(&id).await)
}

/// Wipe a venv extra. Used when the user wants to free disk space or
/// reinstall after a failed run.
///
/// Emits a `setup://progress` event with stage="Удалено" so dependent
/// modules (Vocal Split's Demucs button, etc.) can refresh themselves
/// without polling for status.
pub async fn uninstall_python_extra<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<()> {
    let extra_dir = paths::data_dir().join("extras").join(id);
    if extra_dir.exists() {
        tokio::fs::remove_dir_all(&extra_dir).await?;
    }
    let component_key: &'static str = leak_str(&format!("py:{id}"));
    emit_stage(app, component_key, "Удалено", 0, 0);
    Ok(())
}

/// Pull a UI-friendly status string out of a single line of uv's verbose
/// output. Returns `None` for chatter we don't want to surface (timing
/// breakdowns, debug noise) so the UI doesn't strobe through it.
///
/// uv prefixes most useful events with marker words like "Downloading",
/// "Installing", "Resolving". We translate the few we care about into
/// Russian; everything else is filtered.
fn digest_uv_line(raw: &str) -> Option<String> {
    let line = strip_ansi(raw).trim().to_string();
    if line.is_empty() {
        return None;
    }
    // uv's own log format: `DEBUG ...` / `INFO ...` / `TRACE ...` —
    // skip the noisy levels entirely. INFO is what carries the
    // human-readable "Downloading torch" lines.
    if line.starts_with("DEBUG") || line.starts_with("TRACE") {
        return None;
    }
    // Useful prefixes — translate inline so the UI stays in Russian
    // without maintaining a separate i18n table. Preserve whatever
    // follows so the user sees the package name + version.
    let lookups: &[(&str, &str)] = &[
        ("Resolved", "Резолв"),
        ("Downloading", "Скачивание"),
        ("Downloaded", "Скачано"),
        ("Preparing", "Подготовка"),
        ("Installing", "Установка"),
        ("Installed", "Установлено"),
        ("Building", "Сборка"),
        ("Built", "Собрано"),
    ];
    for (prefix, ru) in lookups {
        // uv sometimes precedes the verb with whitespace ("   Resolved 12 packages in 100ms")
        // — strip the leading spaces before the prefix check.
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let rest = rest.trim();
            return Some(if rest.is_empty() {
                (*ru).to_string()
            } else {
                format!("{ru}: {rest}")
            });
        }
    }
    // Fall back to surfacing the raw line — at worst it's English and
    // the user sees that something's progressing rather than a frozen UI.
    Some(line)
}

/// Drop ANSI color/cursor codes so the surfaced text looks clean in the
/// progress badge (uv emits them even in `--no-progress` mode for log
/// level coloring).
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for nc in chars.by_ref() {
                if nc.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

async fn wait_for_cancel(cancel: &Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn check_cancel(cancel: &Arc<AtomicBool>) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        bail!("Установка отменена");
    }
    Ok(())
}

fn leak_str(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn emit_stage<R: Runtime>(
    app: &AppHandle<R>,
    component: &'static str,
    stage: &str,
    grand_downloaded: u64,
    grand_total: u64,
) {
    let payload = ProgressPayload {
        component,
        stage: stage.to_string(),
        file: None,
        file_downloaded: 0,
        file_total: 0,
        grand_downloaded,
        grand_total,
    };
    let _ = app.emit(PROGRESS_EVENT, payload);
}
