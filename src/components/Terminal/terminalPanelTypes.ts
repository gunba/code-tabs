import type { useInspectorConnection } from "../../hooks/useInspectorConnection";
import type { usePty } from "../../hooks/usePty";
import type { useTerminal } from "../../hooks/useTerminal";

export type InspectorController = ReturnType<typeof useInspectorConnection>;
export type PtyController = ReturnType<typeof usePty>;
export type TerminalController = ReturnType<typeof useTerminal>;
