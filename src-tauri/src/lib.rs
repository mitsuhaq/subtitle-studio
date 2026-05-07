mod commands;
mod fonts;
mod paths;
mod pipeline;
mod presets;
mod preview;
mod queue;
mod settings;
mod srt_io;
mod setup;
mod setup_venv;
mod sidecar;

use tauri::Manager;

/// Pin TMPDIR to a directory on the same filesystem as the executable so
/// the in-app updater can `rename()` the freshly downloaded `.app` over the
/// installed one without tripping `EXDEV` (Cross-device link, OS error 18).
///
/// Reproducer: `.app` lives on an external SSD, system tempdir is on the
/// internal disk → `tempfile::NamedTempFile::persist()` (called by
/// `tauri_plugin_updater` to swap the bundle in place) fails with EXDEV
/// because rename can't cross filesystem boundaries.
fn pin_tmpdir_near_exe() {
    let Ok(exe) = std::env::current_exe() else { return };
    // For a Mac .app the layout is `…/Foo.app/Contents/MacOS/foo`.
    // Walk up to the directory that *contains* the .app so the temp dir
    // sits beside the bundle (and on the same volume) rather than inside
    // the bundle's signed contents.
    let target_parent = exe
        .ancestors()
        .find(|p| {
            p.extension().map(|e| e == "app").unwrap_or(false)
        })
        .and_then(|app| app.parent())
        .or_else(|| exe.parent());
    let Some(parent) = target_parent else { return };
    let tmpdir = parent.join(".zonthor_updater_tmp");
    if std::fs::create_dir_all(&tmpdir).is_ok() {
        std::env::set_var("TMPDIR", &tmpdir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    pin_tmpdir_near_exe();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            paths::ensure_data_dirs()?;
            if let Err(e) = presets::seed_defaults_if_empty() {
                log::warn!("preset seed failed: {e:#}");
            }
            fonts::warm_cache();
            let settings = settings::SettingsStore::load();
            app.manage(settings);
            setup::manage_flags(app);
            sidecar::manage(app);
            pipeline::manage(app);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sidecar::spawn(handle).await {
                    log::error!("sidecar spawn failed: {e:#}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::data_dir,
            commands::ping,
            commands::probe_video_duration,
            commands::probe_video_dimensions,
            commands::logo_remover_run,
            commands::logo_remover_cancel,
            commands::logo_ticker_run,
            commands::logo_ticker_cancel,
            commands::vocal_split_run,
            commands::vocal_split_demucs_run,
            commands::vocal_split_cancel,
            commands::list_python_extras,
            commands::python_extra_status,
            commands::install_python_extra,
            commands::cancel_python_extra,
            commands::uninstall_python_extra,
            commands::get_settings,
            commands::setup_status,
            commands::download_whisper,
            commands::download_ffmpeg,
            commands::cancel_download,
            commands::list_extras,
            commands::extra_status,
            commands::download_extra,
            commands::cancel_extra,
            commands::uninstall_extra,
            commands::chroma_key_run,
            commands::chroma_key_cancel,
            commands::audio_fix_run,
            commands::audio_fix_cancel,
            commands::util_trim,
            commands::util_convert,
            commands::util_overlay,
            commands::utils_cancel,
            commands::pick_ffmpeg,
            commands::open_data_dir,
            commands::sidecar_status,
            commands::default_srt_path,
            commands::transcribe_video,
            commands::cancel_transcription,
            commands::reburn_video,
            commands::list_videos_in_folder,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::save_last_style,
            commands::set_output_dir,
            commands::set_module_output_dir,
            commands::list_fonts,
            commands::extract_preview_frame,
            commands::render_styled_preview,
            commands::reveal_in_shell,
            commands::load_queue,
            commands::save_queue,
            commands::read_srt,
            commands::write_srt,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zonthor Studio");
}
