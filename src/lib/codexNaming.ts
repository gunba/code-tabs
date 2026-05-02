import { dirToTabName } from "./paths";

const GENERIC_CODEX_TAB_NAMES = new Set(["run", "codex", "new session"]);

export function deriveCodexPromptTitle(display: string): string | null {
  const cleaned = display
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_#[\]()>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.startsWith("/")) return null;
  const words = cleaned.match(/[A-Za-z0-9][A-Za-z0-9._/-]*/g) ?? [];
  if (words.length === 0) return null;
  const title = words.slice(0, 7).join(" ");
  return title.length > 54 ? `${title.slice(0, 51).trim()}...` : title;
}

export function codexDefaultTabNameCandidates(
  workingDir: string | null | undefined,
  launchWorkingDir: string | null | undefined,
): string[] {
  return [workingDir, launchWorkingDir]
    .map((dir) => dirToTabName(dir ?? "").trim())
    .filter((name, index, names) => name && names.indexOf(name) === index);
}

export function isAutoNameableCodexName(
  name: string | null | undefined,
  defaultNames: string[],
): boolean {
  if (!name) return true;
  const normalized = name.trim().toLowerCase();
  if (GENERIC_CODEX_TAB_NAMES.has(normalized)) return true;
  return defaultNames.some((defaultName) => normalized === defaultName.trim().toLowerCase());
}
