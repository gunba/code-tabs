import type { CliKind } from "../types/session";

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function stripSessionPrefix(pathname: string): string {
  const parts = pathname.split("/");
  if (parts[1] === "s" && parts[2]) {
    return "/" + parts.slice(3).join("/");
  }
  return pathname;
}

export function apiHostForFetch(url: string, cli: CliKind): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;
  if (!hostname) return null;
  if (!isLocalHost(hostname)) return hostname;
  const upstreamPath = stripSessionPrefix(parsed.pathname);

  if (cli === "codex") {
    if (upstreamPath.startsWith("/backend-api/codex")) return "chatgpt.com";
    if (upstreamPath.startsWith("/v1/")) return "api.openai.com";
  }

  if (upstreamPath.startsWith("/v1/messages") || upstreamPath.startsWith("/v1/complete")) {
    return "api.anthropic.com";
  }

  return null;
}
