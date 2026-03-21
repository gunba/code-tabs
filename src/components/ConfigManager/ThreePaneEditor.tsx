import type { StatusMessage } from "../../lib/settingsSchema";
import { formatScopePath } from "../../lib/paths";

export interface PaneComponentProps {
  scope: "user" | "project" | "project-local";
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
}

export type TabId = "settings" | "claudemd" | "hooks" | "plugins" | "agents";

interface ThreePaneEditorProps {
  component: React.ComponentType<PaneComponentProps>;
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
  tabId: TabId;
}

export function scopePath(scope: PaneComponentProps["scope"], dir: string, tabId: TabId): string {
  const d = dir || ".";
  switch (tabId) {
    case "settings":
    case "hooks":
    case "plugins":
      if (scope === "user") return "~/.claude/settings.json";
      if (scope === "project") return `${d}/.claude/settings.json`;
      return `${d}/.claude/settings.local.json`;
    case "claudemd":
      if (scope === "user") return "~/.claude/CLAUDE.md";
      if (scope === "project") return `${d}/CLAUDE.md`;
      return `${d}/.claude/CLAUDE.md`;
    case "agents":
      if (scope === "user") return "~/.claude/agents/";
      if (scope === "project") return `${d}/.claude/agents/`;
      return `${d}/.claude/local/agents/`;
  }
}

const SCOPES: { value: PaneComponentProps["scope"]; label: string; colorVar: string }[] = [
  { value: "user", label: "USER", colorVar: "var(--accent)" },
  { value: "project", label: "PROJECT", colorVar: "var(--accent-secondary)" },
  { value: "project-local", label: "LOCAL", colorVar: "var(--accent-tertiary)" },
];

export function ThreePaneEditor({ component: PaneComponent, projectDir, onStatus, tabId }: ThreePaneEditorProps) {
  return (
    <div className="three-pane-grid">
      {SCOPES.map(({ value, label, colorVar }) => (
        <div key={value} className="three-pane-column" style={{ "--scope-color": colorVar } as React.CSSProperties}>
          <div className="three-pane-header">
            <span className="three-pane-label">{label}</span>
            <span className="three-pane-path">{formatScopePath(scopePath(value, projectDir, tabId))}</span>
          </div>
          <div className="three-pane-body">
            <PaneComponent scope={value} projectDir={projectDir} onStatus={onStatus} />
          </div>
        </div>
      ))}
    </div>
  );
}
