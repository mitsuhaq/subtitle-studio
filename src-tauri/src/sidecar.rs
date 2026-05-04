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

/// Try to locate the bundled sidecar binary that ships with a release build.
///
/// `bundle.externalBin` strips the `-<triple>` suffix when staging the file
/// into the installer (Tauri's design: by the time the bundle ships it is
/// platform-specific anyway, so the triple becomes redundant). The binary
/// therefore lands as plain `worker(.exe)` next to the main executable.
///
/// We still probe the legacy triple-suffixed name as a fallback for:
///   * dev / portable layouts where the file was hand-staged
///   * any old `bundle.resources`-style installation that's still around
///
/// Layouts checked, in order:
///   - Windows / portable: `<exe-dir>/worker(.exe)`
///   - macOS .app:         `<App>.app/Contents/MacOS/worker`
///   - Legacy resources:   `<exe-dir>/binaries/worker-<triple>(.exe)` and
///                          `<App>.app/Contents/Resources/binaries/...`
fn bundled_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?.to_path_buf();

    // Modern externalBin layout: `worker(.exe)` right next to the main exe.
    for ext in ["", ".exe"] {
        let p = exe_dir.join(format!("worker{ext}"));
        if p.exists() {
            return Some(p);
        }
    }
    // macOS .app: Contents/MacOS is exe_dir; sometimes externalBin writes
    // into Contents/Resources instead — check both for safety.
    if let Some(contents) = exe_dir.parent() {
        for ext in ["", ".exe"] {
            let p = contents.join("Resources").join(format!("worker{ext}"));
            if p.exists() {
                return Some(p);
            }
        }
    }

    // Legacy / dev layouts with the full triple in the filename.
    let triples: &[&str] = &[
        "aarch64-apple-darwin",
        "x86_64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-gnu",
        "aarch64-unknown-linux-gnu",
    ];
    let mut search_dirs: Vec<PathBuf> = vec![exe_dir.join("binaries"), exe_dir.clone()];
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
    // venv-layout зависит от платформы: Unix даёт `.venv/bin/python`,
    // Windows — `.venv\Scripts\python.exe`. Symlink-альтернативы там нет,
    // выбираем строго по cfg.
    let venv = root.join("python-sidecar").join(".venv");
    let py = if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    };
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
    // Force the worker to emit UTF-8 on stdout/stderr regardless of the
    // host console's codepage. On a Russian-locale Windows the default is
    // cp1251, which kills any log record containing dashes / arrows.
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");

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
