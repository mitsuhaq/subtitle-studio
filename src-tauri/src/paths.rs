use std::path::{Path, PathBuf};

const DATA_DIR_NAME: &str = "data";
const SUBDIRS: &[&str] = &["models", "ffmpeg", "logs", "cache", "presets"];

/// Resolve the portable `data/` directory next to the executable.
///
/// Production: `<dir-of-app-binary>/data/` — for true portability the
/// binary and `data/` travel together.
///
/// Dev (`cargo tauri dev`): the binary lives under `src-tauri/target/...`,
/// so we walk up looking for the project root (the one with `package.json`
/// and `src-tauri/`) and use `<root>/data/` instead. This keeps the dev
/// data folder out of the cargo target tree.
pub fn data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        let parent = exe.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        // Dev: walk out of `target/...` to the project root.
        if is_inside_target(&parent) {
            if let Some(root) = walk_up_to_project_root(&parent) {
                return root.join(DATA_DIR_NAME);
            }
        }
        // macOS .app bundle: exe lives in <App>.app/Contents/MacOS/<exe>.
        // Put `data/` *next to* the .app so the bundle stays untouched
        // (code signing + updates) and the user can move both as a pair.
        if let Some(app_sibling) = macos_app_sibling(&parent) {
            return app_sibling.join(DATA_DIR_NAME);
        }
        return parent.join(DATA_DIR_NAME);
    }
    PathBuf::from(DATA_DIR_NAME)
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
