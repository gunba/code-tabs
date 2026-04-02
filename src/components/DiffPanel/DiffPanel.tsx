import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../../store/sessions";
import { useGitStatus } from "../../hooks/useGitStatus";
import { parseUnifiedDiff, splitFilePath, statusLabel } from "../../lib/diffParser";
import { DiffModal } from "./DiffModal";
import type { DiffModalFile } from "./DiffModal";
import { IconClose, IconGitBranch } from "../Icons/Icons";
import type { GitFileEntry, FileDiff } from "../../types/git";
import "./DiffPanel.css";

interface DiffPanelProps {
  onClose: () => void;
}

type SectionKey = "staged" | "unstaged" | "untracked";

const SECTION_PREFIX: Record<SectionKey, string> = { staged: "s", unstaged: "u", untracked: "t" };

function fileKey(section: SectionKey, path: string): string {
  return `${SECTION_PREFIX[section]}:${path}`;
}

function FileItem({
  file,
  section,
  onSelect,
  animClass,
}: {
  file: GitFileEntry;
  section: SectionKey;
  onSelect: (file: GitFileEntry, section: SectionKey) => void;
  animClass: string | undefined;
}) {
  const { dir, name } = splitFilePath(file.path);
  const statusCls = `diff-file-status status-${file.status === "?" ? "Q" : file.status}`;

  return (
    <div className={animClass ?? ""}>
      <div
        className="diff-file-item"
        onClick={() => onSelect(file, section)}
        title={`${statusLabel(file.status)}: ${file.path}`}
      >
        <span className={statusCls}>{file.status}</span>
        <span className="diff-file-path">
          {dir && <span className="diff-file-dir">{dir}</span>}
          <span className="diff-file-name">{name}</span>
          {file.oldPath && (
            <span className="diff-file-old-path">{"\u2190 "}{file.oldPath}</span>
          )}
        </span>
        <span className="diff-file-changes">
          {file.insertions > 0 && <span className="diff-file-ins">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="diff-file-del">-{file.deletions}</span>}
        </span>
      </div>
    </div>
  );
}

function EmptyPanel({ onClose, message, error }: { onClose: () => void; message: string; error?: boolean }) {
  return (
    <div className="diff-panel">
      <div className="diff-panel-header">
        <span className="diff-panel-title">Changes</span>
        <span className="diff-panel-spacer" />
        <button className="diff-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>
      <div className="diff-panel-empty" style={error ? { color: "var(--error)" } : undefined}>{message}</div>
    </div>
  );
}

