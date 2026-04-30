---
paths:
  - "src/components/ResumePicker/ResumePicker.tsx"
---

# src/components/ResumePicker/ResumePicker.tsx

Tag line: `L<n>`; code usually starts at `L<n+1>`.

## Dead Session Handling

- [DS-05 L200] Ctrl+Shift+R opens ResumePicker from the global keyboard shortcut. ResumePicker builds deadSessionMap for active dead tabs keyed by config.sessionId || app session id and also by getResumeId(session), preserving the dead tab's nodeSummary and config. When resumeById is called, it uses the dead tab config when the selected past-session id is in deadSessionMap, otherwise falls back to the cached sessionConfigs/default config; every resume sets workingDir to the past-session directory, resumeSession to the selected past-session id, continueSession false, strips worktree flags, adds the directory to recents, creates a new session, and closes the picker after createSession succeeds.

## Session Launcher

- [SL-03 L108] Ctrl+Shift+R opens resume picker (browse past Claude sessions); 660px modal, 520px list max-height; cards show blue top-bar + tint when Ctrl is held; resume banner uses orange accent (not blue)
- [SL-05 L251] Chain merging: sessions linked by parentId (resolved via sourceToolAssistantUUID -> message UUID map in Rust) merged into a single card; latest session used for resume, names resolved from any member, suppressed plan-mode artifact messages skipped, sizes summed; stacked box-shadow when chainLength > 1; clickable chain count badge expands to show individual members for resuming older sessions
- [SL-06 L292] Custom names: tab renames persist in `sessionNames` map (localStorage); shown as bold primary name with directory as secondary text in resume picker
- [SL-04 L302] Resume picker enriched data: each session card shows firstMessage, lastMessage (from tail scan), settings badges (model, skip-perms, permission mode, effort, agent), and file size
- [SL-24 L430] Fork into New Tab is available from resumable live/dead tabs and resume-history rows, and creates a separate session immediately instead of replacing or resuming the current tab.
  - App.tsx tab context-menu handler builds a fork config with buildForkSessionConfig(), loading past sessions first when a live tab lacks a captured session id. ResumePicker right-click Fork into New Tab uses buildForkConfigFromPastSession(). Both add the fork workingDir to recents, createSession with a Fork-suffixed name, and leave ordinary resume/configure paths with forkSession false.

## Session Resume

- [SR-07 L165] Content search: typing 3+ chars in the filter bar triggers a debounced (400ms) Rust backend scan of all conversation JSONL files, matching user and assistant messages. Results appear below metadata matches with a blue left border and snippet. Stale results discarded via counter-based ref.
