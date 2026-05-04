mod commands;
mod fonts;
mod paths;
mod pipeline;
mod presets;
mod preview;
mod proc;
mod queue;
mod settings;
mod srt_io;
mod setup;
mod sidecar;

use tauri::Manager;

/// Initialize logging. We tee env_logger to a file *and* stderr.
///
/// On Windows release builds the exe runs under the `windows` subsystem with
/// no attached console, so anything written to stderr is silently dropped —
/// without a file sink we'd be debugging blind in production. On macOS the
/// app *does* have stderr inside Console.app, but a colocated file makes
/// support requests ("send me your log") trivial on every platform.
fn init_logging() {
    use std::fs::OpenOptions;

    let logs_dir = paths::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let log_path = logs_dir.join("app.log");

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    let mut builder = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    if let Some(file) = file {
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }
    let _ = builder.try_init();
    log::info!("=== app start, log: {} ===", log_path.display());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

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
            commands::get_settings,
            commands::setup_status,
            commands::download_whisper,
            commands::download_ffmpeg,
            commands::cancel_download,
            commands::list_extras,
            commands::extra_status,
            commands::download_extra,
            commands::cancel_extra,
            commands::chroma_key_run,
            commands::chroma_key_cancel,
            commands::audio_fix_run,
            commands::audio_fix_cancel,
            commands::util_trim,
            commands::util_convert,
            commands::util_overlay,
            commands::utils_cancel,
            commands::probe_video_duration,
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
