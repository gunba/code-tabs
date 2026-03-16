/**
 * Test harness — bidirectional bridge between external test scripts and the app.
 *
 * STATE: Writes app state to %LOCALAPPDATA%/claude-tabs/test-state.json every 2s.
 * COMMANDS: Polls %LOCALAPPDATA%/claude-tabs/test-commands.json for actions to execute.
 *
 * Commands are JSON: { "action": "createSession", "args": { ... } }
 * After execution, result is written to test-state.json under __last_command_result__.
 */

import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../store/sessions";
import { useSettingsStore } from "../store/settings";
import { writeToPty } from "./ptyRegistry";
import type { SessionConfig } from "../types/session";
import { DEFAULT_SESSION_CONFIG } from "../types/session";

export interface TestState {
  timestamp: number;
  initialized: boolean;
  claudePath: string | null;
  sessionCount: number;
  activeTabId: string | null;
  sessions: Array<{
    id: string;
    name: string;
    state: string;
    workingDir: string;
    sessionId: string | null;
    resumeSession: string | null;
    nodeSummary: string | null;
    assistantMessageCount: number;
    isMetaAgent: boolean;
  }>;
  subagents: Record<string, Array<{ id: string; state: string; description: string }>>;
  subagentMapSize: number;
  slashCommandCount: number;
  cliOptionCount: number;
  cliCommandCount: number;
  commandUsageKeys: string[];
  recentDirCount: number;
  cliVersion: string | null;
  lastCommandResult?: unknown;
  consoleLogs: string[];
  feedEntryCount: number;
  feedLastEntry: unknown;
  feedTracking: unknown;
}

function captureState(lastResult?: unknown): TestState {
  const ss = useSessionStore.getState();
  const settings = useSettingsStore.getState();

  return {
    timestamp: Date.now(),
    initialized: ss.initialized,
    claudePath: ss.claudePath,
    sessionCount: ss.sessions.length,
    activeTabId: ss.activeTabId,
    sessions: ss.sessions.map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      workingDir: s.config.workingDir,
      sessionId: s.config.sessionId,
      resumeSession: s.config.resumeSession,
      nodeSummary: s.metadata.nodeSummary ?? null,
      assistantMessageCount: s.metadata.assistantMessageCount,
      isMetaAgent: s.isMetaAgent ?? false,
    })),
    subagents: Object.fromEntries(
      Array.from(ss.subagents.entries()).map(([sid, subs]) => [
        sid,
        subs.map((s) => ({ id: s.id, state: s.state, description: s.description })),
      ])
    ),
    subagentMapSize: ss.subagents.size,
    slashCommandCount: settings.slashCommands.length,
    cliOptionCount: (settings.cliCapabilities.options || []).length,
    cliCommandCount: (settings.cliCapabilities.commands || []).length,
    commandUsageKeys: Object.keys(settings.commandUsage || {}),
    recentDirCount: settings.recentDirs.length,
    cliVersion: settings.cliVersion,
    lastCommandResult: lastResult,
    consoleLogs: (globalThis as Record<string, unknown>).__consoleLogs as string[] ?? [],
    feedEntryCount: (globalThis as Record<string, unknown>).__feedEntryCount as number ?? 0,
    feedLastEntry: (globalThis as Record<string, unknown>).__feedLastEntry ?? null,
    feedTracking: (globalThis as Record<string, unknown>).__feedTracking ?? null,
  };
}

// ── Command executor ──────────────────────────────────────────────

interface TestCommand {
  action: string;
  args?: Record<string, unknown>;
}

let lastResult: unknown = null;

