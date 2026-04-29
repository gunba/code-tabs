import { describe, expect, it } from "vitest";
import { apiHostForFetch } from "../apiEndpoint";

describe("apiHostForFetch", () => {
  it("uses external hosts directly", () => {
    expect(apiHostForFetch("https://api.anthropic.com/v1/messages", "claude")).toBe("api.anthropic.com");
    expect(apiHostForFetch("https://api.openai.com/v1/responses", "codex")).toBe("api.openai.com");
  });

  it("maps local Claude proxy requests to Anthropic", () => {
    expect(apiHostForFetch("http://127.0.0.1:4567/v1/messages", "claude")).toBe("api.anthropic.com");
    expect(apiHostForFetch("http://localhost:4567/v1/complete", "claude")).toBe("api.anthropic.com");
    expect(apiHostForFetch("http://127.0.0.1:4567/s/session-1/v1/messages", "claude")).toBe("api.anthropic.com");
  });

  it("maps local Codex proxy requests to their upstreams", () => {
    expect(apiHostForFetch("http://127.0.0.1:4567/v1/responses", "codex")).toBe("api.openai.com");
    expect(apiHostForFetch("http://127.0.0.1:4567/backend-api/codex/responses", "codex")).toBe("chatgpt.com");
    expect(apiHostForFetch("http://127.0.0.1:4567/s/session-1/v1/responses", "codex")).toBe("api.openai.com");
    expect(apiHostForFetch("http://127.0.0.1:4567/s/session-1/backend-api/codex/responses", "codex")).toBe("chatgpt.com");
  });

  it("returns null for unparsable or unknown local endpoints", () => {
    expect(apiHostForFetch("not a url", "claude")).toBeNull();
    expect(apiHostForFetch("http://127.0.0.1:4567/health", "claude")).toBeNull();
  });
});
