import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export const VIDEO_EXTS = ["mp4", "mov", "mkv", "avi", "webm", "flv", "m4v"] as const;

export type Component = "whisper" | "ffmpeg";

export interface ComponentStatus {
  installed: boolean;
  path: string | null;
  size_bytes: number;
  version: string | null;
  message: string | null;
}

export interface SetupStatus {
  whisper: ComponentStatus;
  ffmpeg: ComponentStatus;
  data_dir: string;
}

export interface ProgressPayload {
  component: Component;
  stage: string;
  file: string | null;
  file_downloaded: number;
  file_total: number;
  grand_downloaded: number;
  grand_total: number;
}

export interface AppSettings {
  ffmpeg_path: string | null;
  whisper_model_dir: string | null;
  ffmpeg_url_override: string | null;
  last_style: SubtitleStyle | null;
  output_dir: string | null;
}

export interface Preset {
  name: string;
  style: SubtitleStyle;
}

export const getDataDir = () => invoke<string>("data_dir");
export const ping = () => invoke<string>("ping");
export const getSettings = () => invoke<AppSettings>("get_settings");

export const setupStatus = () => invoke<SetupStatus>("setup_status");

export const downloadWhisper = () => invoke<SetupStatus>("download_whisper");

export const downloadFfmpeg = () => invoke<SetupStatus>("download_ffmpeg");

export const cancelDownload = (component: Component) =>
  invoke<void>("cancel_download", { component });

export const pickFfmpeg = (path: string) =>
  invoke<SetupStatus>("pick_ffmpeg", { path });

export const openDataDir = () => invoke<{ ok: boolean }>("open_data_dir");

