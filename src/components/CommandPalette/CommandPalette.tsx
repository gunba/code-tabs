import { useState, useCallback, useEffect, useRef } from "react";
import { useSessionStore } from "../../store/sessions";
import { useSettingsStore } from "../../store/settings";
import { getSessionTranscript } from "../../lib/terminalRegistry";
import { useRuntimeStore } from "../../store/runtime";
import "./CommandPalette.css";

interface Command {
  id: string;
  label: string;
  description?: string;
  action: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const setActiveTab = useSessionStore((s) => s.setActiveTab);
  const setShowLauncher = useSettingsStore((s) => s.setShowLauncher);
  const debugBuild = useRuntimeStore((s) => s.observabilityInfo.debugBuild);
  const devtoolsAvailable = useRuntimeStore((s) => s.observabilityInfo.devtoolsAvailable);
  const openMainDevtools = useRuntimeStore((s) => s.openMainDevtools);

  // Build command list
  const commands: Command[] = [
    {
      id: "new-session",
      label: "New Session",
      description: "Open a new Claude Code session",
      action: () => {
        setShowLauncher(true);
        onClose();
      },
    },
    ...(activeTabId ? [{
      id: "copy-transcript",
      label: "Copy Transcript",
      description: "Copy the active session's terminal output to clipboard",
      action: () => {
        const text = getSessionTranscript(activeTabId);
        if (text) {
          navigator.clipboard.writeText(text);
        }
        onClose();
      },
    }] : []),
    ...(activeTabId ? [{
      id: "copy-session-id",
      label: "Copy Session ID",
      description: "Copy the active session's ID to clipboard",
      action: () => {
        navigator.clipboard.writeText(activeTabId);
        onClose();
      },
    }] : []),
    ...(debugBuild ? [{
      id: "toggle-debug-log",
      label: "Toggle Debug Log",
      description: "Show/hide the debug log panel (Ctrl+Shift+D)",
      action: () => {
        onClose();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true, bubbles: true }));
      },
    }] : []),
    ...(devtoolsAvailable ? [{
      id: "open-devtools",
      label: "Open DevTools",
      description: "Open app devtools (Ctrl+Shift+I)",
      action: () => {
        openMainDevtools().catch(() => {});
        onClose();
      },
    }] : []),
    ...sessions.map((s) => ({
      id: `tab-${s.id}`,
      label: `Switch to: ${s.name}`,
      description: s.config.workingDir,
      action: () => {
        setActiveTab(s.id);
        onClose();
      },
    })),
  ];

  const filtered = query
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description?.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        filtered[selectedIndex]?.action();
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [filtered, selectedIndex, onClose]
  );

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search sessions and commands..."
        />
        <div className="palette-results">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`palette-item ${i === selectedIndex ? "selected" : ""}`}
              onClick={cmd.action}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="palette-label">{cmd.label}</span>
              {cmd.description && (
                <span className="palette-desc">{cmd.description}</span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="palette-empty">No results</div>
          )}
        </div>
      </div>
    </div>
  );
}
