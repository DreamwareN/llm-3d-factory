export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function truncate(value: string, length = 120): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