export function onProgress(
  cb: (p: ProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("setup://progress", (e) => cb(e.payload));
}

export function onStatus(cb: (s: SetupStatus) => void): Promise<UnlistenFn> {
  return listen<SetupStatus>("setup://status", (e) => cb(e.payload));
}

export async function pickFfmpegFile(): Promise<string | null> {
  const result = await openDialog({
    title: "Выберите бинарь FFmpeg",
    multiple: false,
    directory: false,
  });
  if (!result) return null;
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

// ---------------------------------------------------------------------------
// Pipeline (transcribe)
// ---------------------------------------------------------------------------

export interface SidecarStatusInfo {
  running: boolean;
  port: number | null;
}

export interface SubtitleStyle {
  font_family: string;
  font_size: number;
  primary_color: string;
  outline_color: string;
  back_color: string;
  /** Box fill alpha as percent: 0=transparent, 100=fully opaque. */
  back_alpha: number;
  bold: boolean;
  italic: boolean;
  outline_width: number;
  shadow_offset: number;
  /** 1 = outline + drop shadow; 3 = opaque box (uses bg_padding instead). */
  border_style: number;
  alignment: number;
  margin_v: number;
  margin_l: number;
  margin_r: number;
  /** Padding around text in opaque-box mode (px). Ignored when border_style=1. */
  bg_padding: number;
}

export const DEFAULT_STYLE: SubtitleStyle = {
  font_family: "Inter",
  font_size: 38,
  primary_color: "#FFFFFF",
  outline_color: "#000000",
  back_color: "#000000",
  back_alpha: 70,
  bold: true,
  italic: false,
  outline_width: 2.5,
  shadow_offset: 1.0,
  border_style: 1,
  alignment: 2,
  margin_v: 50,
  margin_l: 60,
  margin_r: 60,
  bg_padding: 8,
};

export interface TranscribeOptions {
  language?: string | null;
  translate?: boolean;
  vad?: boolean;
  beam_size?: number;
  max_chars?: number;
  min_duration?: number;
  max_duration?: number;
  target_cps?: number;
  burn_in?: boolean;
  style?: SubtitleStyle;
}

export interface TranscribeResult {
  cues_count: number;
  duration: number;
  detected_language: string | null;
  language_probability: number | null;
  output_srt: string;
  output_ass: string | null;
  output_video: string | null;
}

export interface PipelineProgress {
  stage: string;
  detail: string | null;
  pos: number;
  total: number;
}

export const sidecarStatus = () =>
  invoke<SidecarStatusInfo>("sidecar_status");

export const defaultSrtPath = (videoPath: string) =>
  invoke<string>("default_srt_path", { videoPath });

export const transcribeVideo = (
  videoPath: string,
  outputSrt: string,
  options?: TranscribeOptions,
) =>
  invoke<TranscribeResult>("transcribe_video", {
    videoPath,
    outputSrt,
    options,
  });

export const cancelTranscription = () =>
  invoke<void>("cancel_transcription");

export const reburnVideo = (
  videoPath: string,
  srtPath: string,
  style: SubtitleStyle,
) =>
  invoke<string>("reburn_video", { videoPath, srtPath, style });

export const listVideosInFolder = (folder: string, recursive: boolean) =>
  invoke<string[]>("list_videos_in_folder", { folder, recursive });

// ---------------------------------------------------------------------------
// SRT editor
// ---------------------------------------------------------------------------

export interface SrtCue {
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export const readSrt = (path: string) => invoke<SrtCue[]>("read_srt", { path });
export const writeSrt = (path: string, cues: SrtCue[]) =>
  invoke<void>("write_srt", { path, cues });

// ---------------------------------------------------------------------------
// Persistent queue
// ---------------------------------------------------------------------------

export const loadQueue = () => invoke<string[]>("load_queue");
export const saveQueue = (paths: string[]) =>
  invoke<void>("save_queue", { paths });

// ---------------------------------------------------------------------------
// Style presets
// ---------------------------------------------------------------------------

export const listPresets = () => invoke<Preset[]>("list_presets");

export const savePreset = (name: string, style: SubtitleStyle) =>
  invoke<Preset>("save_preset", { name, style });

export const deletePreset = (name: string) =>
  invoke<void>("delete_preset", { name });

export const saveLastStyle = (style: SubtitleStyle) =>
  invoke<void>("save_last_style", { style });

export const setOutputDir = (path: string | null) =>
  invoke<AppSettings>("set_output_dir", { path });

// ---------------------------------------------------------------------------
// System fonts
// ---------------------------------------------------------------------------

export const listFonts = () => invoke<string[]>("list_fonts");

// ---------------------------------------------------------------------------
// Preview frame
// ---------------------------------------------------------------------------

export const extractPreviewFrame = (videoPath: string) =>
  invoke<string>("extract_preview_frame", { videoPath });

export const renderStyledPreview = (
  videoPath: string,
  style: SubtitleStyle,
  text: string,
) =>
  invoke<string>("render_styled_preview", { videoPath, style, text });

export async function pickFolder(): Promise<string | null> {
  const result = await openDialog({
    title: "Выберите папку с видео",
    multiple: false,
    directory: true,
  });
  if (!result) return null;
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

export function onPipelineProgress(
  cb: (p: PipelineProgress) => void,
): Promise<UnlistenFn> {
  return listen<PipelineProgress>("pipeline://progress", (e) => cb(e.payload));
}

export async function pickVideoFile(): Promise<string | null> {
  const result = await openDialog({
    title: "Выберите видео",
    multiple: false,
    directory: false,
    filters: [{ name: "Видео", extensions: [...VIDEO_EXTS] }],
  });
  if (!result) return null;
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

export const revealInShell = (path: string) =>
  invoke<void>("reveal_in_shell", { path });

// ---------------------------------------------------------------------------
// Native desktop notifications
// ---------------------------------------------------------------------------

/**
 * Fire a desktop notification (macOS Notification Center / Windows toast)
 * AND play a short tone via Web Audio. The tone is the reliable bit —
 * macOS often suppresses the OS notification sound (per-app override in
 * System Settings → Notifications), so we don't rely on it.
 */
export async function notify(title: string, body?: string): Promise<void> {
  playDing();
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const r = await requestPermission();
      granted = r === "granted";
    }
    if (granted) sendNotification({ title, body, sound: "default" });
  } catch (err) {
    console.warn("notify failed", err);
  }
}

let audioCtx: AudioContext | null = null;

/**
 * Two-note rising "ding" via WebAudio — works regardless of OS notification
 * settings. Volume is gentle so it doesn't blast the user mid-edit.
 */
function playDing(): void {
  try {
    audioCtx ??= new (window.AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).webkitAudioContext)();
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") void audioCtx.resume();

    const now = audioCtx.currentTime;
    const tones: { freq: number; start: number; dur: number }[] = [
      { freq: 880, start: 0, dur: 0.16 }, // A5
      { freq: 1318.51, start: 0.13, dur: 0.22 }, // E6
    ];
    for (const t of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = t.freq;
      // Quick attack, gentle decay envelope.
      gain.gain.setValueAtTime(0, now + t.start);
      gain.gain.linearRampToValueAtTime(0.18, now + t.start + 0.01);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + t.start + t.dur,
      );
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + t.start);
      osc.stop(now + t.start + t.dur);
    }
  } catch (err) {
    console.warn("playDing failed", err);
  }
}
