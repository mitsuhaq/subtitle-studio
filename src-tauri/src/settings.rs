use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::pipeline::SubtitleStyle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Settings {
    /// Absolute path to the FFmpeg binary inside `data/ffmpeg/`.
    pub ffmpeg_path: Option<PathBuf>,
    /// Absolute path to the Whisper model directory inside `data/models/<id>/`.
    pub whisper_model_dir: Option<PathBuf>,
    /// Optional override URL for the FFmpeg portable archive (skips evermeet/BtbN auto-resolve).
    pub ffmpeg_url_override: Option<String>,
    /// Last subtitle style the user clicked Запустить with — auto-restored on
    /// next session so the form opens with their previous tweaks instead of
    /// resetting to defaults.
    pub last_style: Option<SubtitleStyle>,
    /// Optional override directory for `.srt` and `_subtitled.<ext>` outputs.
    /// `None` ≡ "next to the source video" (legacy behaviour).
    pub output_dir: Option<PathBuf>,
}

#[derive(Clone, Default)]
pub struct SettingsStore {
    inner: Arc<RwLock<Settings>>,
}

impl SettingsStore {
    pub fn load() -> Self {
        let store = Self::default();
        let path = settings_path();
        if let Ok(bytes) = std::fs::read(&path) {
            match serde_json::from_slice::<Settings>(&bytes) {
                Ok(parsed) => *store.inner.write() = parsed,
                Err(err) => log::warn!("settings.json parse failed: {err}; using defaults"),
            }
        }
        store
    }

    pub fn snapshot(&self) -> Settings {
        self.inner.read().clone()
    }

    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> std::io::Result<()> {
        {
            let mut guard = self.inner.write();
            f(&mut guard);
        }
        self.persist()
    }

    fn persist(&self) -> std::io::Result<()> {
        let snap = self.snapshot();
        let json = serde_json::to_vec_pretty(&snap)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let target = settings_path();
        let tmp = target.with_extension("json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &target)?;
        Ok(())
    }
}

fn settings_path() -> PathBuf {
    paths::data_dir().join("settings.json")
}
