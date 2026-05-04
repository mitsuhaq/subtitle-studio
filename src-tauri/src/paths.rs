use std::path::{Path, PathBuf};

const DATA_DIR_NAME: &str = "data";
const SUBDIRS: &[&str] = &["models", "ffmpeg", "logs", "cache", "presets"];

/// App folder under platform user-data roots. Stays in sync with
/// `productName` in `tauri.conf.json` so an upgrade never strands the old
/// data; if you rename the product, migrate this constant in lockstep.
const APP_DIR_NAME: &str = "Zonthor Studio";

/// Resolve the user-writable `data/` directory.
///
/// Layout per platform:
///   * Dev (`cargo tauri dev`): repo's `<root>/data/`. Keeps everything in
///     the project so contributors can wipe `target/` without losing models.
///   * macOS production: sibling of the `.app` bundle. Lets the user move
///     the app + data folder as a pair onto an external drive.
///   * Windows production: `%APPDATA%\Zonthor Studio\data\`. NSIS installs
///     into `C:\Program Files\…` which is read-only for non-admin processes,
///     so we cannot keep `data/` next to the exe.
///   * Linux production: `$XDG_DATA_HOME/Zonthor Studio/data/` (≡
///     `~/.local/share/Zonthor Studio/data/`).
pub fn data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let parent = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        // Dev: walk out of `target/...` to the project root.
        if is_inside_target(&parent) {
            if let Some(root) = walk_up_to_project_root(&parent) {
                return root.join(DATA_DIR_NAME);
            }
        }
        if let Some(app_sibling) = macos_app_sibling(&parent) {
            return app_sibling.join(DATA_DIR_NAME);
        }
        // Backwards-compat: if the install dir is itself user-writable AND
        // already has a non-empty `data/` from a previous version, keep
        // using it so an upgrade doesn't strand whatever the user already
        // downloaded (whisper model is ~3 GB — re-downloading would be
        // hostile). New installs go straight to %APPDATA% (or platform
        // equivalent) since C:\Program Files\… is read-only by default.
        let next_to_exe = parent.join(DATA_DIR_NAME);
        if next_to_exe.is_dir() && dir_has_any_entry(&next_to_exe) {
            return next_to_exe;
        }
    }
    platform_user_data_dir().join(DATA_DIR_NAME)
}

fn dir_has_any_entry(p: &Path) -> bool {
    std::fs::read_dir(p)
        .ok()
        .and_then(|mut it| it.next())
        .is_some()
}

#[cfg(windows)]
fn platform_user_data_dir() -> PathBuf {
    // %APPDATA% (= FOLDERID_RoamingAppData) is the canonical location for
    // user-writable app data on Windows. Falling back to %USERPROFILE% if
    // it ever resolves empty keeps us out of \ProgramData (system-wide,
    // also requires admin).
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Roaming")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_DIR_NAME)
}

#[cfg(target_os = "macos")]
fn platform_user_data_dir() -> PathBuf {
    // Reached only if the exe isn't inside an .app bundle (e.g. a stripped
    // standalone binary placed somewhere ad-hoc). Mirror Apple's recommended
    // user-data path so we still write to a stable location.
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join("Library").join("Application Support").join(APP_DIR_NAME)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_user_data_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join(APP_DIR_NAME);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local").join("share").join(APP_DIR_NAME)
}

/// If `exe_dir` looks like `<X>.app/Contents/MacOS`, return `<X>.app`'s parent.
/// Returns `None` on every other layout (Windows, Linux, dev, portable .exe).
fn macos_app_sibling(exe_dir: &Path) -> Option<PathBuf> {
    // exe_dir = <App>.app/Contents/MacOS
    if exe_dir.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = exe_dir.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    let stem = app.file_name()?.to_str()?;
    if !stem.ends_with(".app") {
        return None;
    }
    app.parent().map(Path::to_path_buf)
}

fn is_inside_target(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "target")
}

fn walk_up_to_project_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent.join("package.json").exists() && parent.join("src-tauri").exists() {
            return Some(parent.to_path_buf());
        }
        current = parent.to_path_buf();
    }
    None
}

pub fn ensure_data_dirs() -> Result<(), Box<dyn std::error::Error>> {
    let root = data_dir();
    std::fs::create_dir_all(&root)?;
    for sub in SUBDIRS {
        std::fs::create_dir_all(root.join(sub))?;
    }
    let settings = root.join("settings.json");
    if !settings.exists() {
        std::fs::write(&settings, b"{}\n")?;
    }
    log::info!("portable data dir: {}", root.display());
    Ok(())
}
