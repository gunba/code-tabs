import type { CliKind, PastSession, SessionConfig } from "../types/session";

export function resumeSessionCli(
  session: Pick<PastSession, "cli">,
  config?: Pick<Partial<SessionConfig>, "cli"> | null,
): CliKind {
  return session.cli ?? config?.cli ?? "claude";
}

export function cliShortLabel(cli: CliKind): string {
  return cli === "codex" ? "Codex" : "Claude";
}

export function cliLongLabel(cli: CliKind): string {
  return cli === "codex" ? "Codex CLI" : "Claude Code";
}
