// [PC-02] PortContentPane: 'Port content' tab in ConfigManager; three port pairs (Skills/Memory/MCP); calls port_skill/port_memory/port_mcp
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./PortContentPane.css";
import type { StatusMessage } from "../../lib/settingsSchema";

type PortDirection = "claude_to_codex" | "codex_to_claude";
type ConflictPolicy = "skip" | "overwrite" | "rename";

interface PortReport {
  kind: string;
  direction: PortDirection;
  written: string[];
  skipped: string[];
  backupPath: string | null;
  messages: string[];
}

interface PortContentPaneProps {
  visible: boolean;
  projectDir: string;
  onStatus: (msg: StatusMessage | null) => void;
}

function ReportView({ report }: { report: PortReport | null }) {
  if (!report) return null;
  return (
    <div className="port-report">
      <div className="port-report-row">
        <span className="port-report-label">Wrote</span>
        <span className="port-report-count">{report.written.length}</span>
      </div>
      <div className="port-report-row">
        <span className="port-report-label">Skipped</span>
        <span className="port-report-count">{report.skipped.length}</span>
      </div>
      {report.backupPath && (
        <div className="port-report-row">
          <span className="port-report-label">Backup</span>
          <code className="port-report-path">{report.backupPath}</code>
        </div>
      )}
      {report.messages.length > 0 && (
        <ul className="port-report-messages">
          {report.messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {report.written.length > 0 && (
        <details className="port-report-details">
          <summary>{report.written.length} file{report.written.length === 1 ? "" : "s"} written</summary>
          <ul>
            {report.written.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function PortContentPane({ visible, projectDir, onStatus }: PortContentPaneProps) {
  const [direction, setDirection] = useState<PortDirection>("claude_to_codex");
  const [conflict, setConflict] = useState<ConflictPolicy>("skip");

  const [skillName, setSkillName] = useState("");
  const [skillReport, setSkillReport] = useState<PortReport | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);

  const [memorySymlink, setMemorySymlink] = useState(false);
  const [memoryReport, setMemoryReport] = useState<PortReport | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);

  const [mcpUserScope, setMcpUserScope] = useState(false);
  const [mcpReport, setMcpReport] = useState<PortReport | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  const runSkill = useCallback(async (dryRun: boolean) => {
    if (!skillName.trim()) {
      onStatus({ type: "error", text: "Enter a skill name" });
      return;
    }
    setSkillBusy(true);
    try {
      const report = await invoke<PortReport>("port_skill", {
        req: {
          direction,
          projectDir,
          skillName: skillName.trim(),
          conflict,
          dryRun,
        },
      });
      setSkillReport(report);
      onStatus({
        type: "success",
        text: dryRun ? "Skill dry-run complete" : `Skill ported (${report.written.length} files)`,
      });
    } catch (err) {
      onStatus({ type: "error", text: `Skill port failed: ${err}` });
    } finally {
      setSkillBusy(false);
    }
  }, [direction, projectDir, skillName, conflict, onStatus]);

  const runMemory = useCallback(async (dryRun: boolean) => {
    setMemoryBusy(true);
    try {
      const report = await invoke<PortReport>("port_memory", {
        req: {
          direction,
          projectDir,
          conflict,
          symlink: memorySymlink,
          dryRun,
        },
      });
      setMemoryReport(report);
      onStatus({
        type: "success",
        text: dryRun ? "Memory dry-run complete" : "Memory ported",
      });
    } catch (err) {
      onStatus({ type: "error", text: `Memory port failed: ${err}` });
    } finally {
      setMemoryBusy(false);
    }
  }, [direction, projectDir, conflict, memorySymlink, onStatus]);

  const runMcp = useCallback(async (dryRun: boolean) => {
    setMcpBusy(true);
    try {
      const report = await invoke<PortReport>("port_mcp", {
        req: {
          direction,
          conflict,
          dryRun,
          userScope: mcpUserScope,
          projectDir: mcpUserScope ? null : projectDir,
        },
      });
      setMcpReport(report);
      onStatus({
        type: "success",
        text: dryRun ? "MCP dry-run complete" : "MCP ported",
      });
    } catch (err) {
      onStatus({ type: "error", text: `MCP port failed: ${err}` });
    } finally {
      setMcpBusy(false);
    }
  }, [direction, projectDir, conflict, mcpUserScope, onStatus]);

  if (!visible) return null;

  return (
    <div className="port-pane">
      <div className="port-intro">
        <p>
          Move skills, memory, and MCP server config between <code>.claude/</code> and{" "}
          <code>.codex/</code>. Every Apply writes a tarball backup to{" "}
          <code>~/.claude_tabs/backups/</code> first.
        </p>
        <p className="port-intro-muted">
          Hooks and slash-command-to-skill conversion are not yet implemented.
        </p>
      </div>

      <div className="port-controls">
        <label className="port-control">
          <span>Direction</span>
          <select value={direction} onChange={(e) => setDirection(e.target.value as PortDirection)}>
            <option value="claude_to_codex">Claude → Codex</option>
            <option value="codex_to_claude">Codex → Claude</option>
          </select>
        </label>
        <label className="port-control">
          <span>On conflict</span>
          <select value={conflict} onChange={(e) => setConflict(e.target.value as ConflictPolicy)}>
            <option value="skip">Skip</option>
            <option value="overwrite">Overwrite</option>
            <option value="rename">Rename</option>
          </select>
        </label>
      </div>

      <section className="port-section">
        <h3>Skill</h3>
        <p className="port-section-desc">
          Copy a skill directory verbatim. <code>SKILL.md</code> format is identical
          between the two ecosystems; only the discovery roots differ.
        </p>
        <div className="port-row">
          <input
            className="port-input"
            placeholder="skill-name (matches a directory under .claude/skills/ or .codex/skills/)"
            value={skillName}
            onChange={(e) => setSkillName(e.target.value)}
            disabled={skillBusy}
          />
          <button onClick={() => runSkill(true)} disabled={skillBusy}>Dry-run</button>
          <button onClick={() => runSkill(false)} disabled={skillBusy} className="port-apply-btn">Apply</button>
        </div>
        <ReportView report={skillReport} />
      </section>

      <section className="port-section">
        <h3>Project memory</h3>
        <p className="port-section-desc">
          Copy <code>CLAUDE.md</code> ↔ <code>AGENTS.md</code>. Both are
          plain markdown; same role, different filename. Symlink keeps
          edits in sync but creates an OS-level link.
        </p>
        <div className="port-row">
          <label className="port-checkbox">
            <input
              type="checkbox"
              checked={memorySymlink}
              onChange={(e) => setMemorySymlink(e.target.checked)}
              disabled={memoryBusy}
            />
            <span>Symlink (instead of copy)</span>
          </label>
          <button onClick={() => runMemory(true)} disabled={memoryBusy}>Dry-run</button>
          <button onClick={() => runMemory(false)} disabled={memoryBusy} className="port-apply-btn">Apply</button>
        </div>
        <ReportView report={memoryReport} />
      </section>

      <section className="port-section">
        <h3>MCP servers</h3>
        <p className="port-section-desc">
          Translate MCP server config between Claude's{" "}
          <code>settings.json[mcpServers]</code> and Codex's{" "}
          <code>config.toml [mcp_servers.*]</code>. The <code>command</code>/
          <code>args</code>/<code>env</code> shape aligns 1:1.
        </p>
        <div className="port-row">
          <label className="port-checkbox">
            <input
              type="checkbox"
              checked={mcpUserScope}
              onChange={(e) => setMcpUserScope(e.target.checked)}
              disabled={mcpBusy}
            />
            <span>User scope (~/.claude/settings.json ↔ ~/.codex/config.toml)</span>
          </label>
          <button onClick={() => runMcp(true)} disabled={mcpBusy}>Dry-run</button>
          <button onClick={() => runMcp(false)} disabled={mcpBusy} className="port-apply-btn">Apply</button>
        </div>
        <ReportView report={mcpReport} />
      </section>
    </div>
  );
}
