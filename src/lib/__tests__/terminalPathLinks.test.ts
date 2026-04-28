import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { createPathLinkProvider, findPathLinkCandidates } from "../terminalPathLinks";

function mockTerminalLine(text: string) {
  return {
    buffer: {
      active: {
        getLine: (index: number) =>
          index === 0
            ? { translateToString: () => text }
            : null,
      },
    },
  } as unknown as import("@xterm/xterm").Terminal;
}

async function provideLinks(text: string) {
  const { provider } = createPathLinkProvider({
    term: mockTerminalLine(text),
    getCwd: () => "/repo",
  });
  return await new Promise((resolve) => provider.provideLinks(1, resolve));
}

describe("findPathLinkCandidates", () => {
  it("finds anchored, relative, Windows, and bare file paths", () => {
    expect(findPathLinkCandidates("./src/App.tsx:42:10)")[0]?.raw).toBe("./src/App.tsx:42:10");
    expect(findPathLinkCandidates("C:\\Users\\me\\file.txt")[0]?.raw).toBe("C:\\Users\\me\\file.txt");
    expect(findPathLinkCandidates("open package.json")[0]?.raw).toBe("package.json");
    expect(findPathLinkCandidates("see src/components/Tab.tsx")[0]?.raw).toBe("src/components/Tab.tsx");
  });

  it("trims leading and trailing prose punctuation", () => {
    expect(findPathLinkCandidates("(./foo/bar.tsx),")[0]?.raw).toBe("./foo/bar.tsx");
    expect(findPathLinkCandidates("\"src/lib/theme.ts\"")[0]?.raw).toBe("src/lib/theme.ts");
  });

  it("rejects common prose and URL false positives", () => {
    expect(findPathLinkCandidates("for example, e.g., this i.e., thing")).toEqual([]);
    expect(findPathLinkCandidates("version 1.2.3 is newer")).toEqual([]);
    expect(findPathLinkCandidates("ratio 100/200/300 is not a path")).toEqual([]);
    expect(findPathLinkCandidates("https://example.com/file.json")).toEqual([]);
  });
});

describe("createPathLinkProvider", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("deduplicates candidates within a single terminal line", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { candidate: "src/App.tsx", absPath: "/repo/src/App.tsx", isDir: false },
    ]);

    const links = await provideLinks("src/App.tsx and src/App.tsx");

    expect(invoke).toHaveBeenCalledWith("resolve_paths", {
      cwd: "/repo",
      candidates: ["src/App.tsx"],
    });
    expect(links as unknown[]).toHaveLength(2);
  });

  it("does not cache path resolution across provider calls", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { candidate: "src/App.tsx", absPath: "/repo/src/App.tsx", isDir: false },
    ]);

    await provideLinks("src/App.tsx");
    await provideLinks("src/App.tsx");

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
