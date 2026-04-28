/**
 * Theme system for Code Tabs.
 *
 * // [TH-01] All colors are CSS custom properties on :root — components use var(--x), not hardcoded hex.
 * // [TH-02] Key variables: --bg-primary, --bg-surface, --accent (provider-scoped alias), --accent-secondary (blue), --accent-tertiary (purple), --term-bg, --term-fg
 * Components use var(--color-name) instead of hardcoded hex values.
 * The meta-agent (or any automation) can change themes by calling applyTheme().
 */

export interface Theme {
  name: string;
  colors: {
    // Backgrounds
    bgPrimary: string;       // Main background (terminal, empty state)
    bgSurface: string;       // Elevated surfaces (tab bar, status bar, modals)
    bgSurfaceHover: string;  // Surface on hover
    bgSelection: string;     // Selected/highlighted items

    // Borders
    border: string;
    borderSubtle: string;    // Lighter borders (separators)

    // Text
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    textOnAccent: string;    // Text on accent-colored backgrounds

    // Accent
    accent: string;          // Default primary provider color (Claude clay at :root)
    accentHover: string;
    accentBg: string;        // Accent tinted background (active tab, selected button)
    accentSecondary: string; // Secondary accent (soft blue)
    accentTertiary: string;  // Tertiary accent (purple/magenta for tool banners)
    cliClaude: string;       // Claude identity color
    cliClaudeBg: string;     // Claude tinted background
    cliCodex: string;        // Codex identity color
    cliCodexBg: string;      // Codex tinted background
    cliCodexHover: string;   // Codex hover color (mirrors accentHover for the codex provider scope)

    // Semantic
    success: string;
    warning: string;
    error: string;
    info: string;
    permission: string;      // Permission prompt color

    // Terminal-specific
    termBg: string;
    termFg: string;
    termCursor: string;
    termSelection: string;

    // Scrollbar
    scrollThumb: string;
    scrollTrack: string;
  };
}

export const CLAUDE_THEME: Theme = {
  name: "Claude",
  colors: {
    // Backgrounds (Cowork dark mode warm grays)
    bgPrimary: "#1f1e1c",       // Cowork bg-200: hsl(30, 3.3%, 11.8%)
    bgSurface: "#262523",       // Cowork bg-100: hsl(60, 2.7%, 14.5%)
    bgSurfaceHover: "#302f2c",  // Cowork bg-000: hsl(60, 2.1%, 18.4%)
    bgSelection: "#302f2c",     // Same as hover

    // Borders (Cowork border-300 at ~15% opacity on dark bg)
    border: "#3d3a36",
    borderSubtle: "#33302c",

    // Text (Cowork dark mode)
    textPrimary: "#f9f7f3",     // Cowork text-100: hsl(48, 33.3%, 97.1%)
    textSecondary: "#bfbdb7",   // Cowork text-200: hsl(50, 9%, 73.7%)
    textMuted: "#9a9893",       // Cowork text-400: hsl(48, 4.8%, 59.2%)
    textOnAccent: "#ffffff",

    // Accent (Cowork brand clay — already matches our Crail)
    accent: "#d4744a",          // Cowork brand-100: hsl(15, 63.1%, 59.6%)
    accentHover: "#e08b67",     // Lighter clay
    accentBg: "#3d2a20",        // Very dark clay tint
    accentSecondary: "#6ea8e0", // Cowork blue accent: hsl(210, 65.5%, 67.1%)
    cliClaude: "#d4744a",
    cliClaudeBg: "#3d2a20",
    cliCodex: "#39c5cf",
    cliCodexBg: "#173a3d",
    cliCodexHover: "#56d4dd",

    // Semantic (Cowork dark mode)
    success: "#5cb85c",         // Cowork success: hsl(97, 59.1%, 46.1%)
    warning: "#b8860b",         // Cowork warning: hsl(39, 93.4%, 35.9%)
    error: "#d84b4b",           // Cowork danger: hsl(0, 67%, 59.6%)
    info: "#6ea8e0",            // Cowork blue accent
    permission: "#e08b67",      // Warm orange (clay-adjacent)

    // Tertiary accent (purple/magenta for agent & write tool banners)
    accentTertiary: "#bc8cff",

    // Terminal
    termBg: "#1f1e1c",
    termFg: "#f9f7f3",
    termCursor: "#d4744a",
    termSelection: "#3d2a20",

    // Scrollbar
    scrollThumb: "#3d3a36",
    scrollTrack: "#1f1e1c",
  },
};