// [GD-01] Side panel (400px) toggled via Ctrl+Shift+G with staged/unstaged/untracked sections
// [GD-05] Diff cache with stale-response protection via request counter
export function DiffPanel({ onClose }: DiffPanelProps) {
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const workingDir = activeSession?.config.workingDir ?? null;

  const { isGitRepo, status, error, changedPaths } = useGitStatus(workingDir, true);

  const [collapsedSections, setCollapsedSections] = useState<Set<SectionKey>>(new Set());
  const [selectedFile, setSelectedFile] = useState<DiffModalFile | null>(null);
  const [fileDiffs, setFileDiffs] = useState<Map<string, FileDiff>>(new Map());
  const [diffError, setDiffError] = useState<string | null>(null);

  // Track previous totals for stat tick animation
  const prevTotalsRef = useRef<{ ins: number; del: number }>({ ins: 0, del: 0 });
  const insChanged = status !== null && status.totalInsertions !== prevTotalsRef.current.ins;
  const delChanged = status !== null && status.totalDeletions !== prevTotalsRef.current.del;
  useEffect(() => {
    if (status) {
      prevTotalsRef.current = { ins: status.totalInsertions, del: status.totalDeletions };
    }
  }, [status]);

  const fileDiffsRef = useRef(fileDiffs);
  fileDiffsRef.current = fileDiffs;
  const requestIdRef = useRef(0);

  // Clear cache on session switch
  useEffect(() => {
    setSelectedFile(null);
    setFileDiffs(new Map());
  }, [workingDir]);

  // Flat file list for modal navigation
  const allFiles = useMemo((): DiffModalFile[] => {
    if (!status) return [];
    const files: DiffModalFile[] = [];
    for (const f of status.staged) files.push({ key: fileKey("staged", f.path), file: f, section: "staged" });
    for (const f of status.unstaged) files.push({ key: fileKey("unstaged", f.path), file: f, section: "unstaged" });
    for (const f of status.untracked) files.push({ key: fileKey("untracked", f.path), file: f, section: "untracked" });
    return files;
  }, [status]);

  const toggleSection = useCallback((key: SectionKey) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadDiff = useCallback(async (key: string, path: string, section: SectionKey) => {
    if (fileDiffsRef.current.has(key)) return;
    const reqId = ++requestIdRef.current;
    setDiffError(null);
    try {
      const raw = await invoke<string>("git_diff_file", {
        workingDir,
        filePath: path,
        staged: section === "staged",
        untracked: section === "untracked",
      });
      // Always cache — even if user navigated away, the result is valid
      setFileDiffs((prev) => new Map(prev).set(key, parseUnifiedDiff(raw)));
    } catch (err) {
      if (reqId !== requestIdRef.current) return; // only show error for current request
      setDiffError(String(err));
    }
  }, [workingDir]);

  // Trigger diff load when selected file changes or cache is invalidated
  useEffect(() => {
    if (!selectedFile) return;
    if (fileDiffsRef.current.has(selectedFile.key)) return;
    loadDiff(selectedFile.key, selectedFile.file.path, selectedFile.section);
  }, [selectedFile, fileDiffs, loadDiff]);

  // Invalidate cached diffs when files change
  useEffect(() => {
    if (changedPaths.size === 0) return;
    setFileDiffs((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const key of changedPaths) {
        if (next.delete(key)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [changedPaths]);

  const handleFileClick = useCallback((file: GitFileEntry, section: SectionKey) => {
    setDiffError(null);
    setSelectedFile({ key: fileKey(section, file.path), file, section });
  }, []);

  const handleNavigate = useCallback((modalFile: DiffModalFile) => {
    setDiffError(null);
    setSelectedFile(modalFile);
  }, []);

  const handleCloseModal = useCallback(() => setSelectedFile(null), []);

  const totalFiles = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0;

  const renderSection = (
    section: SectionKey,
    label: string,
    files: GitFileEntry[],
  ) => {
    if (files.length === 0) return null;
    const isCollapsed = collapsedSections.has(section);
    return (
      <div key={section}>
        <div className="diff-section-header" onClick={() => toggleSection(section)}>
          <span className={`diff-section-chevron${isCollapsed ? " collapsed" : ""}`}>
            {"\u25be"}
          </span>
          {label}
          <span className="diff-section-count">{files.length}</span>
        </div>
        {!isCollapsed &&
          files.map((file) => {
            const fKey = fileKey(section, file.path);
            const animClass = changedPaths.has(fKey) ? "diff-file-enter" : undefined;
            return (
              <FileItem
                key={fKey}
                file={file}
                section={section}
                onSelect={handleFileClick}
                animClass={animClass}
              />
            );
          })}
      </div>
    );
  };

  if (!workingDir) return <EmptyPanel onClose={onClose} message="No active session" />;
  if (!isGitRepo) return <EmptyPanel onClose={onClose} message="Not a git repository" />;
  if (error && !status) return <EmptyPanel onClose={onClose} message={error} error />;

  return (
    <div className="diff-panel">
      <div className="diff-panel-header">
        <IconGitBranch size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span className="diff-panel-title">Changes</span>
        {status?.branch && (
          <span className="diff-panel-branch" title={status.branch}>{status.branch}</span>
        )}
        <span className="diff-panel-spacer" />
        <div className="diff-panel-stats">
          {status && status.totalInsertions > 0 && (
            <span className={`diff-stat-add${insChanged ? " diff-stat-tick" : ""}`}
              key={`ins-${status.totalInsertions}`}>
              +{status.totalInsertions}
            </span>
          )}
          {status && status.totalDeletions > 0 && (
            <span className={`diff-stat-del${delChanged ? " diff-stat-tick" : ""}`}
              key={`del-${status.totalDeletions}`}>
              -{status.totalDeletions}
            </span>
          )}
        </div>
        {totalFiles > 0 && <span className="diff-panel-count">{totalFiles}</span>}
        <button className="diff-panel-close" onClick={onClose} title="Close (Esc)">
          <IconClose size={14} />
        </button>
      </div>
      <div className="diff-panel-body">
        {totalFiles === 0 ? (
          <div className="diff-panel-empty">No changes detected</div>
        ) : (
          <>
            {renderSection("staged", "Staged", status?.staged ?? [])}
            {renderSection("unstaged", "Changes", status?.unstaged ?? [])}
            {renderSection("untracked", "Untracked", status?.untracked ?? [])}
          </>
        )}
      </div>
      {selectedFile && (
        <DiffModal
          file={selectedFile}
          diff={fileDiffs.get(selectedFile.key) ?? null}
          loading={!fileDiffs.has(selectedFile.key) && diffError === null}
          error={diffError}
          allFiles={allFiles}
          onNavigate={handleNavigate}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
