import type { StatusMessage } from "../../lib/settingsSchema";

export interface PaneComponentProps {
  scope: "user" | "project" | "project-local";
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
}

interface ThreePaneEditorProps {
  component: React.ComponentType<PaneComponentProps>;
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
}

const SCOPES: { value: PaneComponentProps["scope"]; label: string; path: (dir: string) => string; colorVar: string }[] = [
  { value: "user", label: "USER", path: () => "~/.claude/", colorVar: "var(--accent)" },
  { value: "project", label: "PROJECT", path: (dir) => dir ? `${dir}/.claude/` : ".claude/", colorVar: "var(--accent-secondary)" },
  { value: "project-local", label: "LOCAL", path: (dir) => dir ? `${dir}/.claude/local/` : ".claude/local/", colorVar: "var(--accent-tertiary)" },
];

export function ThreePaneEditor({ component: PaneComponent, projectDir, onStatus }: ThreePaneEditorProps) {
  return (
    <div className="three-pane-grid">
      {SCOPES.map(({ value, label, path, colorVar }) => (
        <div key={value} className="three-pane-column" style={{ "--scope-color": colorVar } as React.CSSProperties}>
          <div className="three-pane-header">
            <span className="three-pane-label">{label}</span>
            <span className="three-pane-path">{path(projectDir)}</span>
          </div>
          <div className="three-pane-body">
            <PaneComponent scope={value} projectDir={projectDir} onStatus={onStatus} />
          </div>
        </div>
      ))}
    </div>
  );
}
