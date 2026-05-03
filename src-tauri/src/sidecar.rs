//! Manages the Python worker subprocess and exposes its discovery info.
//!
//! Spawned at app startup; the worker prints ``WORKER_READY <port>`` on its
//! stdout and we keep the port in shared state for the pipeline module.
//! ``kill_on_drop`` ensures the worker dies with the parent.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};

const READY_PREFIX: &str = "WORKER_READY ";

#[derive(Debug, Clone)]
pub struct SidecarInfo {
    pub port: u16,
}

#[derive(Default)]
pub struct SidecarState {
    pub info: Mutex<Option<SidecarInfo>>,
    /// Hold the child so it doesn't get reaped early. Wrapped in Mutex to
    /// keep the type Send-friendly across the Tauri state boundary.
    child: Mutex<Option<Child>>,
    /// Hold the write-end of the child's stdin pipe. We never write to it —
    /// its sole purpose is to give the worker a reliable EOF when this
    /// process dies, so it can self-terminate even if `kill_on_drop` is
    /// bypassed (parent crash, force-kill, etc.).
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
}

pub fn manage<R: Runtime>(app: &mut tauri::App<R>) {
    app.manage(SidecarState::default());
}

/// Walk up from the executable to find the project root (in dev) — production
/// will ship a bundled sidecar binary instead and this falls through.
fn project_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut cur = exe.parent()?.to_path_buf();
    loop {
        if cur.join("package.json").exists() && cur.join("python-sidecar").exists() {
            return Some(cur);
        }
        cur = cur.parent()?.to_path_buf();
    }
}

/// Try to locate the bundled, PyInstaller-built sidecar binary that ships
/// with a release build. We register it in `tauri.conf.json::bundle.resources`
/// as `binaries/*`, which means:
///   - macOS  →  `<App>.app/Contents/Resources/binaries/worker-<triple>`
///   - Windows →  `<install-dir>/resources/binaries/worker-<triple>.exe`
///   - Linux  →  `<install-dir>/resources/binaries/worker-<triple>`
/// We also probe alongside the executable for portable / dev cases.
fn bundled_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();
    let triples: &[&str] = &[
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
    ];
    let mut search_dirs: Vec<PathBuf> = vec![exe_dir.join("binaries"), exe_dir.clone()];
    // macOS .app layout: exe lives in Contents/MacOS, resources in Contents/Resources.
    if let Some(contents) = exe_dir.parent() {
        search_dirs.push(contents.join("Resources").join("binaries"));
        search_dirs.push(contents.join("Resources"));
    }
    for dir in &search_dirs {
        for t in triples {
            for ext in ["", ".exe"] {
                let p = dir.join(format!("worker-{t}{ext}"));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

enum Launcher {
    /// Single self-contained binary (PyInstaller / production bundle).
    Binary(PathBuf),
    /// Dev fallback: invoke `<venv-python> -m worker.main` from the source tree.
    Venv { python: PathBuf, cwd: PathBuf },
}

fn pick_launcher() -> Result<Launcher> {
    if let Some(bin) = bundled_sidecar() {
        return Ok(Launcher::Binary(bin));
    }
    let root = project_root().ok_or_else(|| {
        anyhow!(
            "Не нашёл ни упакованный sidecar-бинарь, ни корень проекта. \
             В production это значит, что бинарь не положили рядом с приложением; \
             в dev — что приложение запущено вне репозитория."
        )
    })?;
    let py = root.join("python-sidecar/.venv/bin/python");
    if !py.exists() {
        return Err(anyhow!(
            "Python venv не найден: {} — выполните `cd python-sidecar && uv sync`",
            py.display()
        ));
    }
    Ok(Launcher::Venv {
        python: py,
        cwd: root.join("python-sidecar"),
    })
}

pub async fn spawn<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let launcher = pick_launcher()?;
    let mut cmd = match &launcher {
        Launcher::Binary(bin) => {
            log::info!("spawning bundled sidecar: {:?}", bin);
            let mut c = Command::new(bin);
            // No cwd — the binary is self-contained.
            c.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            c
        }
        Launcher::Venv { python, cwd } => {
            log::info!("spawning python sidecar: {:?} -m worker.main", python);
            let mut c = Command::new(python);
            c.args(["-m", "worker.main"])
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            c
        }
    };

    let mut child: Child = cmd.spawn().context("spawn python sidecar failed")?;

    let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

    // Drain stderr → app log.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::info!("[worker] {line}");
        }
    });

    let port = read_ready_port(stdout).await?;
    log::info!("python sidecar ready on 127.0.0.1:{port}");

    let state = app.state::<SidecarState>();
    *state.info.lock() = Some(SidecarInfo { port });
    *state.child.lock() = Some(child);
    *state.stdin.lock() = Some(stdin);
    Ok(())
}

async fn read_ready_port<R: AsyncRead + Unpin>(reader: R) -> Result<u16> {
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        if let Some(rest) = line.strip_prefix(READY_PREFIX) {
            return rest.trim().parse().context("invalid READY port");
        }
        log::info!("[worker stdout] {line}");
    }
    Err(anyhow!("sidecar exited before READY"))
}
