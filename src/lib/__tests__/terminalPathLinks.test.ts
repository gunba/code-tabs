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

  it("matches paths followed by ': description' prose (Codex output)", () => {
    // Real Codex output: `  - src/App.tsx: main React app wiring Zustand stores...`
    // The trailing `:` followed by non-digit text used to break detection because
    // the negative lookahead rejected matches before a colon.
    const matches = findPathLinkCandidates(
      "  - src/App.tsx: main React app wiring Zustand stores",
    );
    expect(matches.map((m) => m.raw)).toEqual(["src/App.tsx"]);

    expect(findPathLinkCandidates("src/App.tsx,")[0]?.raw).toBe("src/App.tsx");
    expect(findPathLinkCandidates("src/App.tsx:")[0]?.raw).toBe("src/App.tsx");
    expect(
      findPathLinkCandidates("src/App.tsx: see also x.ts").map((m) => m.raw),
    ).toEqual(["src/App.tsx", "x.ts"]);
  });

  it("preserves :line[:col] suffix only for numeric segments", () => {
    expect(findPathLinkCandidates("the file src/foo.ts:42")[0]?.raw).toBe("src/foo.ts:42");
    expect(findPathLinkCandidates("the file src/foo.ts:42:5")[0]?.raw).toBe("src/foo.ts:42:5");
    expect(findPathLinkCandidates("src/foo.ts:abc")[0]?.raw).toBe("src/foo.ts");
  });

  it("supports paths with single-space-separated segments when anchored or rooted", () => {
    expect(findPathLinkCandidates("~/My Documents/config.json")[0]?.raw).toBe(
      "~/My Documents/config.json",
    );
    expect(findPathLinkCandidates("./My Folder/file.tsx")[0]?.raw).toBe(
      "./My Folder/file.tsx",
    );
    expect(findPathLinkCandidates("/home/me/My Folder/file.tsx")[0]?.raw).toBe(
      "/home/me/My Folder/file.tsx",
    );
    expect(
      findPathLinkCandidates("C:\\Users\\Me\\My Folder\\file.tsx")[0]?.raw,
    ).toBe("C:\\Users\\Me\\My Folder\\file.tsx");
    expect(findPathLinkCandidates("src/My Folder/file.tsx")[0]?.raw).toBe(
      "src/My Folder/file.tsx",
    );
    // Trailing prose stays outside the match even though spaces are allowed mid-path.
    const matches = findPathLinkCandidates("edit ~/My Documents/config.json today");
    expect(matches[0]?.raw).toBe("~/My Documents/config.json");
  });

  it("supports multi-word segments and parens in anchored paths", () => {
    expect(
      findPathLinkCandidates("C:\\Program Files (x86)\\app.exe")[0]?.raw,
    ).toBe("C:\\Program Files (x86)\\app.exe");
    expect(
      findPathLinkCandidates("~/My Cool Folder/file.tsx")[0]?.raw,
    ).toBe("~/My Cool Folder/file.tsx");
    expect(
      findPathLinkCandidates("/home/user/Project (alpha)/main.rs")[0]?.raw,
    ).toBe("/home/user/Project (alpha)/main.rs");
    expect(
      findPathLinkCandidates("./My Multi Word Folder/index.ts")[0]?.raw,
    ).toBe("./My Multi Word Folder/index.ts");
  });

  it("does not bridge into trailing prose after the final filename", () => {
    expect(
      findPathLinkCandidates("edit C:\\Program Files (x86)\\app.exe today")[0]?.raw,
    ).toBe("C:\\Program Files (x86)\\app.exe");
    expect(
      findPathLinkCandidates("see /home/me/My Folder/file.tsx now")[0]?.raw,
    ).toBe("/home/me/My Folder/file.tsx");
  });

  it("does not match bare prose with spaces around a slash", () => {
    expect(findPathLinkCandidates("let me see what")).toEqual([]);
    expect(findPathLinkCandidates("ratio 100/200/300 is not")).toEqual([]);
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
