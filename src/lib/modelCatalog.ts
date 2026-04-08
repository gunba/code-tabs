import type { ProviderModel, ProviderEffort } from "../types/session";
import { ANTHROPIC_MODELS, ANTHROPIC_EFFORTS } from "../types/session";

const MODEL_CONFIG_URL = "https://code.claude.com/docs/en/model-config.md";

// Family colors (WoW rarity) and context windows
const FAMILY_META: Record<string, { color: string; contextWindow: number }> = {
  opus:   { color: "#ff8000", contextWindow: 200000 },
  sonnet: { color: "#a335ee", contextWindow: 200000 },
  haiku:  { color: "#0070dd", contextWindow: 200000 },
};

function classifyAlias(alias: string): { family?: string; contextWindow: number; color?: string } {
  const lower = alias.toLowerCase();
  if (lower.includes("[1m]")) {
    const base = lower.replace("[1m]", "");
    for (const [family, meta] of Object.entries(FAMILY_META)) {
      if (base.includes(family)) return { family, contextWindow: 1000000, color: meta.color };
    }
    return { contextWindow: 1000000 };
  }
  for (const [family, meta] of Object.entries(FAMILY_META)) {
    if (lower.includes(family) || lower === "best" || lower === "opusplan") {
      const f = (lower === "best" || lower === "opusplan") ? "opus" : family;
      return { family: f, contextWindow: meta.contextWindow, color: meta.color };
    }
  }
  return { contextWindow: 200000 };
}

/**
 * Parse model aliases from the Claude Code model-config.md page.
 * Extracts the markdown table under "### Model aliases".
 */
function parseModelAliases(md: string): ProviderModel[] {
  const models: ProviderModel[] = [];

  // Find the table rows — lines starting with | **`...`** |
  const aliasPattern = /\|\s*\*\*`([^`]+)`\*\*\s*\|/g;
  let match;
  while ((match = aliasPattern.exec(md)) !== null) {
    const alias = match[1];
    // Skip "default" — it's not a real model alias
    if (alias === "default") continue;

    const meta = classifyAlias(alias);
    models.push({
      id: alias,
      label: alias,
      family: meta.family,
      contextWindow: meta.contextWindow,
      color: meta.color,
    });
  }

  return models;
}

/**
 * Parse effort levels from the docs page.
 * Looks for: "low", "medium", "high", "max" in the effort section.
 */
function parseEffortLevels(md: string): ProviderEffort[] {
  // The effort levels are well-established — just verify they're mentioned
  const levels: ProviderEffort[] = [];
  for (const level of ["low", "medium", "high", "max"]) {
    if (md.includes(`**\`${level}\`**`) || md.includes(`\`${level}\``) || md.includes(`"${level}"`)) {
      levels.push({ value: level, label: level });
    }
  }
  return levels.length >= 3 ? levels : ANTHROPIC_EFFORTS;
}

/**
 * Fetch the Claude Code model config docs and extract model aliases + effort levels.
 * Falls back to static defaults on any failure.
 */
export async function fetchAnthropicModelCatalog(): Promise<{
  models: ProviderModel[];
  efforts: ProviderEffort[];
}> {
  try {
    const resp = await fetch(MODEL_CONFIG_URL);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const md = await resp.text();

    const models = parseModelAliases(md);
    const efforts = parseEffortLevels(md);

    if (models.length === 0) throw new Error("No models parsed");

    return { models, efforts };
  } catch {
    return { models: ANTHROPIC_MODELS, efforts: ANTHROPIC_EFFORTS };
  }
}
