//! Tiny cross-platform process helpers.
//!
//! Все наши «отмены» FFmpeg-ов сейчас делают одно и то же: знают PID
//! ребёнка и просят ОС его убить. На Unix это `kill <pid>` (SIGTERM),
//! на Windows — `taskkill /F /PID <pid>`. Один helper, чтобы не разводить
//! `#[cfg(...)]` в трёх местах.

/// Best-effort terminate by PID. Возвращает `true`, если ОС подтвердила
/// успешный exit-status у kill/taskkill — но мы всё равно никогда не паникуем
/// на ошибке (процесс мог уже умереть сам).
pub fn kill_pid(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .arg(pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        // /F = force, /T убивает дерево процессов (на случай, если ffmpeg
        // когда-нибудь обзаведётся children — сейчас не нужен, но дёшево).
        std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
