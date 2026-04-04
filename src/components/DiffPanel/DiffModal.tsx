import { useMemo } from "react";
import { createPortal } from "react-dom";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { splitFilePath, toSideBySide } from "../../lib/diffParser";
import { IconClose } from "../Icons/Icons";
import type { FileDiff, GitFileEntry } from "../../types/git";

// ── highlight.js core + selective language registration ──────────────

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANG_MODULES: [string, Parameters<typeof hljs.registerLanguage>[1]][] = [
  ["bash", bash], ["c", c], ["cpp", cpp], ["csharp", csharp],
  ["css", css], ["dockerfile", dockerfile], ["go", go], ["ini", ini],
  ["java", java], ["javascript", javascript], ["json", json],
  ["kotlin", kotlin], ["markdown", markdown], ["powershell", powershell],
  ["python", python], ["ruby", ruby], ["rust", rust], ["scss", scss],
  ["sql", sql], ["swift", swift], ["typescript", typescript],
  ["xml", xml], ["yaml", yaml],
];
for (const [name, mod] of LANG_MODULES) hljs.registerLanguage(name, mod);

// ── Language detection ──────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  rs: "rust", py: "python", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp",
  cs: "csharp", rb: "ruby", swift: "swift", kt: "kotlin",
  html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss",
  json: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini",
  md: "markdown", mdx: "markdown",
  sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psm1: "powershell",
  dockerfile: "dockerfile",
};

function detectLanguage(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  const ext = lower.split(".").pop() ?? "";
  return EXT_LANG[ext] ?? null;
}

// ── Highlighting helpers ────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightLine(content: string, language: string | null): string {
  if (!language) return escapeHtml(content);
  try {
    return hljs.highlight(content, { language }).value;
  } catch {
    return escapeHtml(content);
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface DiffModalFile {
  key: string;
  file: GitFileEntry;
  section?: string;
}

interface DiffModalProps {
  file: DiffModalFile;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  allFiles: DiffModalFile[];
  onNavigate: (file: DiffModalFile) => void;
  onClose: () => void;
}

// [GD-02] Side-by-side diff modal via ModalOverlay + createPortal
// [GD-03] Syntax highlighting via highlight.js/lib/core with 23 registered languages
// [GD-04] File navigation: prev/next arrows, Alt+Left/Right, Escape closes modal only
export function DiffModal({ file, diff, loading, error, allFiles, onNavigate, onClose }: DiffModalProps) {
  const { dir, name } = splitFilePath(file.file.path);
  const fileIndex = Math.max(0, allFiles.findIndex(f => f.key === file.key));
  const language = useMemo(() => detectLanguage(name), [name]);

  const rows = useMemo(() => {
    if (!diff || diff.isBinary || diff.hunks.length === 0) return [];
    return toSideBySide(diff.hunks);
  }, [diff]);

  const highlightedRows = useMemo(() =>
    rows.map(row => ({
      ...row,
      leftHtml: row.left ? highlightLine(row.left.content, language) : null,
      rightHtml: row.right ? highlightLine(row.right.content, language) : null,
    })),
  [rows, language]);

  const handlePrev = () => {
    const idx = fileIndex <= 0 ? allFiles.length - 1 : fileIndex - 1;
    onNavigate(allFiles[idx]);
  };

  const handleNext = () => {
    const idx = fileIndex >= allFiles.length - 1 ? 0 : fileIndex + 1;
    onNavigate(allFiles[idx]);
  };

  const statusCls = `diff-file-status status-${file.file.status === "?" ? "Q" : file.file.status}`;

  const body = loading ? (
    <div className="diff-modal-loading">Loading diff\u2026</div>
  ) : error ? (
    <div className="diff-modal-error">{error}</div>
  ) : diff?.isBinary ? (
    <div className="diff-modal-message">Binary file differs</div>
  ) : diff && diff.hunks.length === 0 ? (
    <div className="diff-modal-message">No changes</div>
  ) : (
    <>
      {diff?.isNew && <div className="diff-modal-banner diff-modal-banner-new">new file</div>}
      {diff?.isDeleted && <div className="diff-modal-banner diff-modal-banner-deleted">deleted file</div>}
      <table className="diff-modal-table">
        <colgroup>
          <col className="diff-modal-col-ln" />
          <col />
          <col className="diff-modal-col-ln" />
          <col />
        </colgroup>
        <tbody>
          {highlightedRows.map((row, i) =>
            row.type === "separator" ? (
              <tr key={i} className="diff-modal-separator">
                <td colSpan={4}><div className="diff-modal-separator-line" /></td>
              </tr>
            ) : (
              <tr key={i}>
                <td className={`diff-modal-ln${row.left?.kind === "del" ? " diff-modal-ln-del" : ""}`}>
                  {row.left?.lineNo ?? ""}
                </td>
                {row.left ? (
                  <td className={`diff-modal-code diff-modal-${row.left.kind}`}
                      dangerouslySetInnerHTML={{ __html: row.leftHtml! }} />
                ) : (
                  <td className="diff-modal-code diff-modal-empty" />
                )}
                <td className={`diff-modal-ln${row.right?.kind === "add" ? " diff-modal-ln-add" : ""}`}>
                  {row.right?.lineNo ?? ""}
                </td>
                {row.right ? (
                  <td className={`diff-modal-code diff-modal-${row.right.kind}`}
                      dangerouslySetInnerHTML={{ __html: row.rightHtml! }} />
                ) : (
                  <td className="diff-modal-code diff-modal-empty" />
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
      {diff?.truncated && <div className="diff-modal-truncated">Diff truncated (&gt;500KB)</div>}
    </>
  );

  return createPortal(
    <div onKeyDown={(e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); handlePrev(); }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); handleNext(); }
    }}>
      <ModalOverlay onClose={onClose} className="diff-modal">
        <div className="diff-modal-header">
          <div className="diff-modal-header-left">
            <span className={statusCls}>{file.file.status}</span>
            <span className="diff-modal-path">
              {dir && <span className="diff-file-dir">{dir}</span>}
              <span className="diff-file-name">{name}</span>
            </span>
          </div>
          <div className="diff-modal-header-right">
            <span className="diff-modal-stats">
              {file.file.insertions > 0 && <span className="diff-stat-add">+{file.file.insertions}</span>}
              {file.file.deletions > 0 && <span className="diff-stat-del">-{file.file.deletions}</span>}
            </span>
            {allFiles.length > 1 && (
              <>
                <button className="diff-modal-nav" onClick={handlePrev}
                  title="Previous file (Alt+\u2190)">{"\u2190"}</button>
                <button className="diff-modal-nav" onClick={handleNext}
                  title="Next file (Alt+\u2192)">{"\u2192"}</button>
              </>
            )}
            <button className="diff-modal-close" onClick={onClose} title="Close (Esc)">
              <IconClose size={14} />
            </button>
          </div>
        </div>
        <div className="diff-modal-body">{body}</div>
        {diff && !loading && !error && (
          <div className="diff-modal-footer">
            <span className="diff-modal-footer-info">
              file {fileIndex + 1} of {allFiles.length}
              {diff.hunks.length > 0 && ` \u00B7 ${diff.hunks.length} hunk${diff.hunks.length !== 1 ? "s" : ""}`}
            </span>
          </div>
        )}
      </ModalOverlay>
    </div>,
    document.body,
  );
}
