const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(0)} KB`;
  return `${n} B`;
}

export function pct(downloaded: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (downloaded / total) * 100));
}