/** Apply a theme by setting CSS custom properties on :root */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const c = theme.colors;

  root.style.setProperty("--bg-primary", c.bgPrimary);
  root.style.setProperty("--bg-surface", c.bgSurface);
  root.style.setProperty("--bg-surface-hover", c.bgSurfaceHover);
  root.style.setProperty("--bg-hover", c.bgSurfaceHover); // Alias for interactive hover states
  root.style.setProperty("--bg-selection", c.bgSelection);

  root.style.setProperty("--border", c.border);
  root.style.setProperty("--border-subtle", c.borderSubtle);

  root.style.setProperty("--text-primary", c.textPrimary);
  root.style.setProperty("--text-secondary", c.textSecondary);
  root.style.setProperty("--text-muted", c.textMuted);
  root.style.setProperty("--text-on-accent", c.textOnAccent);

  root.style.setProperty("--accent", c.accent);
  root.style.setProperty("--accent-hover", c.accentHover);
  root.style.setProperty("--accent-bg", c.accentBg);
  root.style.setProperty("--accent-secondary", c.accentSecondary);
  root.style.setProperty("--accent-tertiary", c.accentTertiary);
  // [CV-01] CLI identity colors (--cli-claude / --cli-codex) live in the theme so every brand-tinted surface (status chips, active tab indicator, launcher selector) reads from one source.
  root.style.setProperty("--cli-claude", c.cliClaude);
  root.style.setProperty("--cli-claude-bg", c.cliClaudeBg);
  root.style.setProperty("--cli-codex", c.cliCodex);
  root.style.setProperty("--cli-codex-bg", c.cliCodexBg);
  // Provider palette: containers set --accent/--accent-bg/--accent-hover to these active-provider values.
  root.style.setProperty("--provider-claude-accent", c.cliClaude);
  root.style.setProperty("--provider-claude-accent-bg", c.cliClaudeBg);
  root.style.setProperty("--provider-claude-accent-hover", c.accentHover);
  root.style.setProperty("--provider-codex-accent", c.cliCodex);
  root.style.setProperty("--provider-codex-accent-bg", c.cliCodexBg);
  root.style.setProperty("--provider-codex-accent-hover", c.cliCodexHover);
  root.style.setProperty("--provider-accent", c.cliClaude);
  root.style.setProperty("--provider-accent-bg", c.cliClaudeBg);
  root.style.setProperty("--provider-accent-hover", c.accentHover);

  root.style.setProperty("--success", c.success);
  root.style.setProperty("--warning", c.warning);
  root.style.setProperty("--error", c.error);
  root.style.setProperty("--info", c.info);
  root.style.setProperty("--permission", c.permission);

  root.style.setProperty("--term-bg", c.termBg);
  root.style.setProperty("--term-fg", c.termFg);
  root.style.setProperty("--term-cursor", c.termCursor);
  root.style.setProperty("--term-selection", c.termSelection);

  root.style.setProperty("--scroll-thumb", c.scrollThumb);
  root.style.setProperty("--scroll-track", c.scrollTrack);

  // [TH-03] Font system: --font-ui (Inter variable + system fallback) and --font-mono defined in index.html :root block as initial fallback (Cascadia Code + Fira Code + JetBrains Mono). applyTheme() overrides --font-mono at runtime. Inter woff2 bundled in src/assets/fonts/ with @font-face.
  // Font — match main terminal (TERMINAL_FONT_FAMILY in useTerminal.ts)
  root.style.setProperty("--font-mono", "'Pragmasevka', 'Roboto Mono', 'ClaudeEmoji', monospace");

  // [CB-12] Rarity CSS variables (WoW item quality — fixed cross-theme/provider)
  root.style.setProperty("--rarity-trash", "#9d9d9d");
  root.style.setProperty("--rarity-poor", "#9d9d9d");
  root.style.setProperty("--rarity-common", "#ffffff");
  root.style.setProperty("--rarity-uncommon", "#1eff00");
  root.style.setProperty("--rarity-rare", "#0070dd");
  root.style.setProperty("--rarity-epic", "#a335ee");
  root.style.setProperty("--rarity-legendary", "#ff8000");

  // Permission-mode pill colors. Picked to mirror Claude Code's TUI hues so
  // the launcher pill matches what the user will see once the session starts.
  root.style.setProperty("--mode-plan",     "#39c5cf"); // dark cyan
  root.style.setProperty("--mode-auto",     "#daa520"); // amber / orangey-yellow
  root.style.setProperty("--mode-accept",   "#bc8cff"); // purple (matches --accent-tertiary)
  root.style.setProperty("--mode-bypass",   "#d84b4b"); // red (matches --error)
  root.style.setProperty("--mode-dont-ask", "#6ea8e0"); // soft blue (matches --accent-secondary)

  // Legacy provider aliases kept for older component CSS.
  root.style.setProperty("--accent-claude", c.cliClaude);
  root.style.setProperty("--accent-codex", c.cliCodex);
}

/** Get terminal theme object from CSS custom properties */
export function getTerminalTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const get = (v: string) => s.getPropertyValue(v).trim();
  const getOr = (v: string, fallback: string) => get(v) || fallback;

  return {
    background: get("--term-bg"),
    foreground: get("--term-fg"),
    cursor: get("--term-cursor"),
    selectionBackground: get("--term-selection"),
    black: get("--bg-primary"),
    red: get("--error"),
    green: get("--success"),
    yellow: get("--warning"),
    blue: get("--accent-secondary"),
    magenta: get("--accent-tertiary"),
    cyan: getOr("--cli-codex", "#39c5cf"),
    white: get("--text-secondary"),
    brightBlack: get("--text-muted"),
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: get("--accent-tertiary"),
    brightCyan: "#56d4dd",
    brightWhite: get("--text-primary"),
  };
}
