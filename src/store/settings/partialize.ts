import type { SettingsState } from "./types";

export function partializeSettings(state: SettingsState) {
  return {
    recentDirs: state.recentDirs,
    presets: state.presets,
    lastConfig: state.lastConfig,
    savedDefaults: state.savedDefaults,
    workspaceDefaults: state.workspaceDefaults,
    workspaceNotes: state.workspaceNotes,
    themeName: state.themeName,
    notificationsEnabled: state.notificationsEnabled,
    codexAutoRenameLLMEnabled: state.codexAutoRenameLLMEnabled,
    codexAutoRenameLLMModel: state.codexAutoRenameLLMModel,
    cliVersions: state.cliVersions,
    lastOpenedCliVersions: state.lastOpenedCliVersions,
    previousCliVersions: state.previousCliVersions,
    cliCapabilitiesByCli: state.cliCapabilitiesByCli,
    binarySettingsFieldsByCli: state.binarySettingsFieldsByCli,
    knownEnvVarsByCli: state.knownEnvVarsByCli,
    slashCommandsByCli: state.slashCommandsByCli,
    commandUsage: state.commandUsage,
    commandBarExpanded: state.commandBarExpanded,
    sessionNames: state.sessionNames,
    sessionConfigs: state.sessionConfigs,
    observedPrompts: state.observedPrompts,
    savedPrompts: state.savedPrompts,
    systemPromptRules: state.systemPromptRules,
    modelRegistry: state.modelRegistry,
    recordingConfig: state.recordingConfig,
    recordingConfigsByCli: state.recordingConfigsByCli,
  };
}
