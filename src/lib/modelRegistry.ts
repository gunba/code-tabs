/** Known model families: keyword -> display label + CSS color. */
export const MODEL_FAMILIES: Array<{ keyword: string; label: string; color: string }> = [
  { keyword: "opus", label: "Opus", color: "var(--rarity-legendary)" },
  { keyword: "sonnet", label: "Sonnet", color: "var(--rarity-epic)" },
  { keyword: "haiku", label: "Haiku", color: "var(--rarity-rare)" },
];

export function resolveModelFamily(model: string | null): (typeof MODEL_FAMILIES)[number] | null {
  if (!model) return null;
  return MODEL_FAMILIES.find((f) => model.includes(f.keyword)) ?? null;
}

/** Entry in the runtime model registry, populated from tap events. */
export interface ModelRegistryEntry {
  modelId: string;
  family: string;
  contextWindowSize: number;
  lastSeenAt: number;
}

/** Resolve a model family + context variant to a CLI-compatible model string. */
export function resolveModelId(
  family: string,
  variant: "200k" | "1m",
  registry: ModelRegistryEntry[],
): string {
  if (variant === "200k") return family;
  const entry = registry.find(e => e.family === family && e.modelId.includes("[1m]"));
  if (entry) return entry.modelId;
  return family;
}

/** Model display label. */
export function modelLabel(model: string | null): string {
  return resolveModelFamily(model)?.label ?? model ?? "Default";
}

/** CSS color for model name in tab metadata. */
export function modelColor(model: string | null): string {
  return resolveModelFamily(model)?.color ?? "var(--text-muted)";
}

/** CSS color for effort level (WoW rarity hierarchy). */
export function effortColor(effort: string | null): string {
  switch (effort) {
    case "high": return "var(--rarity-epic)";
    case "xhigh":
    case "max": return "var(--rarity-legendary)";
    default: return "var(--text-muted)";
  }
}
