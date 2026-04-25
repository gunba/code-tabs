// [PM-06] formatMetrics: formatBytes, formatCpu, cpuColor (amber>=30%, red>=70%), memColor (amber>=500MB, red>=1GB)
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)}MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
}

export function formatCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return "0%";
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export function cpuColor(percent: number): string {
  if (percent >= 70) return "var(--error)";
  if (percent >= 30) return "var(--warning)";
  return "var(--text-secondary)";
}

export function memColor(bytes: number): string {
  if (bytes >= 1_000_000_000) return "var(--error)";
  if (bytes >= 500_000_000) return "var(--warning)";
  return "var(--text-secondary)";
}
