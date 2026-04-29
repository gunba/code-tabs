// Compatibility facade. Prefer importing focused helpers from the split modules
// in new code; existing callers can keep using ./claude during the transition.
export { dirToTabName } from "./paths";

export {
  buildClaudeArgs,
  canResumeSession,
  effectiveModel,
  findNearestLiveTab,
  getEffectiveState,
  getLaunchWorkingDir,
  getResumeId,
  resolveResumeId,
  stripWorktreeFlags,
} from "./claudeResume";

export {
  MODEL_FAMILIES,
  effortColor,
  modelColor,
  modelLabel,
  resolveModelFamily,
  resolveModelId,
} from "./modelRegistry";
export type { ModelRegistryEntry } from "./modelRegistry";

export {
  EVENT_KIND_COLORS,
  SESSION_COLORS,
  TOOL_COLORS,
  assignSessionColor,
  eventKindColor,
  getActivityColor,
  getActivityText,
  releaseSessionColor,
  sessionColor,
  toolCategoryColor,
} from "./tabColors";

export {
  computeHeatLevel,
  formatTokenCount,
  heatClassName,
} from "./heat";
export type { HeatLevel } from "./heat";
