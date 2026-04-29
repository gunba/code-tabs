export type HeatLevel = -1 | 0 | 1 | 2 | 3 | 4;

/** [CB-12] Compute heat level for command frequency (WoW rarity). */
export function computeHeatLevel(count: number, rank: number, totalUsed: number): HeatLevel {
  if (count <= 0 || totalUsed <= 0) return -1;
  if (totalUsed <= 5) {
    const tier = 4 - rank;
    if (tier < 0) return 0;
    if (tier > 4) return 4;
    return tier as 0 | 1 | 2 | 3 | 4;
  }
  const bucket = Math.min(4, Math.floor((rank * 5) / totalUsed));
  return (4 - bucket) as 0 | 1 | 2 | 3 | 4;
}

/** [CB-10] CSS class for heat level: grey, white, green, blue, purple, orange. */
export function heatClassName(level: HeatLevel): string {
  if (level < 0) return "heat-unused";
  return `heat-${level}`;
}

/** Format token count compactly: 0, 42, 2.3K, 36K, 1.2M. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