async function executeCommand(cmd: TestCommand): Promise<unknown> {
  const store = useSessionStore.getState();

  switch (cmd.action) {
    case "createSession": {
      const config: SessionConfig = {
        ...DEFAULT_SESSION_CONFIG,
        workingDir: (cmd.args?.workingDir as string) || ".",
        model: (cmd.args?.model as string) || null,
      };
      const session = await store.createSession(
        (cmd.args?.name as string) || "Test Session",
        config
      );
      return { id: session.id, state: session.state };
    }

    case "closeSession": {
      await store.closeSession(cmd.args?.id as string);
      return { closed: true };
    }

    case "reviveSession": {
      // Replicate the handleTabActivate logic for dead sessions
      const id = cmd.args?.id as string;
      const session = store.sessions.find((s) => s.id === id);
      if (!session || session.state !== "dead") return { error: "Not a dead session" };
      const resumeId = session.config.resumeSession || session.config.sessionId || session.id;
      let hasConversation = false;
      try {
        hasConversation = await invoke<boolean>("session_has_conversation", {
          sessionId: resumeId,
          workingDir: session.config.workingDir,
        });
      } catch {}
      const config: SessionConfig = {
        ...session.config,
        continueSession: false,
        resumeSession: hasConversation ? resumeId : null,
      };
      const name = session.name;
      const idx = store.sessions.findIndex((s) => s.id === id);
      const savedMeta = { ...session.metadata };
      await store.closeSession(id);
      const newSession = await store.createSession(name, config, { insertAtIndex: idx });
      store.updateMetadata(newSession.id, {
        nodeSummary: savedMeta.nodeSummary,
        inputTokens: savedMeta.inputTokens,
        outputTokens: savedMeta.outputTokens,
        assistantMessageCount: savedMeta.assistantMessageCount,
      });
      store.setActiveTab(newSession.id);
      return { newId: newSession.id, resumed: hasConversation, resumeId };
    }

    case "setActiveTab": {
      store.setActiveTab(cmd.args?.id as string);
      return { active: cmd.args?.id };
    }

    case "getSubagents": {
      const subs = store.subagents;
      const result: Record<string, number> = {};
      for (const [sid, list] of subs.entries()) {
        result[sid] = list.length;
      }
      return result;
    }

    case "listSessions": {
      return store.sessions.map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
      }));
    }

    case "sendInput": {
      const id = cmd.args?.sessionId as string;
      const text = cmd.args?.text as string;
      if (!id || !text) return { error: "sessionId and text required" };
      let ok = writeToPty(id, text);
      let retries = 0;
      if (!ok) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          ok = writeToPty(id, text);
          retries++;
          if (ok) break;
        }
      }
      return { sent: ok, retries };
    }

    default:
      return { error: `Unknown action: ${cmd.action}` };
  }
}

async function pollCommands(): Promise<void> {
  try {
    const raw = await invoke<string>("read_test_commands");
    if (!raw) return;

    const cmd = JSON.parse(raw) as TestCommand;
    // Clear the command file immediately
    await invoke("write_test_commands", { json: "" });

    lastResult = await executeCommand(cmd);
  } catch {
    // No commands or parse error — ignore
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

// Set up log interception IMMEDIATELY (module load time, before any hooks run)
const __logs: string[] = [];
const __origLog = console.log;
const __origTrace = console.trace;
console.log = (...args: unknown[]) => {
  const msg = args.map(String).join(" ");
  if (msg.includes("[terminal]") || msg.includes("[TerminalPanel]") || msg.includes("[pty]") || msg.includes("[useClaudeState]") || msg.includes("[useMetaAgent]")) {
    __logs.push(msg);
    if (__logs.length > 200) __logs.shift();
  }
  (globalThis as Record<string, unknown>).__consoleLogs = __logs;
  __origLog.apply(console, args);
};
console.trace = (...args: unknown[]) => {
  const msg = args.map(String).join(" ");
  if (msg.includes("[terminal]")) {
    __logs.push(msg + " (trace)");
    if (__logs.length > 200) __logs.shift();
  }
  (globalThis as Record<string, unknown>).__consoleLogs = __logs;
  __origTrace.apply(console, args);
};

export function startTestHarness(): void {
  if (intervalId) return;

  intervalId = setInterval(() => {
    // Write state
    const state = captureState(lastResult);
    invoke("write_test_state", {
      json: JSON.stringify({ __test_state__: state }, null, 2),
    }).catch(() => {});

    // Poll for commands
    pollCommands();
  }, 2000);

  // Write immediately
  const state = captureState();
  invoke("write_test_state", {
    json: JSON.stringify({ __test_state__: state }, null, 2),
  }).catch(() => {});
}

export function stopTestHarness(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
