/**
 * Theme system for Claude Tabs.
 *
 * All colors are exposed as CSS custom properties on :root.
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
    accent: string;          // Primary brand color (Cowork clay)
    accentHover: string;
    accentBg: string;        // Accent tinted background (active tab, selected button)
    accentSecondary: string; // Secondary accent (soft blue)
    accentTertiary: string;  // Tertiary accent (purple/magenta for tool banners)

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

  // [CB-12] Rarity CSS variables (WoW item quality — fixed cross-theme)
  root.style.setProperty("--rarity-uncommon", "#1eff00");
  root.style.setProperty("--rarity-rare", "#0070dd");
  root.style.setProperty("--rarity-epic", "#a335ee");
  root.style.setProperty("--rarity-legendary", "#ff8000");
}

/** Get terminal theme object from CSS custom properties */
export function getTerminalTheme(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const get = (v: string) => s.getPropertyValue(v).trim();

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
    cyan: "#39c5cf",
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
