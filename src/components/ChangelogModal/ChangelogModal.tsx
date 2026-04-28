import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown, { type Components } from "react-markdown";
import type { CliKind } from "../../types/session";
import { ModalOverlay } from "../ModalOverlay/ModalOverlay";
import { IconClose } from "../Icons/Icons";
import { ProviderLogo } from "../ProviderLogo/ProviderLogo";
import type { ChangelogEntry, ChangelogRequest, CliChangelog } from "../../lib/changelog";
import "./ChangelogModal.css";

type ChangelogModalProps = {
  request: ChangelogRequest;
  currentVersions: Record<CliKind, string | null>;
  onClose: () => void;
};

type LoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; data: CliChangelog }
  | { status: "error"; error: string };

type ChangelogFetchTarget = {
  fromVersion: string | null;
  toVersion: string | null;
};

const CLI_ORDER: CliKind[] = ["claude", "codex"];
const changelogMarkdownComponents: Components = {
  h2: ({ node: _node, ...props }) => <h2 {...props} className="changelog-entry-heading" />,
  h3: ({ node: _node, ...props }) => <h3 {...props} className="changelog-entry-heading" />,
  h4: ({ node: _node, ...props }) => <h4 {...props} className="changelog-entry-heading" />,
  ul: ({ node: _node, ...props }) => <ul {...props} className="changelog-entry-list" />,
};

function cliLabel(cli: CliKind): string {
  return cli === "codex" ? "Codex" : "Claude";
}

function EntryView({ entry }: { entry: ChangelogEntry }) {
  return (
    <article className="changelog-entry">
      <div className="changelog-entry-top">
        <div className="changelog-entry-version">v{entry.version}</div>
        {entry.date && <div className="changelog-entry-date">{entry.date.slice(0, 10)}</div>}
      </div>
      <div className="changelog-entry-body">
        <ReactMarkdown components={changelogMarkdownComponents}>{entry.body}</ReactMarkdown>
      </div>
      {entry.url && (
        <button
          className="changelog-source-link"
          onClick={() => invoke("shell_open", { path: entry.url })}
        >
          Source
        </button>
      )}
    </article>
  );
}

export function ChangelogModal({ request, currentVersions, onClose }: ChangelogModalProps) {
  const [activeCli, setActiveCli] = useState<CliKind>(request.initialCli);
  const [states, setStates] = useState<Record<CliKind, LoadState>>({
    claude: { status: "idle" },
    codex: { status: "idle" },
  });

  const changelogTargets = useMemo<Record<CliKind, ChangelogFetchTarget>>(() => ({
    claude: {
      fromVersion: request.ranges.claude?.fromVersion ?? null,
      toVersion: request.ranges.claude?.toVersion ?? currentVersions.claude,
    },
    codex: {
      fromVersion: request.ranges.codex?.fromVersion ?? null,
      toVersion: request.ranges.codex?.toVersion ?? currentVersions.codex,
    },
  }), [
    currentVersions.claude,
    currentVersions.codex,
    request.ranges.claude?.fromVersion,
    request.ranges.claude?.toVersion,
    request.ranges.codex?.fromVersion,
    request.ranges.codex?.toVersion,
  ]);

  useEffect(() => {
    let cancelled = false;
    setStates({ claude: { status: "loading" }, codex: { status: "loading" } });
    for (const cli of CLI_ORDER) {
      const target = changelogTargets[cli];
      void invoke<CliChangelog>("fetch_cli_changelog", {
        cli,
        fromVersion: target.fromVersion,
        toVersion: target.toVersion,
      })
        .then((data) => {
          if (cancelled) return;
          setStates((prev) => ({ ...prev, [cli]: { status: "ready", data } }));
        })
        .catch((err) => {
          if (cancelled) return;
          setStates((prev) => ({ ...prev, [cli]: { status: "error", error: String(err) } }));
        });
    }
    return () => { cancelled = true; };
  }, [changelogTargets]);

  const activeState = states[activeCli];
  const readyData = activeState.status === "ready" ? activeState.data : null;
  const updatedCount = CLI_ORDER.filter((cli) => request.ranges[cli]?.fromVersion).length;

  return (
    <ModalOverlay onClose={onClose} className={`changelog-modal changelog-modal-${activeCli}`}>
      <div className="changelog-header">
        <div>
          <div className="changelog-kicker">
            {request.kind === "startup" && updatedCount > 0 ? "CLI updates detected" : "Changelog"}
          </div>
          <div className="changelog-title">Codex and Claude changes</div>
        </div>
        <button className="changelog-close" onClick={onClose} title="Close">
          <IconClose size={14} />
        </button>
      </div>

      <div className="changelog-tabs" role="tablist">
        {CLI_ORDER.map((cli) => {
          const version = currentVersions[cli];
          const range = request.ranges[cli];
          return (
            <button
              key={cli}
              className={`changelog-tab changelog-tab-${cli}${activeCli === cli ? " changelog-tab-active" : ""}`}
              onClick={() => setActiveCli(cli)}
              role="tab"
              aria-selected={activeCli === cli}
            >
              <span className="changelog-tab-label">
                <ProviderLogo cli={cli} size={14} />
                {cliLabel(cli)}
              </span>
              <span>{range?.fromVersion ? `${range.fromVersion} -> ${range.toVersion}` : (version ? `v${version}` : "not installed")}</span>
            </button>
          );
        })}
      </div>

      <div className="changelog-content">
        {activeState.status === "loading" || activeState.status === "idle" ? (
          <div className="changelog-loading">Loading {cliLabel(activeCli)} changelog...</div>
        ) : activeState.status === "error" ? (
          <div className="changelog-error">{activeState.error}</div>
        ) : readyData && readyData.entries.length === 0 ? (
          <div className="changelog-empty">No release notes found for this version.</div>
        ) : readyData ? (
          <>
            <div className="changelog-source-row">
              <span>{readyData.entries.length} release{readyData.entries.length === 1 ? "" : "s"}</span>
              <button onClick={() => invoke("shell_open", { path: readyData.sourceUrl })}>
                Open source
              </button>
            </div>
            {readyData.entries.map((entry) => (
              <EntryView key={`${activeCli}-${entry.version}`} entry={entry} />
            ))}
          </>
        ) : (
          <div className="changelog-empty">No release notes found for this version.</div>
        )}
      </div>
    </ModalOverlay>
  );
}
