import { describe, it, expect } from "vitest";
import { buildFileTree, flattenTree, allFolderPaths } from "../fileTree";
import type { FileActivity } from "../../types/activity";

function makeActivity(path: string, kind: "read" | "modified" = "read"): FileActivity {
  return {
    path,
    kind,
    agentId: null,
    toolName: "Read",
    timestamp: Date.now(),
    confirmed: true,
    isExternal: false,
    permissionDenied: false,
    permissionMode: null,
    toolInputData: null,
  };
}

function toMap(entries: FileActivity[]): Map<string, FileActivity> {
  return new Map(entries.map((e) => [e.path, e]));
}

describe("buildFileTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildFileTree(new Map())).toEqual([]);
  });

  it("builds tree for a single file", () => {
    const files = toMap([makeActivity("/home/user/project/src/app.ts")]);
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("home");
    expect(tree[0].isFile).toBe(false);

    // Walk down to the file
    let node = tree[0];
    const names = ["home", "user", "project", "src"];
    for (const name of names) {
      expect(node.name).toBe(name);
      expect(node.isFile).toBe(false);
      expect(node.children.length).toBeGreaterThanOrEqual(1);
      node = node.children[0];
    }
    expect(node.name).toBe("app.ts");
    expect(node.isFile).toBe(true);
    expect(node.activity).not.toBeNull();
  });

  it("shares common prefix for files in the same directory", () => {
    const files = toMap([
      makeActivity("/project/src/a.ts"),
      makeActivity("/project/src/b.ts"),
    ]);
    const tree = buildFileTree(files);

    // Root: project
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("project");

    // project/src has 2 children
    const src = tree[0].children[0];
    expect(src.name).toBe("src");
    expect(src.children).toHaveLength(2);

    // Sorted alphabetically
    expect(src.children[0].name).toBe("a.ts");
    expect(src.children[1].name).toBe("b.ts");
  });

  it("creates disjoint roots for unrelated paths", () => {
    const files = toMap([
      makeActivity("/home/project/a.ts"),
      makeActivity("/tmp/other/b.ts"),
    ]);
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(2);
    const rootNames = tree.map((n) => n.name).sort();
    expect(rootNames).toEqual(["home", "tmp"]);
  });

  it("handles Windows paths with backslashes", () => {
    const files = toMap([
      makeActivity("C:\\Users\\jorda\\project\\src\\app.ts"),
    ]);
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("C:");

    // The leaf should preserve the original path for shell_open
    let node = tree[0];
    while (node.children.length > 0) {
      node = node.children[0];
    }
    expect(node.name).toBe("app.ts");
    expect(node.isFile).toBe(true);
    expect(node.fullPath).toBe("C:\\Users\\jorda\\project\\src\\app.ts");
  });

  it("sorts folders before files", () => {
    const files = toMap([
      makeActivity("/root/file.ts"),
      makeActivity("/root/subdir/other.ts"),
    ]);
    const tree = buildFileTree(files);
    const rootNode = tree[0]; // "root"
    expect(rootNode.children).toHaveLength(2);
    // subdir (folder) should come before file.ts (file)
    expect(rootNode.children[0].name).toBe("subdir");
    expect(rootNode.children[0].isFile).toBe(false);
    expect(rootNode.children[1].name).toBe("file.ts");
    expect(rootNode.children[1].isFile).toBe(true);
  });

  it("handles files at different depths", () => {
    const files = toMap([
      makeActivity("/a/b/c/deep.ts"),
      makeActivity("/a/shallow.ts"),
    ]);
    const tree = buildFileTree(files);
    const a = tree[0];
    expect(a.name).toBe("a");
    expect(a.children).toHaveLength(2);
    // "b" folder before "shallow.ts" file
    expect(a.children[0].name).toBe("b");
    expect(a.children[0].isFile).toBe(false);
    expect(a.children[1].name).toBe("shallow.ts");
    expect(a.children[1].isFile).toBe(true);
  });
});

describe("flattenTree", () => {
  it("flattens all nodes when all folders expanded", () => {
    const files = toMap([
      makeActivity("/a/b/c.ts"),
      makeActivity("/a/d.ts"),
    ]);
    const tree = buildFileTree(files);
    const expanded = allFolderPaths(tree);
    const rows = flattenTree(tree, expanded);

    // a, b, c.ts, d.ts
    expect(rows).toHaveLength(4);
    expect(rows[0].node.name).toBe("a");
    expect(rows[0].depth).toBe(0);
    expect(rows[1].node.name).toBe("b");
    expect(rows[1].depth).toBe(1);
    expect(rows[2].node.name).toBe("c.ts");
    expect(rows[2].depth).toBe(2);
    expect(rows[3].node.name).toBe("d.ts");
    expect(rows[3].depth).toBe(1);
  });

  it("hides children of collapsed folders", () => {
    const files = toMap([
      makeActivity("/a/b/c.ts"),
      makeActivity("/a/d.ts"),
    ]);
    const tree = buildFileTree(files);
    // Only expand "a", not "a/b"
    const expanded = new Set(["a"]);
    const rows = flattenTree(tree, expanded);

    // a, b (collapsed), d.ts — c.ts hidden because b is collapsed
    expect(rows).toHaveLength(3);
    expect(rows[0].node.name).toBe("a");
    expect(rows[1].node.name).toBe("b");
    expect(rows[2].node.name).toBe("d.ts");
  });
});

describe("allFolderPaths", () => {
  it("collects all non-file paths", () => {
    const files = toMap([
      makeActivity("/x/y/z.ts"),
      makeActivity("/x/w.ts"),
    ]);
    const tree = buildFileTree(files);
    const paths = allFolderPaths(tree);

    expect(paths.has("x")).toBe(true);
    expect(paths.has("x/y")).toBe(true);
    expect(paths.size).toBe(2);
  });
});
