import { useCallback, useReducer } from "react";
import type { CliKind, SessionConfig } from "../../types/session";
import {
  buildInitialLauncherConfig,
  buildWorkspaceLauncherConfig,
} from "../../lib/sessionLauncherConfig";

type AdapterOption = { value: string };

interface UseSessionConfigParams {
  lastConfig: SessionConfig;
  savedDefaults: SessionConfig | null;
  workspaceDefaults: Record<string, Partial<SessionConfig>>;
}

type SessionConfigAction =
  | {
    type: "set";
    key: keyof SessionConfig;
    value: SessionConfig[keyof SessionConfig];
  }
  | { type: "switchCli"; cli: CliKind; model: string | null; effort: string | null }
  | {
    type: "switchWorkspace";
    workingDir: string;
    lastConfig: SessionConfig;
    savedDefaults: SessionConfig | null;
    workspaceDefaults: Record<string, Partial<SessionConfig>>;
  }
  | {
    type: "validateAdapterOption";
    key: "model" | "effort";
    options: AdapterOption[];
  };

function sessionConfigReducer(
  state: SessionConfig,
  action: SessionConfigAction,
): SessionConfig {
  switch (action.type) {
    case "set":
      return { ...state, [action.key]: action.value };
    case "switchCli":
      return { ...state, cli: action.cli, model: action.model, effort: action.effort };
    case "switchWorkspace":
      return buildWorkspaceLauncherConfig(action);
    case "validateAdapterOption": {
      const value = state[action.key];
      if (!value || action.options.length === 0) return state;
      if (action.options.some((option) => option.value === value)) return state;
      return { ...state, [action.key]: null };
    }
  }
}

export function useSessionConfig(params: UseSessionConfigParams) {
  const [config, dispatch] = useReducer(
    sessionConfigReducer,
    params,
    buildInitialLauncherConfig,
  );

  const updateConfig = useCallback(
    <K extends keyof SessionConfig>(key: K, value: SessionConfig[K]) => {
      dispatch({ type: "set", key, value });
    },
    [],
  );

  const switchCli = useCallback((cli: CliKind, model: string | null, effort: string | null) => {
    dispatch({ type: "switchCli", cli, model, effort });
  }, []);

  const switchWorkspace = useCallback((workingDir: string) => {
    dispatch({
      type: "switchWorkspace",
      workingDir,
      lastConfig: params.lastConfig,
      savedDefaults: params.savedDefaults,
      workspaceDefaults: params.workspaceDefaults,
    });
  }, [params.lastConfig, params.savedDefaults, params.workspaceDefaults]);

  const validateAdapterOption = useCallback((
    key: "model" | "effort",
    options: AdapterOption[],
  ) => {
    dispatch({ type: "validateAdapterOption", key, options });
  }, []);

  return {
    config,
    switchCli,
    switchWorkspace,
    updateConfig,
    validateAdapterOption,
  };
}
